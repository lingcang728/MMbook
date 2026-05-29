# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install                  # Install frontend dependencies
npm run tauri dev            # Start dev server (Vite + Tauri) — the primary dev command
npm run tauri build          # Production build (compiles Rust + bundles frontend)
npm run ship:local           # Build, install latest NSIS package, refresh shortcuts and Markdown file associations
npm run install:latest       # Install the newest existing NSIS package and refresh shortcuts/file associations
npm run check                # TypeScript/Svelte type checking
npm run dev                  # Frontend-only dev server (no Tauri shell)
```

Rust backend is in `src-tauri/`. To work with it directly: `cd src-tauri && cargo build` / `cargo check`.

No test framework is configured. No linter is configured.

## Agent Completion Reminder

When an agent changes app code and the user expects the desktop shortcut or double-clicking `.md` / `.markdown` files to use the new build, do not stop after `npm run tauri build`.

Required close-out steps:

1. Run `npm run check`.
2. Run `npm run ship:local`.
3. Verify the installed executable timestamp/hash, not just the version number. The same `0.1.2` version can exist as multiple different builds.
4. Verify `.md` and `.markdown` open commands point to the installed app:
   ```powershell
   (Get-Item 'HKCU:\Software\Classes\md\shell\open\command').GetValue('')
   (Get-Item 'HKCU:\Software\Classes\markdown\shell\open\command').GetValue('')
   ```
5. If practical, test a real Markdown launch with `Start-Process .\test.md` and confirm the process path is `C:\Users\15pro\AppData\Local\MMbook\mmbook.exe`.

If the agent only runs `npm run tauri build`, the installer may be new while Windows still launches an older installed build.

## Agent Git Commit Policy

For every task that changes code or repository-tracked behavior, the agent must leave a git commit behind unless the user explicitly asks not to commit.

Required commit workflow:

1. Inspect `git status --short` and the relevant diff before staging.
2. Run the appropriate verification commands for the change. For app code changes, use the checks in "Agent Completion Reminder" first.
3. Stage all intended changes from the completed task, including new helper scripts or documentation updates.
4. Create a concise git commit without asking the user to do it manually.
5. Report the commit hash and any verification that was run.

If the agent updates repository behavior, local tooling, build/install scripts, or these instructions, include that update in the same automatic commit when it belongs to the same task. This keeps each agent change easy to review and easy to roll back.

## Architecture

**Single-page Tauri v2 desktop app** — Rust backend + SvelteKit frontend (SSR disabled, adapter-static in SPA mode).

### Frontend (Svelte 5 + TypeScript)

- **`src/routes/+page.svelte`** — The entire UI lives in this single ~650-line component. All features (rendering, search, TOC, focus mode, settings, inline editing, drag-drop, keyboard shortcuts) are here. There are no child components.
- **`src/lib/render/markdown.ts`** — Markdown pipeline: unified → remark-parse → remark-gfm → remark-rehype → rehype-stringify, then post-processes HTML to replace code blocks with Shiki-highlighted output. Also handles TOC extraction and heading ID generation.
- **`src/lib/theme/themes.ts`** — 6 themes (3 pairs × light/dark: 素纸, 墨石, 暮光). Theming is pure CSS custom properties applied to `document.documentElement`. Each theme also carries a `shikiTheme` for code highlighting.
- **`src/lib/stores/app.ts`** — Svelte writable stores for global state (file path, content, theme, focus mode, search, TOC, settings). Theme persists to localStorage.

### Backend (Rust)

- **`src-tauri/src/lib.rs`** — Four Tauri commands:
  - `read_markdown_file` / `save_markdown_file` — File I/O with multi-encoding support (UTF-8, UTF-16 LE/BE, GB18030)
  - `load_reading_state` / `save_reading_state` — Per-file scroll position persistence using hashed JSON files in `AppData/mmbook/`
- File association: `.md`, `.markdown` — handled via CLI args in `setup()` hook, sets `window.__INITIAL_FILE__`.
- Tauri plugins: `opener`, `dialog`, `fs`.

### Data Flow

Frontend calls Rust via `invoke('read_markdown_file', {path})` → gets raw markdown string → processes through unified pipeline + Shiki → renders HTML into `contentEl` via `{@html}` → heading IDs are injected for TOC/search anchoring.

## Key Conventions

- **Language**: UI text and theme names are in Chinese. Code, comments, and variable names are in English.
- **No component decomposition**: The entire UI is a single Svelte file by design. This is intentional — do not refactor into sub-components unless explicitly asked.
- **CSS custom properties for theming**: Never use hardcoded colors. Always reference `var(--property-name)` from the theme system.
- **Focus mode**: Uses `article.children` (direct children only) for block detection — do not use deep DOM traversal, as it breaks with nested structures like `ul>li`, `blockquote>p`.
