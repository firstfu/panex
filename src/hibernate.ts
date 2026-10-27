// Hibernating tabs (Windows only): ending a hidden tab's shell, Claude Code and MCP servers to
// give their memory back, while the tab and its scrollback stay. Viewing the tab again starts
// the shell in the same folder and `claude --resume`s the session (spawn → autoResume).
// Automatic hibernation is a one-shot timer per tab, armed only while the tab is out of sight
// with its agent idle; an idle app with no such tab runs no timer.

import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { type Tab } from "./types";
import { S, tabs } from "./state";
import { spawn } from "./terminal";
import { scheduleRender } from "./render";
import { IS_WIN } from "./platform";

/** Whether the tab can be hibernated by hand right now: hidden, with a local shell running. */
export function canHibernate(tab: Tab) {
  return IS_WIN && tab.running && !tab.hibernated && !tab.ssh && tab.id !== S.visibleTabId;
}

/** Whether the tab's agent is idle enough to hibernate without asking: not mid-turn and not
 *  waiting on a permission prompt or question. Claude's "waiting for your input" reminder
 *  (idle_prompt) also lights the tab as attention, so that status alone doesn't count. */
function agentIdle(tab: Tab) {
  return !!tab.agentLive && !!tab.agentSession && tab.status !== "running" && !tab.asking;
}

/**
 * Hibernates a tab.
 * @param auto from the idle timer: then only a tab whose agent is idle, and only when the
 *   backend finds nothing in the tab but that Claude Code (no dev server, no background task)
 */
export async function hibernate(tab: Tab, auto = false) {
  const retried = tab.sleepRetried;
  cancelHibernate(tab);
  if (!canHibernate(tab) || (auto && !agentIdle(tab))) return;
  const ok = await invoke<boolean>("pty_hibernate", { id: tab.id, onlyAgent: auto }).catch(() => false);
  if (!tabs.has(tab.id)) return;
  if (!ok) {
    // Something else was running in the tab; it may have been passing (a hook, the status line),
    // so look once more a countdown later, then leave the tab alone until its next event.
    if (auto && !retried) startCountdown(tab, true);
    return;
  }
  tab.running = false;
  tab.hibernated = true;
  // Claude is gone with the shell; the session id stays so the next start resumes it.
  tab.agentLive = false;
  tab.skipPrompt = false;
  const time = new Date().toLocaleString("zh-TW", { hour12: false });
  const resume = tab.agentSession ? tr("，切回來時會接回 Claude Code") : tr("，切回來時會重新啟動 shell");
  tab.term.write(`\x1b[0m\r\n\x1b[90m${tr("── 已休眠（{time}）{resume} ──", { time, resume })}\x1b[0m\r\n`);
  // Shown again while the backend was ending it: wake it right away.
  if (S.visibleTabId === tab.id) spawn(tab);
  scheduleRender();
}

/** Hibernates the given tabs that can be; returns how many were asked to. */
export function hibernateTabs(list: Tab[]) {
  const ok = list.filter(canHibernate);
  for (const tab of ok) void hibernate(tab);
  return ok.length;
}

/**
 * Starts the tab's idle countdown when it qualifies, and stops it when it no longer does.
 * A countdown already running is left alone: it counts from when the tab went idle, and
 * Claude's own reminders (idle_prompt) must not keep pushing it back.
 */
export function armHibernate(tab: Tab) {
  if (!S.settings.hibernateMinutes || !canHibernate(tab) || !agentIdle(tab)) return cancelHibernate(tab);
  if (tab.sleepTimer === undefined) startCountdown(tab, false);
}

function startCountdown(tab: Tab, retry: boolean) {
  tab.sleepRetried = retry;
  tab.sleepTimer = window.setTimeout(() => {
    tab.sleepTimer = undefined;
    if (S.settings.hibernateMinutes && tabs.has(tab.id)) void hibernate(tab, true);
  }, S.settings.hibernateMinutes * 60_000);
}

export function cancelHibernate(tab: Tab) {
  clearTimeout(tab.sleepTimer);
  tab.sleepTimer = undefined;
  tab.sleepRetried = false;
}
