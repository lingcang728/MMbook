use encoding_rs::{GB18030, UTF_16BE, UTF_16LE};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use tauri::Manager;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::{Emitter, RunEvent};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ReadingState {
    pub scroll_position: f64,
    pub bookmarks: Vec<usize>,
}

#[derive(Serialize)]
struct ReadResult {
    content: String,
    encoding: String,
}

fn state_dir() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("mmbook");
    fs::create_dir_all(&dir).ok();
    dir
}

fn state_path_for(file_path: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    let hash = hasher.finish();
    state_dir().join(format!("{:x}.json", hash))
}

fn decode_markdown_bytes(bytes: &[u8]) -> Result<(String, String), String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let content = String::from_utf8(bytes[3..].to_vec()).map_err(|e| e.to_string())?;
        return Ok((content, "utf-8-bom".to_string()));
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, had_errors) = UTF_16LE.decode(&bytes[2..]);
        if had_errors {
            return Err("Failed to decode UTF-16 LE markdown file".to_string());
        }
        return Ok((text.into_owned(), "utf-16le".to_string()));
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, had_errors) = UTF_16BE.decode(&bytes[2..]);
        if had_errors {
            return Err("Failed to decode UTF-16 BE markdown file".to_string());
        }
        return Ok((text.into_owned(), "utf-16be".to_string()));
    }

    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return Ok((text, "utf-8".to_string()));
    }

    let (text, _, _) = GB18030.decode(bytes);
    Ok((text.into_owned(), "gb18030".to_string()))
}

fn encode_markdown(content: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "utf-8-bom" => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(content.as_bytes());
            Ok(bytes)
        }
        "utf-16le" => {
            let mut bytes = vec![0xFF, 0xFE];
            for code_unit in content.encode_utf16() {
                bytes.extend_from_slice(&code_unit.to_le_bytes());
            }
            Ok(bytes)
        }
        "utf-16be" => {
            let mut bytes = vec![0xFE, 0xFF];
            for code_unit in content.encode_utf16() {
                bytes.extend_from_slice(&code_unit.to_be_bytes());
            }
            Ok(bytes)
        }
        "gb18030" => {
            let (encoded, _, had_errors) = GB18030.encode(content);
            if had_errors {
                return Err("Failed to encode as GB18030".to_string());
            }
            Ok(encoded.into_owned())
        }
        _ => Ok(content.as_bytes().to_vec()),
    }
}

fn is_markdown_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

#[tauri::command]
fn read_markdown_file(path: String) -> Result<ReadResult, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let (content, encoding) = decode_markdown_bytes(&bytes)?;
    Ok(ReadResult { content, encoding })
}

#[cfg(target_os = "windows")]
extern "system" {
    fn MoveFileExW(lpExistingFileName: *const u16, lpNewFileName: *const u16, dwFlags: u32) -> i32;
}

#[cfg(target_os = "windows")]
fn wide_path(path: &std::path::Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn atomic_write_file(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let temp_path = path.with_extension(format!("tmp.{}", std::process::id()));
    if fs::write(&temp_path, data).is_ok() {
        #[cfg(target_os = "windows")]
        {
            const MOVEFILE_REPLACE_EXISTING: u32 = 1;
            let from = wide_path(&temp_path);
            let to = wide_path(path);
            let ok = unsafe {
                MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) != 0
            };
            if ok {
                return Ok(());
            }
            let _ = fs::remove_file(&temp_path);
        }
        #[cfg(not(target_os = "windows"))]
        {
            if fs::rename(&temp_path, path).is_ok() {
                return Ok(());
            }
            let _ = fs::remove_file(&temp_path);
        }
    } else {
        let _ = fs::remove_file(&temp_path);
    }
    // Atomic replace unavailable (destination locked, cross-volume, etc.) — write directly.
    fs::write(path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_markdown_file(path: String, content: String, encoding: String) -> Result<(), String> {
    let bytes = encode_markdown(&content, &encoding)?;
    atomic_write_file(std::path::Path::new(&path), &bytes)
}

#[tauri::command]
fn load_reading_state(path: String) -> Result<ReadingState, String> {
    let sp = state_path_for(&path);
    if sp.exists() {
        let data = fs::read_to_string(&sp).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).map_err(|e| e.to_string())
    } else {
        Ok(ReadingState::default())
    }
}

#[tauri::command]
fn save_reading_state(path: String, state: ReadingState) -> Result<(), String> {
    let sp = state_path_for(&path);
    let data = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    atomic_write_file(&sp, data.as_bytes())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            read_markdown_file,
            save_markdown_file,
            load_reading_state,
            save_reading_state,
            quit_app,
        ])
        .setup(|app| {
            // Windows: file path passed as CLI argument
            let window = app.get_webview_window("main").unwrap();
            let args: Vec<String> = std::env::args().collect();
            if args.len() > 1 {
                let file_path = args[1].clone();
                if is_markdown_path(&file_path) {
                    let _ = window.eval(&format!(
                        "window.__INITIAL_FILE__ = {};",
                        serde_json::to_string(&file_path).unwrap()
                    ));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // macOS: file opened via Apple Event (double-click / Open With)
    app.run(|_app_handle, event| {
        match event {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            RunEvent::Opened { urls } => {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        let path_str = path.to_string_lossy().to_string();
                        if is_markdown_path(&path_str) {
                            let _ = _app_handle.emit("open-file", path_str);
                        }
                    }
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::is_markdown_path;

    #[test]
    fn markdown_extension_check_is_case_insensitive() {
        assert!(is_markdown_path("C:\\docs\\README.MD"));
        assert!(is_markdown_path("/tmp/notes.MarkDown"));
    }

    #[test]
    fn non_markdown_extensions_are_rejected() {
        assert!(!is_markdown_path("C:\\docs\\README.txt"));
        assert!(!is_markdown_path("/tmp/readme.md.bak"));
    }
}
