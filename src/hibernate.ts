// Hibernating tabs when memory runs short (Windows and macOS): ending a hidden, idle tab's shell,
// Claude Code and MCP servers to give their memory back. Nothing happens while the machine has
// memory to spare, and there is no timer: the check follows each memory read, which only events
// cause. The screen stays as it was. Viewing the tab starts the shell and `claude --resume`s the
// session behind a still copy of that screen, which goes away once Claude Code has drawn itself.

import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { t as tr } from "./i18n";
import { type Tab } from "./types";
import { S, tabs, tabTitle } from "./state";
import { scheduleRender } from "./render";
import { saveSessionSoon } from "./session";
import { refreshMem, type Usage } from "./mem";
import { spawn } from "./terminal";
import { notify } from "./agent";
import { showNotice } from "./config";
import { CAN_MANAGE } from "./platform";
import { REFUSED_MS, sleepOrder, underPressure, type MemoryStatus, type SleepInfo } from "./sleep-rule";

const NEXT_READ_MS = 2000; // after ending a tab, let the system see the memory come back
const WAKE_QUIET_MS = 1500;
const WAKE_MIN_MS = 2500;
const WAKE_MAX_MS = 45_000;
const WAKE_REDRAW_MS = 400;

let checking = false;
let warned = false; // told the user once during this stretch of short memory

const info = (t: Tab): SleepInfo & { tab: Tab } => ({
  tab: t,
  visible: t.id === S.visibleTabId,
  running: t.running,
  hibernated: t.hibernated,
  ssh: !!t.ssh,
  waking: !!t.wake,
  agentLive: t.agentLive,
  agentSession: t.agentSession,
  agentRemote: t.agentRemote,
  agentBackground: t.agentBackground,
  status: t.status,
  asking: t.asking,
  typedAt: t.typedAt,
  outAt: t.outAt,
  seenAt: t.seenAt,
  refusedAt: t.sleepRefusedAt,
});

/** Called after each memory read: when memory is short, ends the longest unused tab that can go. */
export async function checkPressure(usage: Usage[]) {
  if (!CAN_MANAGE || !S.settings.hibernateOnPressure || checking) return;
  checking = true;
  try {
    const mem = await invoke<MemoryStatus>("memory_status");
    if (!underPressure(usage.reduce((n, u) => n + u.bytes, 0), mem)) {
      warned = false;
      return;
    }
    const now = Date.now();
    for (const { tab } of sleepOrder([...tabs.values()].map(info), now)) {
      if (await hibernate(tab)) {
        // One at a time: the next read decides whether another one is needed.
        window.setTimeout(refreshMem, NEXT_READ_MS);
        return;
      }
    }
    warnIfStuck(now);
  } catch (e) {
    console.warn("panex: memory check failed", e);
  } finally {
    checking = false;
  }
}

/** Memory is short and nothing can go because of phones or work in progress: say so once. */
function warnIfStuck(now: number) {
  if (warned) return;
  const kept = [...tabs.values()].filter(
    (t) => t.running && t.agentLive && (t.agentRemote || (t.sleepRefused === "remote" && now - (t.sleepRefusedAt ?? 0) < REFUSED_MS)),
  );
  if (!kept.length) return;
  warned = true;
  showNotice(tr("記憶體不足。有 {n} 個分頁連著 Remote Control，panex 不會結束它們；可以關掉用不到的分頁（{names}）。", {
    n: kept.length,
    names: kept.slice(0, 3).map(tabTitle).join("、"),
  }));
}

/** Asks the backend to end the tab; it runs the checks only it can. @returns whether it ended */
async function hibernate(tab: Tab) {
  const answer = await invoke<string>("pty_hibernate", { id: tab.id }).catch((e) => String(e));
  if (!tabs.has(tab.id)) return false;
  if (answer !== "ok") {
    tab.sleepRefused = answer;
    tab.sleepRefusedAt = Date.now();
    return false;
  }
  tab.running = false;
  tab.hibernated = true;
  tab.agentLive = false; // gone with the shell; the session id stays, so the next start resumes it
  tab.skipPrompt = false;
  saveSessionSoon();
  refreshMem();
  // Became visible while the backend was ending it: start it again right away.
  if (S.visibleTabId === tab.id) void spawn(tab);
  scheduleRender();
  return true;
}

/** A still copy of the tab's screen, shown while the real terminal restarts behind it. */
function coverScreen(tab: Tab) {
  const el = document.createElement("div");
  el.className = "wake-cover";
  const copy = new Terminal({
    cols: tab.term.cols,
    rows: tab.term.rows,
    allowProposedApi: true,
    allowTransparency: true,
    disableStdin: true,
    cursorInactiveStyle: "none",
    scrollback: 0,
    fontSize: tab.term.options.fontSize,
    fontFamily: tab.term.options.fontFamily,
    rescaleOverlappingGlyphs: true,
    theme: tab.term.options.theme,
  });
  const badge = document.createElement("div");
  badge.className = "wake-badge";
  badge.textContent = tr("正在接回 Claude Code…");
  el.append(badge);
  const holder = document.createElement("div");
  holder.className = "wake-screen";
  el.prepend(holder);
  tab.el.append(el);
  tab.el.classList.add("waking");
  copy.open(holder);
  copy.write(tab.serializer.serialize({ scrollback: 0 }) + "\x1b[?25l");
  return () => {
    copy.dispose();
    el.remove();
    tab.el.classList.remove("waking");
  };
}

/**
 * Called as a hibernated tab's shell is about to start. Clears the real terminal, because
 * `claude --resume` prints the conversation again, and watches for Claude Code to come back.
 */
export function beginWake(tab: Tab) {
  const session = tab.agentSession;
  const args = tab.agentArgs;
  tab.hibernated = false;
  // Started in the background (`panex-cli send`), nobody is looking and there is no size to draw at.
  const uncover = tab.opened && S.visibleTabId === tab.id ? coverScreen(tab) : () => {};
  // Put back if Claude Code doesn't return: the reset below drops the scrollback too.
  const before = tab.serializer.serialize({ excludeAltBuffer: true, excludeModes: true });
  tab.term.reset();
  const wake = { keys: [] as string[] };
  tab.wake = wake;
  const start = Date.now();

  const finish = async (ok: boolean) => {
    if (tab.wake !== wake) return;
    if (ok) {
      // Claude Code's first drawing leaves the shell's text among its own until its own full
      // redraw, seconds later. Ctrl+L asks for that redraw now, while the cover still hides it.
      await invoke("pty_write", { id: tab.id, data: "\x0c" }).catch(() => {});
      await new Promise((done) => window.setTimeout(done, WAKE_REDRAW_MS));
      if (tab.wake !== wake) return;
    }
    tab.wake = undefined;
    uncover();
    if (ok) {
      for (const data of wake.keys) await invoke("pty_write", { id: tab.id, data }).catch(() => {});
    } else {
      // What the failed resume printed goes under the old screen. Starting from the last row,
      // because the old cursor may have been anywhere in Claude Code's interface.
      const after = tab.serializer.serialize({ scrollback: 0, excludeAltBuffer: true, excludeModes: true });
      tab.term.reset();
      tab.term.write(`${before}\x1b[${tab.term.rows};1H\r\n${after}`);
      // The shell prompt reports "Claude Code exited", which forgets the session; keep it for a retry.
      tab.agentSession = session;
      tab.agentArgs = args;
      tab.agentLive = false;
      saveSessionSoon();
      notify(tab, "attention", tr("Claude Code 沒有接回來，可以手動執行 claude --resume {id}", { id: session ?? "" }));
    }
    refreshMem();
    scheduleRender();
  };

  const look = async () => {
    if (tab.wake !== wake) return;
    if (!tabs.has(tab.id)) return void (tab.wake = undefined);
    const now = Date.now();
    if (!tab.running || !tab.agentLive) return finish(false);
    const out = tab.outAt ?? 0;
    if (out >= start && now - out >= WAKE_QUIET_MS && now - start >= WAKE_MIN_MS) {
      if (await invoke<boolean>("agent_running", { id: tab.id }).catch(() => false)) return finish(true);
    }
    if (now - start >= WAKE_MAX_MS) return finish(false);
    window.setTimeout(look, 250); // runs only while a tab is waking
  };
  window.setTimeout(look, 250);
}
