// App state shared by all modules: the tabs and workspaces, which one is on screen, the
// loaded settings and bindings. Values other modules replace live on `S`, because an ES
// module can't reassign another module's `let`. Also the derived getters (titles, status).

import { t as tr } from "./i18n";
import { resolveBindings } from "./keys";
import { type ShellInfo, type Status, type Tab, type Workspace } from "./types";
import { DEFAULTS, type Settings } from "./settings";
import { basename } from "./util";

export const tabs = new Map<string, Tab>();
export const workspaces = new Map<string, Workspace>();
export const wsOrder: string[] = [];

/** State that several modules replace (not just mutate). */
export const S = {
  activeWsId: undefined as string | undefined,
  visibleTabId: undefined as string | undefined,
  settings: { ...DEFAULTS } as Settings,
  rawConfig: {} as any,
  configPath: "",
  bindings: resolveBindings(undefined),
  focused: document.hasFocus(),
  shells: [] as ShellInfo[],
  renaming: undefined as { kind: "ws" | "tab"; id: string } | undefined,
};

// Loudest first: a workspace shows the most urgent state among its tabs.
const STATUS_RANK: Record<Status, number> = { attention: 3, done: 2, running: 1, idle: 0 };

export const shellName = (id: string) => tr(S.shells.find((s) => s.id === id)?.name ?? id);
export const shellTag = (id: string) => (id === "cmd" ? "cmd" : id === "default" ? "sh" : id === "ssh" ? "SSH" : "PS");
export const activeTab = () => (S.visibleTabId ? tabs.get(S.visibleTabId) : undefined);
export const activeWs = () => (S.activeWsId ? workspaces.get(S.activeWsId) : undefined);
export const wsActiveTab = (ws: Workspace) => tabs.get(ws.activeTab ?? "") ?? tabs.get(ws.tabs[0] ?? "");

export function autoTabTitle(tab: Tab): string {
  const t = tab.progTitle?.trim();
  // Shells set their title to an exe path or their own name; a cwd is more useful there.
  if (t && !/^[A-Za-z]:\\/.test(t) && !/\.exe$/i.test(t) && !/^(Windows PowerShell|PowerShell|系統管理員|Administrator)/.test(t)) {
    return t;
  }
  return tab.ssh ?? (tab.cwd ? basename(tab.cwd) : shellName(tab.shell));
}

export const tabTitle = (tab: Tab) => tab.customTitle || autoTabTitle(tab);

export function wsTitle(ws: Workspace): string {
  if (ws.customTitle) return ws.customTitle;
  const t = wsActiveTab(ws);
  return t ? tabTitle(t) : tr("工作區");
}

/** The loudest status among a workspace's tabs, with the tab it comes from. */
export function wsStatus(ws: Workspace): { status: Status; tab?: Tab } {
  let best: Tab | undefined;
  for (const id of ws.tabs) {
    const t = tabs.get(id);
    if (t && (!best || STATUS_RANK[t.status] > STATUS_RANK[best.status])) best = t;
  }
  return { status: best?.status ?? "idle", tab: best };
}

/** The loudest status among several workspaces (a collapsed sidebar group). */
export function loudest(ids: string[]): Status {
  let best: Status = "idle";
  for (const id of ids) {
    const ws = workspaces.get(id);
    const s = ws ? wsStatus(ws).status : "idle";
    if (STATUS_RANK[s] > STATUS_RANK[best]) best = s;
  }
  return best;
}
