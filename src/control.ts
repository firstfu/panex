// Requests from `panex-cli open` (an agent in one tab starting another agent): the backend
// checks the token and hands them here because the frontend owns the layout. The new tab
// starts right away but stays in the background; the user sees it in the sidebar.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t as tr } from "./i18n";
import { type Workspace } from "./types";
import { newId, newWsId } from "./util";
import { S, tabs, workspaces, wsOrder } from "./state";
import { saveSession } from "./session";
import { createTab, spawn } from "./terminal";
import { scheduleRender } from "./render";
import { addWorktree, worktreeSetup } from "./worktree-dialog";
import { insertInRepoGroup, tidyGroups } from "./groups";

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

export function wireControl() {
  listen<{ req: number; op: string; args: any }>("ctl-request", async ({ payload: p }) => {
    let ok = true;
    let value: unknown;
    try {
      if (p.op !== "open") throw "unknown request";
      value = await open(p.args);
    } catch (e) {
      ok = false;
      value = String(e);
    }
    invoke("ctl_reply", { req: p.req, ok, value }).catch(() => {});
  });
}
