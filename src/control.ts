// Requests from `panex-cli open` (an agent in one tab starting another agent) and
// `panex-cli worktree-create` (Claude Code's WorktreeCreate hook): the backend checks the token
// and hands them here because the frontend owns the layout. A tab `open` starts runs right away
// but stays in the background; the user sees it in the sidebar.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t as tr } from "./i18n";
import { type Workspace } from "./types";
import { newId, newWsId } from "./util";
import { S, activeWs, tabs, workspaces, wsOrder } from "./state";
import { saveSession } from "./session";
import { createTab, spawn } from "./terminal";
import { scheduleRender } from "./render";
import { addWorktree, worktreeSetup } from "./worktree-dialog";
import { insertInRepoGroup, tidyGroups } from "./groups";
import { showWorkspace } from "./workspaces";

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

export function wireControl() {
  listen<{ req: number; op: string; args: any }>("ctl-request", async ({ payload: p }) => {
    let ok = true;
    let value: unknown;
    try {
      if (p.op === "open") value = await open(p.args);
      else if (p.op === "worktree") value = await worktree(p.args);
      else throw "unknown request";
    } catch (e) {
      ok = false;
      value = String(e);
    }
    invoke("ctl_reply", { req: p.req, ok, value }).catch(() => {});
  });
}
