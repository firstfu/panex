// Requests from `panex-cli open` (an agent in one tab starting another agent) and
// `panex-cli worktree-create` / `worktree-remove` (Claude Code's worktree hooks): the backend checks the token
// and hands them here because the frontend owns the layout. A tab `open` starts runs right away
// but stays in the background; the user sees it in the sidebar.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t as tr } from "./i18n";
import { type Workspace } from "./types";
import { basename, newId, newWsId } from "./util";
import { S, activeWs, tabs, workspaces, wsOrder } from "./state";
import { saveSession } from "./session";
import { createTab, refreshBranch, spawn } from "./terminal";
import { scheduleRender } from "./render";
import { addWorktree, worktreeSetup } from "./worktree-dialog";
import { groupLead, groupMembers, inFolder, insertInRepoGroup, tidyGroups } from "./groups";
import { closeTabs, showWorkspace } from "./workspaces";
import { workingTabs } from "./agent";

interface OpenArgs {
  cwd: string;
  from?: string; // tab that asked; the new workspace goes right below its workspace
  worktree?: string;
  base?: string;
  title?: string;
  command?: string;
}

/** Caller tab → the workspace it opened last. */
const lastOpened = new Map<string, string>();

async function open(a: OpenArgs) {
  let cwd = a.cwd;
  let copied: string[] = [];
  let repo: string | undefined;
  const input: string[] = [];
  if (a.worktree) {
    const wt = await addWorktree(cwd, a.worktree, a.base || null);
    cwd = wt.path;
    copied = wt.copied;
    repo = wt.repo;
    const setup = worktreeSetup();
    if (setup) input.push(setup);
  }
  if (a.command) input.push(a.command);

  const ws: Workspace = { id: newWsId(), tabs: [], customTitle: a.title || a.worktree || undefined };
  workspaces.set(ws.id, ws);
  // Below the caller's workspace, after the ones it opened before, so they keep their order.
  // A worktree joins its repo's group; anything else stays in the caller's group, if any.
  const from = a.from ?? "";
  const callerWs = tabs.get(from)?.wsId;
  const prev = lastOpened.get(from);
  const anchor = prev && workspaces.has(prev) ? prev : callerWs;
  if (repo) insertInRepoGroup(ws, repo, callerWs, anchor);
  else {
    ws.group = workspaces.get(callerWs ?? "")?.group;
    const after = wsOrder.indexOf(anchor ?? "");
    wsOrder.splice(after < 0 ? wsOrder.length : after + 1, 0, ws.id);
    tidyGroups();
  }
  lastOpened.set(from, ws.id);
  const tab = createTab({ id: newId(), shell: S.settings.defaultShell, cwd }, ws.id);
  ws.tabs.push(tab.id);
  ws.activeTab = tab.id;
  if (copied.length) tab.term.write(`\x1b[90m${tr("已複製：{files}", { files: copied.join(", ") })}\x1b[0m\r\n`);
  // The shell reads the lines one after another, so setup finishes before the command starts.
  if (input.length) tab.initialInput = input.join("\r");
  saveSession();
  scheduleRender();
  // Not shown, so start it here instead of on first view; xterm attaches when the user opens it.
  await spawn(tab);
  if (!tab.running) throw "the shell did not start";
  return { tab: tab.id, cwd };
}

interface WorktreeArgs {
  cwd: string; // the session's folder when Claude asked
  from: string; // tab Claude runs in
  name: string; // worktree name Claude picked, used as the branch name
  show: boolean; // false for a subagent's worktree: create it, leave the sidebar alone
}

/**
 * Claude Code wants a worktree (its WorktreeCreate hook): make it panex's way, next to the repo,
 * and move the tab Claude runs in to a new workspace for it under the repo's group, so the
 * conversation carries on there. The workspace it leaves gets a fresh shell in the old folder
 * instead of going away, so the repo's main workspace stays at the top of its group.
 * @returns `{ path }`, the worktree folder Claude Code moves the session into
 * @throws when git can't create the worktree (Claude Code then reports the failure)
 */
async function worktree(a: WorktreeArgs) {
  const wt = await addWorktree(a.cwd, a.name, null, true);
  const tab = tabs.get(a.from);
  const oldWs = workspaces.get(tab?.wsId ?? "");
  if (!a.show || !tab || !oldWs) return { path: wt.path };

  // Asked again for a worktree that already has a workspace (Claude resuming a session in it):
  // nothing to do when the tab is already there, else the tab joins that workspace.
  const at = (p?: string) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const existing = wsOrder.map((id) => workspaces.get(id)!).find((w) => w.tabs.some((t) => at(tabs.get(t)?.cwd) === at(wt.path)));
  if (existing?.id === oldWs.id) return { path: wt.path };
  let ws: Workspace;
  if (existing) ws = existing;
  else {
    ws = { id: newWsId(), tabs: [], customTitle: a.name };
    workspaces.set(ws.id, ws);
    // Before the tab moves: with no group yet, the caller's workspace joins one as a checkout of the repo.
    insertInRepoGroup(ws, wt.repo, oldWs.id, oldWs.id);
  }

  const oldCwd = tab.cwd;
  oldWs.tabs = oldWs.tabs.filter((id) => id !== tab.id);
  ws.tabs.push(tab.id);
  ws.activeTab = tab.id;
  tab.wsId = ws.id;
  // Claude moved, its shell didn't yet: followCwd has the shell cd there once Claude exits.
  Object.assign(tab, { cwd: wt.path, repo: wt.repo, worktree: true, branch: a.name, followCwd: wt.path });
  if (wt.copied.length) tab.term.write(`\x1b[90m${tr("已複製：{files}", { files: wt.copied.join(", ") })}\x1b[0m\r\n`);
  if (!oldWs.tabs.length) {
    const fresh = createTab({ id: newId(), shell: tab.shell, cwd: oldCwd }, oldWs.id);
    oldWs.tabs.push(fresh.id);
  }
  if (oldWs.activeTab === tab.id) oldWs.activeTab = oldWs.tabs[0];
  // Follow the conversation when the user was looking at it.
  if (activeWs()?.id === oldWs.id) showWorkspace(ws.id);
  saveSession();
  scheduleRender();
  return { path: wt.path };
}

interface WorktreeRemoveArgs {
  from: string; // Claude 所在的分頁
  path: string; // 要刪掉的 worktree 資料夾（panex-cli 等這裡回答後才刪）
}

/**
 * Claude Code 要刪掉一個 worktree（WorktreeRemove hook）：把 Claude 所在的分頁搬回 repo 的主工作區，
 * 再關掉其他開在那個資料夾裡的分頁，側欄才不會留下指向已刪資料夾的工作區，Windows 上也不會有 shell 卡住資料夾。
 * 沒有主工作區時，Claude 那個工作區留下來當 repo 的工作區。還有 agent 在跑的分頁不關：中斷別人的工作比多留一列糟。
 * @param a.from Claude 所在的分頁 id；不在 panex 的話只關其他分頁
 * @param a.path 要刪的 worktree 資料夾
 * @returns 空物件；刪資料夾是 panex-cli 的事，這裡不會失敗
 */
function worktreeRemove(a: WorktreeRemoveArgs) {
  const tab = tabs.get(a.from);
  const ws = workspaces.get(tab?.wsId ?? "");
  if (tab && ws && inFolder(tab.cwd, a.path)) {
    const group = ws.group;
    // 排除自己：Claude Code 預設的 .claude/worktrees 在主 checkout 底下，會被當成主工作區。
    const lead = group ? groupLead(group, groupMembers(group).filter((id) => id !== ws.id)) : undefined;
    const home = tab.repo ?? group;
    // shell 若還在 worktree 裡（重開 panex 後 shell 就是在那裡啟動的），Claude 結束後的提示字元會帶它 cd 回主 checkout。
    Object.assign(tab, { followCwd: undefined, worktree: false, branch: undefined, branchAt: undefined, cwd: home ?? tab.cwd });
    if (home) tab.leaveDir = { from: a.path, to: home };
    const leadWs = workspaces.get(lead ?? "");
    if (leadWs) {
      ws.tabs = ws.tabs.filter((id) => id !== tab.id);
      if (ws.activeTab === tab.id) ws.activeTab = ws.tabs[0];
      leadWs.tabs.push(tab.id);
      leadWs.activeTab = tab.id;
      tab.wsId = leadWs.id;
      // 使用者正看著這段對話就跟過去。
      if (activeWs()?.id === ws.id) showWorkspace(leadWs.id);
      if (!ws.tabs.length) {
        workspaces.delete(ws.id);
        wsOrder.splice(wsOrder.indexOf(ws.id), 1);
        tidyGroups();
      }
    } else if (ws.customTitle === basename(a.path)) {
      // 名字是 worktree 建立時取的，留著會誤導；清掉改回自動標題。
      ws.customTitle = undefined;
    }
    refreshBranch(tab);
  }
  const busy = new Set(workingTabs().map((t) => t.id));
  const stale = [...tabs.values()].filter((t) => t.id !== a.from && !t.ssh && !busy.has(t.id) && inFolder(t.cwd, a.path));
  if (stale.length) closeTabs(stale.map((t) => t.id));
  saveSession();
  scheduleRender();
  return {};
}

export function wireControl() {
  listen<{ req: number; op: string; args: any }>("ctl-request", async ({ payload: p }) => {
    let ok = true;
    let value: unknown;
    try {
      if (p.op === "open") value = await open(p.args);
      else if (p.op === "worktree") value = await worktree(p.args);
      else if (p.op === "worktree-remove") value = worktreeRemove(p.args);
      else throw "unknown request";
    } catch (e) {
      ok = false;
      value = String(e);
    }
    invoke("ctl_reply", { req: p.req, ok, value }).catch(() => {});
  });
}
