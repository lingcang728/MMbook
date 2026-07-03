# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install                  # Install frontend dependencies
npm run tauri dev            # Start dev server (Vite + Tauri) — the primary dev command
npm run tauri build          # Production build (compiles Rust + bundles frontend)
npm run tauri build -- --no-bundle  # Rebuild just the exe (faster; deploy = copy to %LOCALAPPDATA%\MMbook)
npm run check                # TypeScript/Svelte type checking
npm run test                 # Vitest unit tests (src/lib/**/*.test.ts)
npm run dev                  # Frontend-only dev server (no Tauri shell)
```

Rust backend is in `src-tauri/`. To work with it directly: `cd src-tauri && cargo build` / `cargo check`.

Vitest is configured for pure-logic modules (`src/lib/**`). No linter is configured.

## Architecture

**Single-page Tauri v2 desktop app** — Rust backend + SvelteKit frontend (SSR disabled, adapter-static in SPA mode).

### Frontend (Svelte 5 + TypeScript)

- **`src/routes/+page.svelte`** — The main page component. Hosts the core reading experience: file open/load/save flow, focus mode (unit collection, styling window, spotlight), unified source-block editing, drag-drop, keyboard shortcuts, font zoom, bottom status line, lightbox, footnote previews, code-copy button, recent files/continue-reading, and external-change auto-reload (mtime polling, de-frequenced when unfocused).
- **`src/lib/components/`** — Extracted UI overlays, each self-contained with its own scoped styles:
  - `SearchBar.svelte` — Spotlight-style search bar. Owns its input focus; the page passes match state and callbacks (search/highlight logic stays in the page since it manipulates the article DOM).
  - `TocPanel.svelte` — Centered command-palette TOC: type-to-filter headings, ↑↓ + Enter navigation, current-section highlight. Props: `items`, `activeId`, `onJump`.
  - `SettingsPanel.svelte` — Theme picker + typography controls (font scale / line height / column width / sans-serif vs serif). Store-driven.
- **`src/lib/render/markdown.ts`** — Markdown pipeline: unified → remark-parse → remark-gfm → (remark-math, lazy) → remark-rehype → rehype-raw → rehype-sanitize → (rehype-katex, lazy) → rehype-stringify, then Shiki-highlights code blocks. Also: TOC extraction, heading IDs, YAML front matter (stripped from render, parsed into `frontMatter` entries for the metadata card). Sanitize uses `clobberPrefix: ''` so GFM footnote hrefs match their ids.
- **`src/lib/render/markdown.worker.ts`** — Rendering runs in a Web Worker; the page falls back to main-thread rendering if the worker fails.
- **`src/lib/focus/scroll.ts`** — Pure scroll-target math for focus mode (unit-tested).
- **`src/lib/focus/segment.ts`** — Sentence splitting (Intl.Segmenter + regex fallback) for sentence-level focus in long paragraphs (unit-tested).
- **`src/lib/edit/sourceBlock.ts`** — Exact line-range extraction/replacement of Markdown source blocks (unit-tested).
- **`src/lib/theme/themes.ts`** — 6 themes (3 pairs × light/dark: 素纸, 墨石, 暮光). Pure CSS custom properties. Each theme carries a `shikiTheme`.
- **`src/lib/stores/app.ts`** — Svelte stores for global state, plus persisted typography stores (`fontScale`, `readingLineHeight`, `readingWidth`, `readingFontFamily`) that apply CSS variables on `documentElement`.

### Backend (Rust)

- **`src-tauri/src/lib.rs`** — Tauri commands:
  - `read_markdown_file` / `save_markdown_file` — File I/O with multi-encoding support (UTF-8, UTF-16 LE/BE, GB18030); saves are atomic (temp file + `MoveFileExW`)
  - `load_reading_state` / `save_reading_state` — Per-file scroll position + `progress` (0–1, powers the welcome screen "continue reading" entry), hashed JSON files in `AppData/mmbook/`
  - `load_recent_files` / `save_recent_files` — Recent-files list as opaque JSON in the state dir (survives WebView cache clears)
  - `get_file_mtime` — File mtime in ms; polled by the frontend for external-change auto-reload
- File association: `.md`, `.markdown` — handled via CLI args in `setup()` hook, sets `window.__INITIAL_FILE__`.
- Tauri plugins: `opener`, `dialog`, `fs`, `updater`. Capability extras: `core:window:allow-set-title` (window title shows the current file name).

### Data Flow

Frontend calls Rust via `invoke('read_markdown_file', {path})` → raw markdown → worker renders through unified pipeline + Shiki → HTML into `contentEl` via `{@html}` → post-DOM passes run (`wrapArticleTables`, lazy Mermaid render, KaTeX CSS injection) → focus/search index (`refreshFocusBlocks`) is rebuilt from the live DOM.

**Editing**: double-click a block → the block's exact source line range (`data-source-start/end`) is shown as plaintext-contenteditable → Enter/Ctrl+Enter saves (Shift+Enter newline, Esc cancels only the edit) → `replaceMarkdownSourceBlock` splices the lines → save → `tryLocalizedEditUpdate` re-renders just that block and shifts subsequent line attributes (falls back to full re-render for headings, reference links/footnotes, non-isolated blocks).

## Key Conventions

- **Language**: UI text and theme names are in Chinese. Code, comments, and variable names are in English.
- **Component decomposition policy**: Self-contained overlays live in `src/lib/components/`; pure logic goes to `src/lib/**` with unit tests. The reading core stays in `+page.svelte` because its pieces share heavy DOM/state coupling.
- **CSS custom properties for theming**: Never use hardcoded colors. Always reference `var(--property-name)` from the theme system.
- **Focus mode visuals are locked** (user decision): graduated blur, spotlight, dust particles must not change. Performance work must be pixel-identical.
- **Focus mode data model**: `FocusUnit = HTMLElement[]` — adjacent short atoms (li/tr/one-line p) merge into one unit; long top-level paragraphs are segmented into `.focus-seg` sentence-group spans (focus mode only). Atoms come from `article.children` (plus `.table-scroll > table` rows) — no deep DOM traversal.
- **Focus mode styling is windowed**: only ~±8 units around the focus point carry inline styles/transitions; everything else is hidden by the CSS baseline (`[data-focus-block]` → `opacity: 0`). Never restyle all blocks — that was the long-document freeze.
- **After any in-place article DOM change** call `reindexAfterArticleDomChange()` — search and focus indices reference live DOM nodes and go stale otherwise.
- **Long jumps never smooth-scroll** (`getJumpBehavior`): beyond ~3 viewports they cut instantly.
