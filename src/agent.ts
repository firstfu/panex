// Agent state of a tab: running / needs you / done, notifications (badge, toast) and
// resuming the Claude Code session that was running when panex closed.

import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { type Status, type Tab } from "./types";
import { S, tabTitle, tabs, workspaces, wsTitle } from "./state";
import { saveSessionSoon } from "./session";
import { closeGitView } from "./git-panel";
import { scheduleRender } from "./render";

/** A restored or hibernated tab whose Claude Code was still running re-enters that session when its shell starts.
 *  A hibernated tab always does: the user never chose to leave that session. */
export function autoResume(tab: Tab) {
  if (!(S.settings.resumeSession || tab.hibernated) || !tab.agentSession || tab.agentLive || tab.initialInput) return;
  tab.initialInput = `claude --resume ${tab.agentSession}`;
  tab.agentLive = true;
  tab.skipPrompt = true; // the shell's own startup prompt is not Claude exiting
}

/** Claude Code is gone from this tab (shell prompt is back): don't re-enter it on the next start. */
export function endAgent(tab: Tab) {
  tab.agentLive = false;
  tab.agentSession = undefined;
  saveSessionSoon();
}

/** No agent is working in this tab any more: drop a "running" state that no Stop hook will end. */
export function endRun(tab: Tab) {
  if (tab.status !== "running") return;
  tab.status = "idle";
  tab.runStart = undefined;
  scheduleRender();
}

export function clearStatus(tab: Tab) {
  if (tab.status === "attention" || tab.status === "done") {
    tab.status = "idle";
    tab.note = undefined;
    scheduleRender();
  }
}

export function notify(tab: Tab, status: Status, note: string) {
  if (status === "running") {
    // Resuming after a question inside the turn keeps the turn's start time.
    if (tab.status !== "running" && !(tab.asking && tab.runStart !== undefined)) tab.runStart = Date.now();
    tab.status = "running";
    tab.note = undefined;
    tab.runMs = undefined;
    scheduleRender();
    return;
  }
  if (status === "done") {
    tab.runMs = tab.runStart ? Date.now() - tab.runStart : undefined;
    tab.runStart = undefined;
  }
  // A file diff or commit open over this tab hides the terminal, so the agent's request goes there.
  if (status === "attention" && tab.id === S.visibleTabId) closeGitView();
  // The user is already looking at this tab: no badge, no toast.
  if (S.focused && tab.id === S.visibleTabId) {
    if (status === "done") {
      tab.status = "idle";
      tab.note = undefined;
      scheduleRender();
    }
    return;
  }
  tab.status = status;
  tab.note = note;
  scheduleRender();
  const ws = workspaces.get(tab.wsId);
  const where = ws && ws.tabs.length > 1 ? `${wsTitle(ws)} › ${tabTitle(tab)}` : tabTitle(tab);
  if (!S.focused) invoke("alert", { title: `panex · ${where}`, body: note }).catch(() => {});
}

/**
 * Keys that change an agent's state without any hook: Claude Code reports neither an interrupted
 * turn (Esc / Ctrl+C) nor the user answering a permission prompt or question (Enter), so the key
 * itself does. The backend is told too, for `panex-cli wait`. A wrong guess (an Esc that only
 * closed a menu) is corrected by the agent's next hook.
 */
export function agentKey(tab: Tab, data: string) {
  if ((tab.status === "running" || tab.asking) && (data === "\x1b" || data === "\x03")) {
    tab.asking = false;
    notify(tab, "done", tr("已中斷"));
    invoke("agent_state", { id: tab.id, state: "done", message: "interrupted by the user" }).catch(() => {});
  } else if (tab.asking && data === "\r") {
    notify(tab, "running", "");
    tab.asking = false;
    invoke("agent_state", { id: tab.id, state: "running", message: "" }).catch(() => {});
  }
}

/** Tabs whose agent is mid-turn: running, or stopped on a question inside the turn. */
export function workingTabs(): Tab[] {
  return [...tabs.values()].filter((t) => t.status === "running" || (t.status === "attention" && t.runStart !== undefined));
}
