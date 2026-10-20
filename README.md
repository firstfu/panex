# panex

A lightweight, open-source terminal for running many AI coding agents side by side.
Inspired by [cmux](https://github.com/manaflow-ai/cmux) (macOS only), panex targets Windows first and is built to run on macOS and Linux too.

- **Workspaces and tabs, like cmux.** The sidebar lists workspaces (Ctrl+N). Each workspace has a row of horizontal tabs (Ctrl+T), and each tab is one shell. A workspace row shows its title, cwd, tab count and the latest agent message.
- **Agent notifications.** When Claude Code needs your input or finishes, its tab and its workspace light up. If the window is in the background you also get a desktop toast and a taskbar flash.
- **Restores after close or crash.** Workspaces, tabs, each tab's shell and working directory, and its scrollback come back on the next launch. Running programs are not kept alive.
- **Shells.** cmd by default. Windows PowerShell and PowerShell 7 (if installed) are in the ⌄ menu.
- **Small footprint.** Tauri 2 + xterm.js, no framework. Restored tabs start their shell only when you open them, only the visible tab uses WebGL, and an idle app runs no timers.

## Configuration

Settings live in `~/.config/panex/panex.json` (`%USERPROFILE%\.config\panex\panex.json` on Windows), following cmux's `cmux.json` model:

- Write only the keys you want to change. Everything else uses the defaults.
- `panex.schema.json` sits next to the file, so editors like VS Code offer completion and validation.
- Saving the file applies it about 0.3 s later. If the file doesn't parse, panex keeps the last good settings and shows the error.
- The settings panel (⚙ or Ctrl+,) writes to the same file.

```json
{
  "$schema": "./panex.schema.json",
  "schemaVersion": 2,
  "app": { "opacity": 85, "windowEffect": "acrylic" },
  "terminal": { "fontSize": 15, "defaultShell": "powershell" },
  "shortcuts": {
    "bindings": {
      "renameTab": "f2",
      "nextTab": ["ctrl+k", "ctrl+n"],
      "clearScrollback": null
    }
  }
}
```

## Shortcuts

Every shortcut can be rebound. In the settings panel, click a key and press the new combo. In `panex.json`, use `shortcuts.bindings` keyed by action id: a string is one combo, an array is a chord, and `null` / `"none"` unbinds the action. The schema lists every action id.

| Default | Action (id) |
|---|---|
| Ctrl+N | New workspace (`newWorkspace`) |
| Ctrl+Shift+1…9 | New workspace with shell N from the ⌄ menu (`newWorkspaceWithShell`) |
| Ctrl+1…8 / Ctrl+9 | Go to workspace N / last workspace (`selectWorkspaceByNumber`) |
| Ctrl+PgDn / Ctrl+PgUp | Next / previous workspace |
| Ctrl+Shift+PgUp / PgDn | Move workspace up / down |
| Ctrl+Shift+R | Rename workspace (`renameWorkspace`, or double-click) |
| Ctrl+T | New tab in the current workspace (`newTab`) |
| Alt+1…8 / Alt+9 | Go to tab N / last tab (`selectTabByNumber`) |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+Alt+R | Rename tab (`renameTab`, or double-click) |
| Ctrl+Shift+W | Close tab; closing the last one closes its workspace (`closeTab`) |
| Ctrl+Shift+U | Jump to the tab that needs attention (`jumpToUnread`) |
| Ctrl+Shift+B | Toggle sidebar (`toggleSidebar`) |
| Ctrl+Shift+K | Clear scrollback (`clearScrollback`) |
| Ctrl+Shift+C / V | Copy / paste |
| Ctrl+= / Ctrl+- / Ctrl+0 | Font size up / down / reset |
| Ctrl+, / Ctrl+Shift+, | Settings / reload configuration |

With `terminal.smartCopyPaste` on (the default), Ctrl+C copies when text is selected and otherwise interrupts, and Ctrl+V pastes.

## Claude Code notifications

Click **啟用** at the bottom of the sidebar. panex adds `Notification`, `Stop` and `UserPromptSubmit` hooks that run `panex-cli notify` to `~/.claude/settings.json`. Your other hooks are kept, and the old file is backed up as `settings.json.panex-bak`.
Outside panex the helper exits immediately, so the hooks are harmless there.

Other agents can notify too. Run `panex-cli notify "message"` from a tab, or print an OSC 9 / OSC 777 notification or a bell.

## Build

Requires Rust (stable), Node.js 20+, and on Windows the MSVC build tools and WebView2.

```sh
npm install
cargo tauri dev     # run
cargo tauri build   # installer in src-tauri/target/release/bundle/
```

## License

MIT
