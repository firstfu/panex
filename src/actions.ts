// What each shortcut action id does; the keyboard handler and menus call runAction.

import { invoke } from "@tauri-apps/api/core";
import { type LoadedConfig, type Tab } from "./types";
import { DEFAULTS } from "./settings";
import { S, activeTab, activeWs, wsOrder } from "./state";
import { applyConfig, setFontSize, showNotice, updateSettings } from "./config";
import { onInput } from "./terminal";
import { askCloseTab, askCloseWorkspaces, cycleTab, cycleWorkspace, jumpToUnread, moveTab, moveWorkspace, newTab, newWorkspace, showTab, showWorkspace } from "./workspaces";
import { openWorktreeDialog } from "./worktree-dialog";
import { openSshDialog } from "./ssh-dialog";
import { isGitOpen, setGitOpen } from "./git-panel";
import { openSearch } from "./search";
import { startRename } from "./rename";
import { closeSettings, openSettings, settingsEl } from "./settings-panel";

/** 1–8 pick that item, 9 always the last one (cmux / browser convention). */
const nth = <T,>(list: T[], n: number) => (n === 9 ? list[list.length - 1] : list[n - 1]);

export function copySelection(tab?: Tab) {
  if (!tab?.term.hasSelection()) return;
  navigator.clipboard.writeText(tab.term.getSelection()).catch(() => {});
  tab.term.clearSelection();
}

async function paste(tab?: Tab) {
  const text = await navigator.clipboard.readText().catch(() => "");
  if (text && tab) tab.term.paste(text);
}

/** Runs an action by id; `digit` is the 1–9 pressed for digit-family actions. */
export function runAction(id: string, digit = 0) {
  const tab = activeTab();
  const ws = activeWs();
  const wi = S.activeWsId ? wsOrder.indexOf(S.activeWsId) : -1;
  const ti = ws && S.visibleTabId ? ws.tabs.indexOf(S.visibleTabId) : -1;
  switch (id) {
    case "newWorkspace": return newWorkspace();
    case "newWorkspaceWithShell": return S.shells[digit - 1] && newWorkspace(S.shells[digit - 1].id);
    case "newWorktree": return openWorktreeDialog();
    case "newSsh": return openSshDialog();
    case "closeWorkspace": return S.activeWsId && askCloseWorkspaces([S.activeWsId]);
    case "renameWorkspace": return S.activeWsId && startRename("ws", S.activeWsId);
    case "selectWorkspaceByNumber": { const w = nth(wsOrder, digit); return w && showWorkspace(w); }
    case "nextWorkspace": return cycleWorkspace(1);
    case "prevWorkspace": return cycleWorkspace(-1);
    case "moveWorkspaceUp": return S.activeWsId && moveWorkspace(S.activeWsId, wi - 1);
    case "moveWorkspaceDown": return S.activeWsId && moveWorkspace(S.activeWsId, wi + 1);
    case "jumpToUnread": return jumpToUnread();
    case "newTab": return newTab();
    case "closeTab": return S.visibleTabId && askCloseTab(S.visibleTabId);
    case "renameTab": return S.visibleTabId && startRename("tab", S.visibleTabId);
    case "selectTabByNumber": { const t = ws && nth(ws.tabs, digit); return t && showTab(t); }
    case "nextTab": return cycleTab(1);
    case "prevTab": return cycleTab(-1);
    case "moveTabLeft": return S.visibleTabId && moveTab(S.visibleTabId, ti - 1);
    case "moveTabRight": return S.visibleTabId && moveTab(S.visibleTabId, ti + 1);
    case "toggleSidebar": return updateSettings({ sidebarHidden: !S.settings.sidebarHidden });
    case "toggleGitPanel": return setGitOpen(!isGitOpen());
    case "clearScrollback": return tab?.term.clear();
    case "find": return openSearch();
    case "copy": return copySelection(tab);
    case "paste": return paste(tab);
    case "insertNewline": return tab && onInput(tab, "\x1b\r");
    case "increaseFontSize": return setFontSize(S.settings.fontSize + 1);
    case "decreaseFontSize": return setFontSize(S.settings.fontSize - 1);
    case "resetFontSize": return updateSettings({ fontSize: DEFAULTS.fontSize });
    case "openSettings": return settingsEl.hidden ? openSettings() : closeSettings();
    case "openConfigFile": return invoke("config_open").catch((e) => showNotice(String(e)));
    case "reloadConfiguration": return invoke<LoadedConfig>("config_load").then(applyConfig);
  }
}
