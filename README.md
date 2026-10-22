<div align="center">

<img src="assets/icon.png" width="128" alt="panex icon">

# panex

**A terminal for running many AI coding agents at once — see which one needs you, and pick up where you left off after a crash.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Windows 10/11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?logo=windows)
![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple)
[![Latest release](https://img.shields.io/github/v/release/firstfu/panex)](https://github.com/firstfu/panex/releases/latest)

[Download](https://github.com/firstfu/panex/releases/latest) · [Features](#features) · [Install](#install) · [Configuration](#configuration) · [FAQ](#faq)

English · [繁體中文](translations/README.zh-Hant.md)

<a href="https://github.com/firstfu/panex/releases/latest"><b>Download for Windows (panex_0.6.0_x64-setup.exe)</b></a> · <a href="https://github.com/firstfu/panex/releases/latest"><b>macOS (panex_0.6.0_aarch64.dmg)</b></a>

<img src="assets/hero.png" width="860" alt="panex: three workspaces in the sidebar, one waiting for permission (blue), one finished (green), and a workspace with two tabs">

</div>

> [!NOTE]
> panex runs on **Windows 10 and 11** and **macOS on Apple Silicon** (new in 0.3.0; on a Mac, ⌘ takes the place of Ctrl in the default shortcuts). Linux builds but isn't tested. The downloads **aren't code-signed**, so Windows SmartScreen and macOS Gatekeeper warn on the first run ([steps](#install)). All the code is here, and panex's only network connection is the [update check](#privacy), which you can turn off.

## Why panex

Running three or four Claude Code sessions at once means constantly flipping between windows to find the one that's waiting for a "yes". panex is a terminal that knows when an agent needs you.

It's built to stay out of the way. The app itself is a 9 MB executable that uses no CPU when idle, and closing it — or a crash — doesn't lose your layout.

## Features

### Know which agent needs you

When Claude Code asks for permission or finishes a task, its tab gets a dot and its workspace lights up in the sidebar with the message: blue when it's waiting for you, green when it's done. If panex is in the background, you also get a desktop notification and a taskbar flash. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd> jumps straight to the tab that needs you. While an agent is working, its workspace shows a spinner and how long the turn has been running; when it finishes, you see how long it took.

panex sets up the [Claude Code hooks](#claude-code-notifications) by itself when it starts; there's nothing to turn on. Other tools can notify too: run `panex-cli notify "message"`, or print a bell, OSC 9 or OSC 777 sequence.

### Crew mode: let an agent start other agents

Ask Claude Code in a panex tab to split a job across parallel agents, and it starts a crew: new workspaces right below its own, each in its own git worktree if you like, running in tabs you can watch and type into. It waits for them, tells you when one is waiting for your answer instead of answering for it, and collects their work from git when they're done.

Behind it are two commands any agent can run inside panex. `panex-cli open` starts a command in a new workspace (optionally in a new worktree) without switching your view, and `panex-cli wait` blocks until those agents finish or need you; `panex-cli help` has the details. panex installs a small Claude Code skill that teaches Claude to use them. Only processes started inside panex can send these commands.

### Workspaces and tabs

The sidebar holds workspaces (<kbd>Ctrl</kbd>+<kbd>N</kbd>), one per project or task. Each workspace has its own row of tabs (<kbd>Ctrl</kbd>+<kbd>T</kbd>), and each tab is a shell that opens in the same folder as the one you were in. Rename workspaces and tabs, give workspaces a color, and drag either into order.

### Comes back after a crash

Workspaces, tabs, each tab's shell and working directory, and the scrollback text are saved as you go. Close panex, reboot, or kill it from Task Manager: next time it opens exactly where you were. Programs that were running are not kept alive, but panex remembers the Claude Code session each tab was running: when you reopen panex and open that tab, it runs `claude --resume <id>` for you, so you land back in the conversation. Tabs where you had already quit Claude Code stay at the prompt. You can turn this off in Settings → Terminal.

### See what changed, without leaving the terminal

<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> opens a Git panel on the right for the current tab's repo: staged changes, changes and untracked files, and the last 30 commits, with the ones you haven't pushed marked. Click a file or a commit to read its diff over the terminal; <kbd>Esc</kbd> closes it. In the sidebar, each workspace's branch carries `↑` unpushed commits, `↓` commits waiting upstream and `●` uncommitted changes, so you can tell at a glance which agent left work behind.

The panel only reads: it doesn't stage, commit, push or fetch. It doesn't poll or watch your files either. It runs `git status` once after a shell prompt, after Claude Code finishes a turn, or when you come back to the window, so it costs nothing while you're not using it.

### SSH connections

Pick **SSH connection…** from the ⌄ menu next to New workspace, choose a host from your `~/.ssh/config` or type `user@host:port`, and it opens in its own workspace. New tabs in that workspace connect to the same host. panex runs your system's `ssh`, so your keys, config, `known_hosts` and agent work as usual, and passwords are asked in the terminal and never stored.

### Every shortcut is yours

Click a shortcut in Settings and press the new keys. Bind two combinations to one action, use chords such as <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>N</kbd>, or unbind a key so it reaches the terminal. Conflicts are resolved for you: the old owner of a combination loses it, and you're told which one.

<img src="assets/shortcuts.png" width="780" alt="The shortcuts page in Settings, grouped into workspaces and tabs, with each key drawn as a keycap">

### And more

- **cmd by default**, Windows PowerShell and PowerShell 7 (if installed) one click away
- Transparency, plus Mica or Acrylic window backgrounds on Windows 11
- One plain JSON config file with a schema, applied the moment you save it
- Right-click a workspace to start a new one in a fresh git worktree, with `.env` files copied over
- Right-click a worktree's workspace to close it and delete the worktree; the dialog first lists what would be lost (uncommitted files, commits on no other branch, agents still working) and lets you keep or delete the branch
- A repo's checkouts are grouped in the sidebar: the main folder's workspace on top with a fold arrow, its worktrees indented below it (tagged `worktree`); folded, the top row shows the most urgent status inside
- When Claude Code opens a worktree (`EnterWorktree`, `claude --worktree`), panex creates it next to the repo and adds a workspace for it under the repo in the sidebar, with a shell in the worktree; the conversation stays in the tab where you started it. When Claude removes it again (`ExitWorktree`, or leaving a `claude --worktree` session), panex deletes it and closes that workspace. A worktree deleted any other way (`git worktree remove` in a terminal, another tool) also drops out of the sidebar on its own, the next time panex gets focus or a shell returns to its prompt. This works through Claude Code's `WorktreeCreate` and `WorktreeRemove` hooks, which also apply to Claude Code outside panex (the worktree is then made where Claude Code normally would, and removed the way Claude Code would); turn it off in Settings → Terminal
- Color emoji in the terminal, so warnings such as ⚠ in Claude Code's status line stand out
- Pick from the monospace fonts installed on your machine; Chinese and emoji fall back automatically
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> searches the scrollback
- <kbd>Ctrl</kbd>+click a URL to open it in your browser, or a file path such as `src/main.ts:120` to open the file (in VS Code or Cursor at that line, if you pick one in Settings → Terminal)
- <kbd>Ctrl</kbd>+<kbd>Enter</kbd> inserts a newline in Claude Code instead of sending (rebindable, for example to <kbd>Shift</kbd>+<kbd>Enter</kbd>)
- English and Traditional Chinese interface, following your system language (switch in Settings)
- Chinese and other wide characters line up correctly; Unicode 11 widths
- Ctrl+C copies when text is selected and interrupts otherwise; Ctrl+V pastes
- Closing panex, or a tab or workspace, while an agent in it is mid-task asks first, so a stray click doesn't interrupt it (can be turned off in Settings → Terminal)
- Single instance: opening panex again brings the existing window forward

## Performance

Measured on the release build:

| | |
|---|---|
| `panex.exe` | **9 MB** |
| Installer | **2.3 MB** |
| CPU when idle (10 s, 7 tabs) | **0.03 s total** |
| panex process memory | **≈ 7 MB** private |

Most of the memory you'll see in Task Manager belongs to WebView2, the Edge engine that draws the window (about 220 MB with 7 tabs open). Restored tabs don't start their shell until you open them, and only the visible tab uses GPU rendering.

## Privacy

There's no telemetry. The one network connection panex makes on its own is the **update check**: at launch, and when the window regains focus after at least six hours, it asks GitHub for `latest.json` from the newest release. Nothing about you or your machine is sent beyond what any HTTPS request carries. Turn it off under **Settings → Look → Check for updates automatically** (`app.checkForUpdates` in `panex.json`) and panex makes no connections at all, apart from an SSH connection you open yourself, which runs your system's `ssh`. The Git panel never fetches. Updates are never installed on their own, and every download is verified against a public key built into the app.

The only file it writes outside its own folders is `~/.claude/settings.json`: when panex starts and its Claude Code hooks are missing or point at an old install, it adds them. It backs the file up first (`settings.json.panex-bak`) and keeps your other hooks. The code is in [`src-tauri/src/hooks.rs`](src-tauri/src/hooks.rs).

## Install

### Windows

1. Download `panex_0.6.0_x64-setup.exe` from [Releases](https://github.com/firstfu/panex/releases/latest).
2. Run it. Windows SmartScreen will warn you the first time, because the installer isn't code-signed: click **More info**, then **Run anyway**.
3. panex installs for your user only (no administrator rights needed) and adds a Start menu entry.

Requires **Windows 10 or 11** with WebView2 (already part of Windows 11 and up-to-date Windows 10).

### macOS (Apple Silicon)

1. Download `panex_0.6.0_aarch64.dmg` from [Releases](https://github.com/firstfu/panex/releases/latest), open it and drag **panex** into **Applications**.
2. The app isn't notarized, so macOS blocks the first launch. Open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**. If macOS says the app is damaged, run `xattr -cr /Applications/panex.app` in Terminal and open it again.

Tabs start your login shell (`$SHELL`, usually zsh). Default shortcuts use ⌘: ⌘T new tab, ⌘W close tab, ⌘N new workspace, ⌘1–9 / ⌥1–9 jump, ⌘↑↓ workspaces, ⌘←→ tabs, ⌘⇧G Git panel, ⌘B sidebar, ⌘, settings.

### Updating

When a newer version is out, a line appears at the bottom of the sidebar. Click **Update and restart**: panex downloads the new version, installs it and restarts. Restarting ends the programs running in your tabs (with an agent mid-turn, panex asks first); workspaces, scrollback and Claude Code conversations come back. You can also check by hand in **Settings → Look**.

- **macOS**: releases are signed with the same certificate every time, so Accessibility, Files & Folders and the other permissions you granted stay allowed after an update, and an update installed from inside panex doesn't need **Open Anyway** again. The first release with this needs one last re-allow if you ran an older one.
- **Windows**: the installer runs in passive mode (a small progress window, no questions) and starts panex again.
- The first version with in-app updates has to be installed by hand, like any other. You can always run a new installer yourself instead; your workspaces, scrollback and settings are kept.

### Claude Code notifications

panex adds `Notification`, `Stop`, `StopFailure`, `UserPromptSubmit` and `SessionEnd` hooks that run `panex-cli notify` to `~/.claude/settings.json` when it starts, if they're missing or point at an old install. It backs the file up first and keeps your other hooks. Outside panex the helper exits immediately, so Claude Code sessions in other terminals aren't affected. It also keeps `~/.claude/skills/panex/SKILL.md` up to date, which tells Claude how to start a [crew](#crew-mode-let-an-agent-start-other-agents); the skill does nothing outside panex.

## Configuration

Settings live in `%USERPROFILE%\.config\panex\panex.json` (`~/.config/panex/panex.json` on macOS and Linux):

- Write only the keys you want to change. Everything else uses the defaults.
- `panex.schema.json` sits next to it, so editors such as VS Code offer completion and descriptions.
- Saving the file applies it about 0.3 s later. If it doesn't parse, panex keeps the last good settings and shows the error with a button to open the file.
- The Settings panel (⚙ or <kbd>Ctrl</kbd>+<kbd>,</kbd>) writes to the same file.

```json
{
  "$schema": "./panex.schema.json",
  "schemaVersion": 2,
  "app": { "opacity": 85, "windowEffect": "acrylic" },
  "terminal": { "fontSize": 15, "defaultShell": "powershell" },
  "shortcuts": {
    "bindings": {
      "newTab": [["ctrl+t"], ["ctrl+shift+t"]],
      "renameTab": "f2",
      "nextWorkspace": ["ctrl+k", "ctrl+n"],
      "clearScrollback": null
    }
  }
}
```

A string is one combination, an array of strings is a chord, an array of arrays lists alternatives, and `null` unbinds the action.

### Default shortcuts

| Keys | Action (id) |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>N</kbd> | New workspace (`newWorkspace`) |
| <kbd>Ctrl</kbd>+<kbd>T</kbd> | New tab in the current workspace (`newTab`) |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | Go to workspace 1–8, 9 = last (`selectWorkspaceByNumber`) |
| <kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | Go to tab 1–8, 9 = last (`selectTabByNumber`) |
| <kbd>Ctrl</kbd>+<kbd>PgDn</kbd> / <kbd>PgUp</kbd> | Next / previous workspace |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> | Next / previous tab |
| <kbd>Ctrl</kbd>+<kbd>W</kbd> | Close tab; closing the last one closes its workspace (`closeTab`) |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> / <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> | Rename workspace / tab (or double-click) |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd> | Jump to the tab that needs you (`jumpToUnread`) |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd> | Show / hide the sidebar (`toggleSidebar`) |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | Show / hide the Git panel (`toggleGitPanel`) |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (macOS: <kbd>Shift</kbd>+<kbd>Enter</kbd>) | Newline without sending, for Claude Code (`insertNewline`) |
| <kbd>Ctrl</kbd>+<kbd>=</kbd> / <kbd>-</kbd> / <kbd>0</kbd> | Font size up / down / reset (or Ctrl+wheel) |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> | Settings |

The schema lists every action id.

## FAQ

<details>
<summary><b>Windows says "Windows protected your PC"</b></summary>

The installer isn't code-signed yet. Click **More info**, then **Run anyway**. You only need to do this once per version.
</details>

<details>
<summary><b>macOS says panex "can't be opened" or "is damaged"</b></summary>

The app isn't notarized by Apple. Go to **System Settings → Privacy & Security** and click **Open Anyway**, or run `xattr -cr /Applications/panex.app` and open it again. You only need to do this once per version (not for updates installed from inside panex).
</details>

<details>
<summary><b>Do I lose macOS permissions when I update?</b></summary>

No. Releases are signed with the same certificate every time, and macOS ties permissions to that signature, not to the file. If you build panex yourself it is signed ad hoc, and macOS asks again after every rebuild.
</details>

<details>
<summary><b>Claude Code notifications don't show up</b></summary>

panex sets this up by itself at launch. If the bottom of the sidebar says **Claude Code 通知：未啟用** (not enabled), panex couldn't write `~/.claude/settings.json` (for example, the file isn't valid JSON): fix the file and click **啟用** (Enable). Notifications only light up tabs for Claude Code sessions started inside panex. Desktop notifications appear only while panex isn't the active window; the tab and workspace light up either way.
</details>

<details>
<summary><b>Ctrl+T, Ctrl+N or another key doesn't reach the program in my terminal</b></summary>

panex handles its shortcuts before the terminal sees them. For example, Claude Code uses Ctrl+T to toggle its todo list. If you need a key inside the terminal, open Settings → 快捷鍵 (Shortcuts) and rebind or clear the panex shortcut.
</details>

<details>
<summary><b>Where does panex keep my data?</b></summary>

Settings: `%USERPROFILE%\.config\panex\panex.json`. Layout and scrollback: `%APPDATA%\dev.panex.terminal\`. Delete either folder to start fresh.
</details>

<details>
<summary><b>How do I uninstall it?</b></summary>

Use **Settings → Apps → Installed apps → panex → Uninstall**. To remove your data too, delete the two folders above. Then remove the `panex-cli` entries from `~/.claude/settings.json` (or restore `settings.json.panex-bak`).
</details>

## How it differs from similar tools

Windows Terminal is an excellent terminal, but it doesn't know when an agent is waiting for you or which tab it's in.

## Under consideration: vote with 👍

I won't build these until real people ask for them. If one matters to you, [open an issue](https://github.com/firstfu/panex/issues/new) or 👍 an existing one and tell me **how you'd use it**.

- Split panes inside a tab
- Listening ports in the sidebar

## Build from source

Requires Rust (stable), Node.js 20+, and on Windows the Visual Studio C++ build tools and WebView2.

```sh
git clone https://github.com/firstfu/panex.git && cd panex
npm install
cargo tauri dev     # run in development
cargo tauri build   # installer in src-tauri/target/release/bundle/
```

`cargo install tauri-cli --version "^2"` provides `cargo tauri`.

## Contributing

Free and open source, built by one person — [issues](https://github.com/firstfu/panex/issues/new) and pull requests are very welcome. Bug reports are most useful with your Windows version and the shell you were using.

## Also by the same author

[Liftoff](https://github.com/firstfu/Liftoff) — the Launchpad that macOS 26 took away, back and faster, with live window previews.
[DockLens](https://github.com/firstfu/DockLens-app) — hover a Dock icon to see live thumbnails of all of that app's windows.

## License

[MIT](LICENSE). Use it, change it, ship it; keep the copyright notice.
