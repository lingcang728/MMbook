# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install                  # Install frontend dependencies
npm run tauri dev            # Start dev server (Vite + Tauri) — the primary dev command
npm run tauri build          # Production build (compiles Rust + bundles frontend)
npm run check                # TypeScript/Svelte type checking
npm run dev                  # Frontend-only dev server (no Tauri shell)
```

Rust backend is in `src-tauri/`. To work with it directly: `cd src-tauri && cargo build` / `cargo check`.

No test framework is configured. No linter is configured.

## Architecture

**Single-page Tauri v2 desktop app** — Rust backend + SvelteKit frontend (SSR disabled, adapter-static in SPA mode).

### Frontend (Svelte 5 + TypeScript)

- **`src/routes/+page.svelte`** — The main page component (~2,800 lines). Hosts the core reading experience: file open/load/save flow, focus mode, inline editing, drag-drop, keyboard shortcuts, recent-files list, and external-change auto-reload (2s mtime polling via `get_file_mtime`).
- **`src/lib/components/`** — Extracted UI overlays, each self-contained with its own scoped styles:
  - `SearchBar.svelte` — Spotlight-style search bar. Owns its input focus; the page passes match state and `onInput`/`onNavigate`/`onClose` callbacks (the search/highlight logic itself stays in the page since it manipulates the article DOM).
  - `TocPanel.svelte` — TOC overlay. Props: `items`, `onJump`.
  - `SettingsPanel.svelte` — Theme picker. Purely store-driven (`settingsOpen`, `currentTheme`), no props.
- **`src/lib/render/markdown.ts`** — Markdown pipeline: unified → remark-parse → remark-gfm → remark-rehype → rehype-stringify, then post-processes HTML to replace code blocks with Shiki-highlighted output. Also handles TOC extraction and heading ID generation.
- **`src/lib/theme/themes.ts`** — 6 themes (3 pairs × light/dark: 素纸, 墨石, 暮光). Theming is pure CSS custom properties applied to `document.documentElement`. Each theme also carries a `shikiTheme` for code highlighting.
- **`src/lib/stores/app.ts`** — Svelte writable stores for global state (file path, content, theme, focus mode, search, TOC, settings). Theme persists to localStorage.

### Backend (Rust)

- **`src-tauri/src/lib.rs`** — Tauri commands:
  - `read_markdown_file` / `save_markdown_file` — File I/O with multi-encoding support (UTF-8, UTF-16 LE/BE, GB18030)
  - `load_reading_state` / `save_reading_state` — Per-file scroll position persistence using hashed JSON files in `AppData/mmbook/`
  - `get_file_mtime` — File mtime in ms; polled by the frontend for external-change auto-reload
- File association: `.md`, `.markdown` — handled via CLI args in `setup()` hook, sets `window.__INITIAL_FILE__`.
- Tauri plugins: `opener`, `dialog`, `fs`.

### Data Flow

Frontend calls Rust via `invoke('read_markdown_file', {path})` → gets raw markdown string → processes through unified pipeline + Shiki → renders HTML into `contentEl` via `{@html}` → heading IDs are injected for TOC/search anchoring.

## Key Conventions

- **Language**: UI text and theme names are in Chinese. Code, comments, and variable names are in English.
- **Component decomposition policy**: Self-contained overlays (search/TOC/settings) live in `src/lib/components/`. The reading core (rendering, focus mode, inline editing) stays in `+page.svelte` because its pieces share heavy DOM/state coupling — split further only when a piece has a small, callback-shaped interface.
- **CSS custom properties for theming**: Never use hardcoded colors. Always reference `var(--property-name)` from the theme system.
- **Focus mode**: Uses `article.children` (direct children only) for block detection — do not use deep DOM traversal, as it breaks with nested structures like `ul>li`, `blockquote>p`.
