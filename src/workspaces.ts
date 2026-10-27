// Workspaces and tabs: showing, creating, closing (with the agent-at-work check), cycling,
// reordering, colors and jumping to the tab that needs attention.

import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { type Tab, type Workspace } from "./types";
import { newId, newWsId } from "./util";
import { S, activeTab, activeWs, tabs, workspaces, wsActiveTab, wsOrder } from "./state";
import { saveSession } from "./session";
import { attachWebgl, createTab, disposeTab, spawn } from "./terminal";
import { clearStatus, workingTabs } from "./agent";
import { closeGitView, isGitOpen, renderGitPanel, scheduleGit } from "./git-panel";
import { closeSearch } from "./search";
import { scheduleRender } from "./render";
import { openCloseAsk } from "./close-ask";
import { setCollapsed, tidyGroups } from "./groups";
import { canHide, isHidden, setHidden, visibleOrder } from "./hidden";

/** Shows a tab (switching workspace if needed). Only the visible tab keeps a WebGL context. */
export function showTab(id: string) {
  const tab = tabs.get(id);
  const ws = tab && workspaces.get(tab.wsId);
  if (!tab || !ws) return;
  if (S.visibleTabId && S.visibleTabId !== id) {
    const prev = tabs.get(S.visibleTabId);
    if (prev) {
      prev.el.hidden = true;
      // Browsers cap live WebGL contexts (~16); only the visible tab keeps one.
      prev.webgl?.dispose();
      prev.webgl = undefined;
    }
  }
  S.visibleTabId = id;
  S.activeWsId = ws.id;
  if (ws.group) setCollapsed(ws.group, false);
  if (isHidden(ws.id)) setHidden([ws.id], false); // showing a workspace means wanting to see it
  ws.activeTab = id;
  tab.el.hidden = false;
  if (!tab.opened) {
    tab.term.open(tab.el);
    tab.opened = true;
  }
  attachWebgl(tab);
  tab.fit.fit();
  // Restored tabs start their shell only when first viewed.
  if (!tab.running && !tab.exited) spawn(tab);
  closeGitView(false);
  closeSearch(false);
  if (!S.renaming) tab.term.focus();
  if (S.focused) clearStatus(tab);
  if (isGitOpen() || tab.gitStale) scheduleGit(tab);
  renderGitPanel();
  saveSession();
  scheduleRender();
}

export function showWorkspace(wsId: string) {
  const ws = workspaces.get(wsId);
  const tab = ws && wsActiveTab(ws);
  if (tab) showTab(tab.id);
}

export function newWorkspace(shell = S.settings.defaultShell) {
  const ws: Workspace = { id: newWsId(), tabs: [] };
  workspaces.set(ws.id, ws);
  wsOrder.push(ws.id);
  const tab = createTab({ id: newId(), shell, cwd: activeTab()?.cwd }, ws.id);
  ws.tabs.push(tab.id);
  showTab(tab.id);
}

/** New tab in the current workspace, right after the visible one, in the same folder (or on the same SSH host). */
export function newTab(shell = S.settings.defaultShell) {
  const ws = activeWs();
  if (!ws) return newWorkspace(shell);
  const cur = activeTab();
  const tab = createTab(cur?.ssh ? { id: newId(), shell: "ssh", ssh: cur.ssh } : { id: newId(), shell, cwd: cur?.cwd }, ws.id);
  const at = cur ? ws.tabs.indexOf(cur.id) + 1 : ws.tabs.length;
  ws.tabs.splice(at, 0, tab.id);
  showTab(tab.id);
}

/** Closes tabs; a workspace left empty goes too, and the last workspace is replaced by a fresh one. */
export function closeTabs(ids: string[]) {
  const gone = ids.map((id) => tabs.get(id)).filter((t): t is Tab => !!t);
  if (!gone.length) return;
  const wasVisible = S.visibleTabId;
  const visibleWs = S.activeWsId;
  const visibleWsIndex = visibleWs ? wsOrder.indexOf(visibleWs) : 0;
  let visibleTabIndex = 0;
  for (const tab of gone) {
    const ws = workspaces.get(tab.wsId)!;
    const i = ws.tabs.indexOf(tab.id);
    if (tab.id === wasVisible) visibleTabIndex = i;
    ws.tabs.splice(i, 1);
    if (ws.activeTab === tab.id) ws.activeTab = ws.tabs[Math.min(i, ws.tabs.length - 1)];
    disposeTab(tab);
    if (!ws.tabs.length) {
      workspaces.delete(ws.id);
      wsOrder.splice(wsOrder.indexOf(ws.id), 1);
      if (S.renaming?.id === ws.id) S.renaming = undefined;
    }
  }
  tidyGroups();
  // Save the layout without these tabs before the backend deletes their scrollback,
  // so a snapshot that is still in flight can't write the file back.
  if (!S.visibleTabId) {
    const ws = visibleWs && workspaces.get(visibleWs);
    if (ws) showTab(ws.tabs[Math.min(visibleTabIndex, ws.tabs.length - 1)]);
    else if (wsOrder.length) showWorkspace(wsOrder[Math.min(visibleWsIndex, wsOrder.length - 1)]);
    else {
      S.activeWsId = undefined;
      newWorkspace();
    }
  } else {
    saveSession();
  }
  for (const tab of gone) invoke("tab_close", { id: tab.id }).catch(() => {});
  scheduleRender();
}

export const closeTab = (id: string) => closeTabs([id]);

/** User-initiated close: asks first when one of the tabs has an agent mid-turn. */
export function askCloseTabs(ids: string[]) {
  const set = new Set(ids);
  const working = workingTabs().filter((t) => set.has(t.id));
  if (S.settings.confirmClose && working.length) {
    openCloseAsk(working, tr("關閉分頁會中斷它們正在做的這一輪，而且不會自動接回對話。"), () => closeTabs(ids));
  } else closeTabs(ids);
}
export const askCloseTab = (id: string) => askCloseTabs([id]);
export const askCloseWorkspaces = (ids: string[]) => askCloseTabs(ids.flatMap((id) => workspaces.get(id)?.tabs ?? []));

export function cycleWorkspace(dir: number) {
  const order = visibleOrder();
  if (!S.activeWsId || order.length < 2) return;
  const i = order.indexOf(S.activeWsId);
  showWorkspace(order[(i + dir + order.length) % order.length]);
}

/**
 * Takes workspaces off the sidebar list. When the one on screen goes, the nearest workspace that
 * stays takes its place first (its terminal keeps running either way). The last visible one can't be hidden.
 */
export function hideWorkspaces(ids: string[]) {
  if (!canHide(ids)) return;
  if (S.activeWsId && ids.includes(S.activeWsId)) {
    const order = visibleOrder();
    const i = order.indexOf(S.activeWsId);
    const next = order.slice(i + 1).find((id) => !ids.includes(id)) ?? order.slice(0, i).reverse().find((id) => !ids.includes(id));
    if (next) showWorkspace(next);
  }
  setHidden(ids, true);
}

export function cycleTab(dir: number) {
  const ws = activeWs();
  if (!ws || !S.visibleTabId || ws.tabs.length < 2) return;
  const i = ws.tabs.indexOf(S.visibleTabId);
  showTab(ws.tabs[(i + dir + ws.tabs.length) % ws.tabs.length]);
}


function moveIn(list: string[], id: string, to: number) {
  const from = list.indexOf(id);
  to = Math.max(0, Math.min(list.length - 1, to));
  if (from < 0 || from === to) return false;
  list.splice(from, 1);
  list.splice(to, 0, id);
  saveSession();
  scheduleRender();
  return true;
}

export function moveTab(id: string, to: number) {
  const ws = workspaces.get(tabs.get(id)?.wsId ?? "");
  if (ws) moveIn(ws.tabs, id, to);
}

export function jumpToUnread() {
  const all = wsOrder.flatMap((w) => workspaces.get(w)!.tabs.map((t) => tabs.get(t)!));
  const t = all.find((t) => t.status === "attention") ?? all.find((t) => t.status === "done");
  if (t) showTab(t.id);
}

export function setColor(ws: Workspace, color?: string) {
  ws.color = color;
  saveSession();
  scheduleRender();
}
