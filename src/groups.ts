// Sidebar groups: the workspaces of one repo's checkouts (its main folder and its worktrees)
// sit together in wsOrder under a collapsible header. A workspace's `group` is the main
// checkout's path; it is set when a worktree is opened (or from the menu) and stays put when
// the shell cd's elsewhere, so a workspace never jumps between groups on its own.
// Invariants, restored by tidyGroups: a group has two or more workspaces, and they are adjacent.

import { type Workspace } from "./types";
import { basename } from "./util";
import { tabs, workspaces, wsOrder } from "./state";
import { saveSession } from "./session";
import { scheduleRender } from "./render";

const CI = !/Mac|Linux/.test(navigator.userAgent); // Windows paths are case-insensitive
export const repoKey = (p?: string) => (p ? (CI ? p.toLowerCase() : p) : "");
export const sameRepo = (a?: string, b?: string) => !!a && repoKey(a) === repoKey(b);
export const repoName = (repo: string) => basename(repo);

/**
 * 群組標題要顯示的名字：主 checkout 那個工作區被使用者取過名就用它（例如「老犬」），否則用 repo 資料夾名。
 * 只認使用者自訂的名字，因為自動標題會跟著終端機標題一直變，標題列會跳來跳去。
 * @param group 群組的 key（主 checkout 的路徑）
 * @param members 群組內的工作區 id
 * @returns 顯示用的名字
 */
export function groupName(group: string, members: string[]): string {
  for (const id of members) {
    const ws = workspaces.get(id);
    const main = ws?.tabs.some((t) => {
      const tab = tabs.get(t);
      return !!tab && !tab.worktree && sameRepo(tab.repo, group);
    });
    if (main && ws?.customTitle) return ws.customTitle;
  }
  return repoName(group);
}

/** The group's workspaces in sidebar order. */
export const groupMembers = (group: string) => wsOrder.filter((id) => sameRepo(workspaces.get(id)?.group, group));

/** Top-level runs in sidebar order: a workspace outside any group, or a whole group. */
export function units(): string[][] {
  const out: string[][] = [];
  for (const id of wsOrder) {
    const last = out[out.length - 1];
    const g = workspaces.get(id)?.group;
    if (g && last && sameRepo(workspaces.get(last[0])?.group, g)) last.push(id);
    else out.push([id]);
  }
  return out;
}

/** Drops groups left with one workspace and gathers each group at its first workspace's place. */
export function tidyGroups() {
  const count = new Map<string, number>();
  for (const id of wsOrder) {
    const k = repoKey(workspaces.get(id)?.group);
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of wsOrder) {
    const ws = workspaces.get(id)!;
    const k = repoKey(ws.group);
    if (k && count.get(k)! < 2) ws.group = undefined;
    if (!ws.group) out.push(id);
    else if (!seen.has(k)) {
      seen.add(k);
      out.push(...groupMembers(ws.group));
    }
  }
  wsOrder.splice(0, wsOrder.length, ...out);
}

/** Whether any of the workspace's tabs is a checkout of `repo`. */
export const inRepo = (ws: Workspace, repo: string) => ws.tabs.some((id) => sameRepo(tabs.get(id)?.repo, repo));

/**
 * Adds a new worktree workspace (not yet in wsOrder) to `repo`'s group. With no group yet, the
 * repo's other ungrouped checkouts (the workspace it was opened from, earlier worktrees) start
 * one with it. It goes right after `after` when that is in the group, else at the group's end.
 */
export function insertInRepoGroup(ws: Workspace, repo: string, from?: string, after?: string) {
  if (!groupMembers(repo).length) {
    for (const id of wsOrder) {
      const w = workspaces.get(id)!;
      if (!w.group && inRepo(w, repo)) w.group = repo;
    }
  }
  const members = groupMembers(repo);
  ws.group = members.length ? workspaces.get(members[0])!.group : repo;
  const at = after && members.includes(after) ? after : members[members.length - 1] ?? from;
  const i = wsOrder.indexOf(at ?? "");
  wsOrder.splice(i < 0 ? wsOrder.length : i + 1, 0, ws.id);
  tidyGroups();
}

/** Puts `ids` (ungrouped ones) into one group for `repo`, joining an existing one at its end. */
export function joinGroup(ids: string[], repo: string) {
  const members = groupMembers(repo);
  const group = members.length ? workspaces.get(members[0])!.group! : repo;
  for (const id of ids) workspaces.get(id)!.group = group;
  if (members.length) placeRun(ids, members, true);
  tidyGroups();
  saveSession();
  scheduleRender();
}

export function leaveGroup(id: string) {
  const ws = workspaces.get(id);
  if (!ws?.group) return;
  const members = groupMembers(ws.group);
  ws.group = undefined;
  placeRun([id], members.filter((m) => m !== id), true);
  tidyGroups();
  saveSession();
  scheduleRender();
}

export function ungroup(group: string) {
  for (const id of groupMembers(group)) workspaces.get(id)!.group = undefined;
  saveSession();
  scheduleRender();
}

/** Moves a run of workspaces (one, or a whole group) just before or after another run. */
export function placeRun(run: string[], target: string[], after: boolean) {
  const rest = wsOrder.filter((id) => !run.includes(id));
  const anchor = rest.indexOf(after ? target[target.length - 1] : target[0]);
  if (anchor < 0) return false;
  rest.splice(after ? anchor + 1 : anchor, 0, ...run);
  if (rest.every((id, i) => id === wsOrder[i])) return false;
  wsOrder.splice(0, wsOrder.length, ...rest);
  saveSession();
  scheduleRender();
  return true;
}

/** What a workspace moves among: the other members of its group, or the top-level runs. */
function siblings(id: string): string[][] {
  const g = workspaces.get(id)?.group;
  return g ? groupMembers(g).map((m) => [m]) : units();
}
const runIndex = (list: string[][], id: string) => list.findIndex((r) => r.includes(id));

/** Whether a workspace (or, with `whole`, its group) can move one step up (-1) or down (1). */
export function canMove(id: string, dir: number, whole = false) {
  const list = whole ? units() : siblings(id);
  const i = runIndex(list, id) + dir;
  return i >= 0 && i < list.length;
}

/** One step up or down: within its group, or past a whole group outside of one. */
export function moveBy(id: string, dir: number, whole = false) {
  const list = whole ? units() : siblings(id);
  const i = runIndex(list, id);
  const target = list[i + dir];
  return !!target && placeRun(list[i], target, dir > 0);
}

export function moveToTop(id: string, whole = false) {
  const list = whole ? units() : siblings(id);
  const i = runIndex(list, id);
  return i > 0 && placeRun(list[i], list[0], false);
}

// Collapsed groups are a per-machine view preference, like the sidebar width.
const COLLAPSED_KEY = "panex.collapsedGroups";
let collapsed: Set<string> | undefined;
function collapsedSet() {
  if (!collapsed) {
    try {
      collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
    } catch {
      collapsed = new Set();
    }
  }
  return collapsed;
}
export const isCollapsed = (group: string) => collapsedSet().has(repoKey(group));
export function setCollapsed(group: string, on: boolean) {
  const set = collapsedSet();
  if (on === set.has(repoKey(group))) return;
  if (on) set.add(repoKey(group));
  else set.delete(repoKey(group));
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch { /* storage unavailable */ }
  scheduleRender();
}
