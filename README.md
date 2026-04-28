# MMbook 📚
---
**MMbook** 是一款为个人开发者量身定制的 Markdown 阅读器，旨在提供最纯粹、最沉浸的阅读体验。它不仅尊重你的内容，更专注于通过精致的视觉设计和独特的“专注模式”来提升阅读质量。

![MMbook Preview](https://img.shields.io/badge/Status-Beta-orange)
![Tauri](https://img.shields.io/badge/Powered%20by-Tauri-blue)
![Svelte](https://img.shields.io/badge/Built%20with-Svelte-ff3e00)

## ✨ 核心特性

- 🎨 **多款精美主题**：内置“素纸”、“墨石”、“暮光”等多种极简风格主题，支持深浅色模式切换，每一处色彩都经过精心调配。
- 👁️ **沉浸式专注模式**：独创的“聚光灯”阅读体验。当你滚动页面时，当前阅读段落会被高亮（聚光灯效果），周围内容自然淡化并辅以优雅的模糊效果。
- 🔍 **高效全局搜索**：支持 macOS 风格的圆角悬浮搜索框，提供实时高亮定位。
- 📑 **智能目录大纲**：自动提取 Markdown 层级，侧边栏目录支持一键跳转。
- ✍️ **轻量级即时编辑**：双击任意段落即可进入编辑状态，快速修改错别字或调整内容。
- 🚀 **极致性能**：基于 Rust & Tauri 构建，极小的内存占用，飞快的启动速度。
- 🖋️ **代码高亮**：集成 Shiki 高亮引擎，支持数十种主流编程语言的精准着色。

## 🛠️ 技术栈

- **Frontend**: Svelte 5 + TypeScript + Vite
- **Backend**: Rust (Tauri 2.0)
- **Engine**: Unified / Remark / Rehype (Markdown 解析)
- **Highlighter**: Shiki (代码高亮)
- **Styling**: Vanilla CSS (极简主义设计)

## ⌨️ 快捷键

为了提升操作效率，MMbook 提供了一系列快捷键：

| 功能 | Windows / Linux | macOS |
| :--- | :--- | :--- |
| 打开文件 | `Ctrl + O` | `⌘ + O` |
| 开启/关闭搜索 | `Ctrl + F` | `⌘ + F` |
| 开启/关闭目录 | `Ctrl + T` | `⌘ + T` |
| 开启/关闭专注模式 | `F11` / `Ctrl + Shift + F` | `F11` / `⌘ + Shift + F` |
| 打开设置 | `Ctrl + ,` | `⌘ + ,` |
| 退出当前弹窗/编辑/模式 | `Esc` | `Esc` |
| 专注模式下移动光标 | `↑` / `↓` | `↑` / `↓` |

## 📦 快速开发

### 前置要求
- [Node.js](https://nodejs.org/) (推荐 v18+)
- [Rust](https://www.rust-lang.org/) 环境

### 安装与运行
1. 克隆仓库：
   ```bash
   git clone https://github.com/lingcang728/MMbook.git
   cd MMbook
   ```
2. 安装依赖：
   ```bash
   npm install
   ```
3. 启动开发服务器：
   ```bash
   npm run tauri dev
   ```

## 📜 开源协议

本项目采用 [MIT](LICENSE) 协议开源。

---

*由 **凌苍** 精心打造*

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).
