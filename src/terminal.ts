// One xterm.js terminal per tab: creating it, starting its shell over a pty, input,
// scrollback snapshots, WebGL lifetime, OSC handling (cwd reports, notifications) and the
// git branch of its cwd.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke, Channel } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { createDimFilter, squeezeBlankRuns, validSessionId, validSshTarget } from "./sanitize";
import { type SavedTab, type Tab } from "./types";
import { termFontFamily } from "./settings";
import { $ } from "./util";
import { S, shellName, tabs } from "./state";
import { saveSessionIfPending, saveSessionSoon } from "./session";
import { agentKey, autoResume, endAgent, endRun, notify } from "./agent";
import { sweepGoneWorktrees } from "./control";
import { scheduleGit } from "./git-panel";
import { fileLinks, linkClick, linkHint, openLink } from "./links";
import { scheduleRender } from "./render";
import { inFolder } from "./groups";
import { IS_MAC } from "./platform";

// 每個終端機一個 dim 過濾器與串流解碼器，原因見 createDimFilter。
const outFilters = new WeakMap<Tab, { dim: (s: string) => string; dec: TextDecoder }>();

const SNAPSHOT_DELAY_MS = 4000;
const SNAPSHOT_LINES = 1000;
const isWindows = navigator.userAgent.includes("Windows");

export const termsEl = $("terms");
let winBuild = 0;
let snapshotTimer: number | undefined;

function termTheme() {
  // Fully transparent: #terms paints the background so opacity applies once.
  return { background: "#00000000", foreground: "#e4e4e7", cursor: "#e4e4e7", selectionBackground: "#3f3f4699" };
}

export function createTab(meta: SavedTab, wsId: string, restored?: string): Tab {
  const term = new Terminal({
    allowProposedApi: true,
    allowTransparency: true,
    scrollback: S.settings.scrollback,
    cursorBlink: S.settings.cursorBlink,
    fontSize: S.settings.fontSize,
    fontFamily: termFontFamily(S.settings.fontFamily),
    // Squeezes one-cell characters drawn wider than a cell (⚠ as an emoji) back into their cell.
    rescaleOverlappingGlyphs: true,
    theme: termTheme(),
    windowsPty: isWindows ? { backend: "conpty", buildNumber: winBuild } : undefined,
  });
  const fit = new FitAddon();
  const serializer = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(serializer);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  const el = document.createElement("div");
  el.className = "term";
  el.hidden = true;
  termsEl.appendChild(el);

  const tab: Tab = {
    id: meta.id,
    wsId,
    shell: meta.shell,
    ssh: meta.shell === "ssh" && meta.ssh && validSshTarget(meta.ssh) ? meta.ssh : undefined,
    cwd: meta.shell === "ssh" ? undefined : meta.cwd ?? undefined,
    customTitle: meta.title ?? undefined,
    agentSession: validSessionId(meta.agentSession) ? meta.agentSession : undefined,
    term,
    fit,
    serializer,
    el,
    opened: false,
    running: false,
    exited: false,
    dirty: false,
    status: "idle",
  };

  refreshBranch(tab);
  scheduleGit(tab);

  if (restored) {
    term.write(createDimFilter()(squeezeBlankRuns(restored)), () => {
      // The snapshot leaves the cursor wherever the program had it (TUIs park it mid-screen),
      // so move below the last non-empty line before printing the marker.
      const b = term.buffer.active;
      let last = b.length - 1;
      while (last > 0 && !b.getLine(last)?.translateToString(true).trim()) last--;
      const row = Math.max(1, last - b.baseY + 1);
      const time = new Date().toLocaleString("zh-TW", { hour12: false });
      term.write(`\x1b[0m\x1b[?25h\x1b[${row};1H\r\n\x1b[90m${tr("── 已還原工作階段（{time}）──", { time })}\x1b[0m\r\n`);
    });
  }

  // Ctrl/⌘+click opens web links and file paths; both are matched only while the mouse is over a line.
  const hint = { hover: () => linkHint(tab, true), leave: () => linkHint(tab, false) };
  term.loadAddon(new WebLinksAddon((e, uri) => linkClick(e) && openLink("open_url", { url: uri }), hint));
  term.registerLinkProvider(fileLinks(tab));

  term.onData((d) => onInput(tab, d));
  if (IS_MAC) guardImeInput(el, term);
  term.onResize(({ cols, rows }) => {
    if (tab.running) invoke("pty_resize", { id: tab.id, cols, rows }).catch(() => {});
  });
  term.onTitleChange((t) => {
    tab.progTitle = t;
    scheduleRender();
  });
  term.onBell(() => notify(tab, "attention", tr("🔔 響鈴")));
  // OSC 9;9;<path> = cwd report (our cmd/PowerShell prompts emit it).
  // Other OSC 9 payloads are iTerm2-style notifications; "N;..." forms are ConEmu extras we ignore.
  term.parser.registerOscHandler(9, (data) => {
    if (data.startsWith("9;")) setCwd(tab, data.slice(2).replace(/^"|"$/g, ""));
    else if (!/^\d+;/.test(data)) notify(tab, "attention", data);
    return true;
  });
  // OSC 7 = file://host/path cwd report (Unix shells).
  term.parser.registerOscHandler(7, (data) => {
    try {
      let p = decodeURIComponent(new URL(data).pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      setCwd(tab, p);
    } catch {}
    return true;
  });
  // OSC 777;notify;title;body (urxvt / Ghostty style).
  term.parser.registerOscHandler(777, (data) => {
    const [kind, title, body] = data.split(";");
    if (kind === "notify") notify(tab, "attention", body || title || "");
    return true;
  });

  tabs.set(tab.id, tab);
  return tab;
}

/**
 * Keeps characters typed through a macOS input method from being dropped.
 *
 * With an IME active (OpenVanilla, for one), WKWebView fires `input` before the key's
 * `keydown` (keyCode 229). xterm ignores an `insertText` input while it thinks a key is still
 * down, which is the case whenever the previous key's `keyup` arrives late; the 229 keydown
 * then diffs the textarea against a value that already holds the character, so nothing is
 * sent. The fix sends such inputs ourselves, ahead of xterm.
 *
 * Only an input that comes before its keydown is taken over. When the 229 keydown comes first
 * (Chromium's order), xterm's textarea diff sends the character, and sending here too would
 * double it. Inputs inside a composition belong to xterm's composition handling.
 *
 * @param el   the tab's container; the listeners run in its capture phase, before xterm's
 * @param term the tab's terminal, whose `input` feeds `onData` like typing does
 */
function guardImeInput(el: HTMLElement, term: Terminal) {
  let composing = false;
  let imeKeyPending = false; // a 229 keydown whose input hasn't come yet
  let inputAhead = false; // an input we sent whose 229 keydown hasn't come yet
  el.addEventListener("compositionstart", () => (composing = true), true);
  // xterm reads the textarea a tick after compositionend; stay out until then.
  el.addEventListener("compositionend", () => setTimeout(() => (composing = false)), true);
  // 空白與大寫字母在 WebKit 走 keydown → keypress（xterm 已在 keypress 送出），隨後還會補一個
  // `input`；不擋掉的話守衛會再送一次，一個空白變兩個（zsh 的 autosuggestion 因此對不上歷史）。
  let keyPressed = false;
  el.addEventListener("keypress", () => (keyPressed = true), true);
  el.addEventListener(
    "keydown",
    (e) => {
      keyPressed = false;
      if (e.keyCode !== 229) return;
      if (inputAhead) inputAhead = false;
      else imeKeyPending = true;
    },
    true,
  );
  el.addEventListener(
    "input",
    (e) => {
      const ev = e as InputEvent;
      if (keyPressed) {
        keyPressed = false;
        return;
      }
      if (ev.inputType !== "insertText" || !ev.data || ev.isComposing || composing) return;
      if (imeKeyPending) {
        imeKeyPending = false;
        return;
      }
      inputAhead = true;
      ev.stopPropagation();
      term.input(ev.data, true);
    },
    true,
  );
}

export function onInput(tab: Tab, data: string) {
  agentKey(tab, data);
  if (tab.running) {
    invoke("pty_write", { id: tab.id, data }).catch(() => {});
  } else if (tab.exited && data === "\r") {
    tab.exited = false;
    spawn(tab);
  }
}

export async function spawn(tab: Tab) {
  autoResume(tab);
  const onData = new Channel<ArrayBuffer>();
  onData.onmessage = (buf) => {
    let f = outFilters.get(tab);
    if (!f) outFilters.set(tab, (f = { dim: createDimFilter(), dec: new TextDecoder() }));
    // stream: true 讓被切在 chunk 邊界的 UTF-8 字元留到下一塊
    tab.term.write(f.dim(f.dec.decode(new Uint8Array(buf), { stream: true })));
    markDirty(tab);
  };
  // Set before the call: ConPTY asks for the cursor position right away and
  // xterm's answer must reach the shell, or the console waits forever.
  tab.running = true;
  try {
    await invoke("pty_spawn", {
      id: tab.id,
      shell: tab.shell,
      ssh: tab.ssh ?? null,
      cwd: tab.cwd ?? null,
      cols: tab.term.cols,
      rows: tab.term.rows,
      onData,
    });
    if (tab.initialInput) {
      // The pty queues input until the shell starts reading, so no need to wait for the prompt.
      invoke("pty_write", { id: tab.id, data: `${tab.initialInput}\r` }).catch(() => {});
      tab.initialInput = undefined;
    }
  } catch (e) {
    tab.running = false;
    tab.exited = true;
    tab.term.write(`\r\n\x1b[31m${tr("無法啟動 {shell}：{e}", { shell: tab.ssh ? `ssh ${tab.ssh}` : shellName(tab.shell), e: String(e) })}\x1b[0m\r\n`);
  }
}

function markDirty(tab: Tab) {
  tab.dirty = true;
  // Only armed while output is flowing; an idle app runs no timers.
  snapshotTimer ??= window.setTimeout(() => {
    snapshotTimer = undefined;
    flushSnapshots();
  }, SNAPSHOT_DELAY_MS);
}

function flushSnapshots() {
  const jobs: Promise<unknown>[] = [];
  for (const tab of tabs.values()) {
    if (!tab.dirty) continue;
    tab.dirty = false;
    const data = tab.serializer.serialize({ scrollback: SNAPSHOT_LINES, excludeAltBuffer: true, excludeModes: true });
    jobs.push(invoke("scrollback_save", { id: tab.id, data }).catch(() => {}));
  }
  return Promise.all(jobs);
}

export function attachWebgl(tab: Tab) {
  if (tab.webgl) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      tab.webgl = undefined;
    });
    tab.term.loadAddon(webgl);
    tab.webgl = webgl;
  } catch {
    // No WebGL: xterm falls back to its DOM renderer.
  }
}

export function disposeTab(tab: Tab) {
  clearTimeout(tab.gitTimer);
  tab.webgl?.dispose();
  tab.term.dispose();
  tab.el.remove();
  tabs.delete(tab.id);
  if (S.visibleTabId === tab.id) S.visibleTabId = undefined;
  if (S.renaming?.id === tab.id) S.renaming = undefined;
}

/**
 * 讓 shell 切到 `dir` 的指令。
 * @param shell 分頁的 shell id（cmd、PowerShell 類、或 macOS/Linux 的 default）
 * @param dir 目標資料夾（絕對路徑）
 * @returns 一行指令，不含換行
 */
function cdCommand(shell: string, dir: string) {
  if (shell === "cmd") return `cd /d "${dir}"`;
  if (shell === "default") return `cd -- '${dir.replace(/'/g, `'\\''`)}'`;
  return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`;
}

function setCwd(tab: Tab, cwd: string) {
  // A remote path means nothing locally (git branch, a new tab's folder), so SSH tabs keep none.
  if (!cwd || tab.ssh) return;
  // A shell prompt means Claude Code has exited. ConPTY can report one prompt twice within
  // a millisecond, so reports that close together count as one.
  const now = performance.now();
  const duplicate = tab.promptAt !== undefined && now - tab.promptAt < 50;
  tab.promptAt = now;
  if (tab.agentLive && !duplicate) {
    if (tab.skipPrompt) tab.skipPrompt = false;
    else {
      endAgent(tab);
      endRun(tab);
    }
  }
  // 所在的 worktree 被刪了（Claude 的 WorktreeRemove）：shell 還留在已刪的資料夾裡才帶它回主 checkout。
  if (tab.leaveDir && !duplicate) {
    const { from, to } = tab.leaveDir;
    tab.leaveDir = undefined;
    if (inFolder(cwd, from)) {
      invoke("pty_write", { id: tab.id, data: `${cdCommand(tab.shell, to)}\r` }).catch(() => {});
      return;
    }
  }
  // Every prompt reports the cwd, so this also catches `git checkout` in place.
  refreshBranch(tab, cwd);
  // A prompt also ends whatever command might have changed files or commits.
  if (!duplicate) scheduleGit(tab);
  // ...and a `git worktree remove` typed here deletes a worktree another workspace is open in.
  if (!duplicate) sweepGoneWorktrees();
  if (cwd === tab.cwd) return;
  tab.cwd = cwd;
  saveSessionSoon();
  scheduleRender();
}

export function refreshBranch(tab: Tab, cwd = tab.cwd) {
  if (!cwd) return;
  const now = Date.now();
  if (cwd === tab.cwd && tab.branchAt && now - tab.branchAt < 1000) return;
  tab.branchAt = now;
  invoke<{ branch: string; repo: string; worktree: boolean } | null>("git_branch", { cwd })
    .then((h) => {
      if (h?.branch === tab.branch && h?.repo === tab.repo && h?.worktree === tab.worktree) return;
      tab.branch = h?.branch;
      tab.repo = h?.repo;
      tab.worktree = h?.worktree;
      scheduleRender();
    })
    .catch(() => {});
}

export async function detectWindowsBuild() {
  if (!isWindows) return;
  // Chromium reports platformVersion >= 13 on Windows 11 (build >= 22000). xterm only
  // needs to know whether ConPTY is new enough (>= 21376) to handle reflow itself.
  try {
    const ua = (navigator as any).userAgentData;
    const v = await ua?.getHighEntropyValues(["platformVersion"]);
    winBuild = parseInt(v?.platformVersion ?? "0", 10) >= 13 ? 22000 : 19041;
  } catch {
    winBuild = 19041;
  }
}

/** Final save before the window goes away; crashes rely on the periodic snapshots. */
export function flushForClose() {
  clearTimeout(snapshotTimer);
  return Promise.all([flushSnapshots(), saveSessionIfPending()]);
}
