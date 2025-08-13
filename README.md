# 🚀 Push & Go

The fastest way to commit, push, and manage changes in VS Code & Cursor.  
⚡ Designed for developers who want **zero-friction Git actions** without touching the terminal.

**Last updated:** August 13, 2025

---

## Why this extension?

Tired of juggling Git commands in your terminal or the slow, clunky Source Control panel?  
**Push & Go** streamlines staging, committing, ignoring, and discarding changes into a **lightweight, keyboard-friendly UI** — so you can stay focused on coding, not context-switching.

It’s like having **Git on turbo mode** right inside your editor.

---

## ✨ Features

- 📋 **Quick stage/unstage** with checkboxes  
- 💨 **One-click Push** (with upstream auto-setup)  
- 🙈 **Ignore / Unignore** files with a single action  
- 🗑 **Discard changes** instantly  
- 🖼 **Clean, modern icons** — matches your editor theme  
- 🔍 **Inline status badges** for every file  
- 🖱 **Mouse & keyboard support** — fast in both workflows  
- 🌈 **Theme-aware** (icons use `currentColor` for seamless dark/light mode)

---

## 🚀 Usage

1. Open the **Push & Go** panel from your VS Code Activity Bar or Command Palette.  
2. Stage changes with the checkboxes.  
3. Click **Comit & Push** to commit and push in one go.  
4. Right-click (or use the icon buttons) to ignore/unignore or discard changes.

✅ **No extra config** – works out of the box  
💡 **Great for quick commits & patch pushes**  
🛠 Built with TypeScript, Git API, and crisp SVG icons

---

## Screenshots

![Push & Go files section](https://raw.githubusercontent.com/Maorlv52/Push-Go/dev/media/files_section.png)  
*Files list with status badges — Quickly see all modified, staged, and ignored files in one clean view.*

![Push & Go files section](https://raw.githubusercontent.com/Maorlv52/Push-Go/dev/media/lower_section.png)  
*Action controls — Stage, unstage, ignore/unignore, or discard changes with intuitive icon buttons.*

![Push & Go files section](https://raw.githubusercontent.com/Maorlv52/Push-Go/dev/media/command_pallete.png)  
*Command Palette integration — Access Push & Go commands instantly without leaving your keyboard.*

![Push & Go files section](https://raw.githubusercontent.com/Maorlv52/Push-Go/dev/media/full_view.png)  
*Full extension workflow — Stage changes, commit, push, and manage files all in one streamlined panel.*

---

## 🛠 Development (for contributors)

```bash
pnpm install
pnpm run compile
pnpm exec vsce package
```
