use encoding_rs::{GB18030, UTF_16BE, UTF_16LE};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use tauri::Manager;

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

#[tauri::command]
fn read_markdown_file(path: String) -> Result<ReadResult, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let (content, encoding) = decode_markdown_bytes(&bytes)?;
    Ok(ReadResult { content, encoding })
}

#[tauri::command]
fn save_markdown_file(path: String, content: String, encoding: String) -> Result<(), String> {
    let bytes = encode_markdown(&content, &encoding)?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
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
    fs::write(&sp, data).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_markdown_file,
            save_markdown_file,
            load_reading_state,
            save_reading_state,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let args: Vec<String> = std::env::args().collect();
            if args.len() > 1 {
                let file_path = args[1].clone();
                if file_path.ends_with(".md") || file_path.ends_with(".markdown") {
                    let _ = window.eval(&format!(
                        "window.__INITIAL_FILE__ = {};",
                        serde_json::to_string(&file_path).unwrap()
                    ));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
