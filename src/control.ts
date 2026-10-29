// Requests from `panex-cli open` (an agent in one tab starting another agent) and
// `panex-cli worktree-create` / `worktree-remove` (Claude Code's worktree hooks): the backend checks the token
// and hands them here because the frontend owns the layout. A tab `open` starts runs right away
// but stays in the background; the user sees it in the sidebar. `list` / `wake` / `send` let a
// control tab's agent (reached from the phone) look at, wake and message the other tabs.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t as tr } from "./i18n";
import { type Tab, type Workspace } from "./types";
import { basename, newId, newWsId } from "./util";
import { S, activeWs, tabTitle, tabs, workspaces, wsOrder, wsTitle } from "./state";
import { saveSession } from "./session";
import { createTab, refreshBranch, spawn } from "./terminal";
import { scheduleRender } from "./render";
import { addWorktree, worktreeSetup } from "./worktree-dialog";
import { groupLead, groupMembers, inFolder, insertInRepoGroup, tidyGroups } from "./groups";
import { closeTabs, showWorkspace } from "./workspaces";
import { notify, workingTabs } from "./agent";
import { armHibernate, wake } from "./hibernate";
import { cleanText, matchTargets } from "./remote";

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
  const tab = await openWorkspace({ cwd, from: a.from ?? "", title: a.title || a.worktree, repo, copied, input });
  return { tab: tab.id, cwd };
}

interface NewWorkspace {
  cwd: string;
  from: string; // tab that asked; the new workspace goes right below its workspace
  title?: string;
  repo?: string; // main checkout, when cwd is a worktree of it
  copied: string[]; // files copied into the worktree, noted in the new tab
  input: string[]; // lines typed into the shell once it starts
}

/**
 * Opens a workspace with one shell below the caller's and starts it without switching to it.
 * @returns the new tab
 * @throws when the shell does not start
 */
async function openWorkspace(o: NewWorkspace) {
  const ws: Workspace = { id: newWsId(), tabs: [], customTitle: o.title || undefined };
  workspaces.set(ws.id, ws);
  // Below the caller's workspace, after the ones it opened before, so they keep their order.
  // A worktree joins its repo's group; anything else stays in the caller's group, if any.
  const callerWs = tabs.get(o.from)?.wsId;
  const prev = lastOpened.get(o.from);
  const anchor = prev && workspaces.has(prev) ? prev : callerWs;
  if (o.repo) insertInRepoGroup(ws, o.repo, callerWs, anchor);
  else {
    ws.group = workspaces.get(callerWs ?? "")?.group;
    const after = wsOrder.indexOf(anchor ?? "");
    wsOrder.splice(after < 0 ? wsOrder.length : after + 1, 0, ws.id);
    tidyGroups();
  }
  lastOpened.set(o.from, ws.id);
  const tab = createTab({ id: newId(), shell: S.settings.defaultShell, cwd: o.cwd }, ws.id);
  ws.tabs.push(tab.id);
  ws.activeTab = tab.id;
  if (o.copied.length) tab.term.write(`\x1b[90m${tr("已複製：{files}", { files: o.copied.join(", ") })}\x1b[0m\r\n`);
  // The shell reads the lines one after another, so setup finishes before the command starts.
  if (o.input.length) tab.initialInput = o.input.join("\r");
  saveSession();
  scheduleRender();
  // Not shown, so start it here instead of on first view; xterm attaches when the user opens it.
  await spawn(tab);
  if (!tab.running) throw "the shell did not start";
  return tab;
}

interface WorktreeArgs {
  cwd: string; // the session's folder when Claude asked
  from: string; // tab Claude runs in
  name: string; // worktree name Claude picked, used as the branch name
  show: boolean; // false for a subagent's worktree: create it, leave the sidebar alone
}

/**
 * Claude Code wants a worktree (its WorktreeCreate hook): make it panex's way, next to the repo,
 * and give the folder its own workspace (a shell in it) under the repo's group. The tab Claude
 * runs in stays where it is: the conversation belongs to the workspace it was started in, and the
 * worktree is another folder, shown as its own row the user can open to run or look at things there.
 * @returns `{ path }`, the worktree folder Claude Code moves the session into
 * @throws when git can't create the worktree (Claude Code then reports the failure)
 */
async function worktree(a: WorktreeArgs) {
  const wt = await addWorktree(a.cwd, a.name, null, true);
  if (!a.show || !tabs.has(a.from)) return { path: wt.path };
  // Asked again for a worktree that already has a tab (Claude resuming a session in it): keep that one.
  if ([...tabs.values()].some((t) => inFolder(t.cwd, wt.path))) return { path: wt.path };
  const setup = worktreeSetup();
  await openWorkspace({ cwd: wt.path, from: a.from, title: a.name, repo: wt.repo, copied: wt.copied, input: setup ? [setup] : [] });
  return { path: wt.path };
}

interface WorktreeRemoveArgs {
  from: string; // Claude 所在的分頁
  path: string; // 要刪掉的 worktree 資料夾（panex-cli 等這裡回答後才刪）
}

/**
 * Claude Code 要刪掉一個 worktree（WorktreeRemove hook）：關掉開在那個資料夾裡的分頁（worktree 建立時開的工作區），
 * 若 Claude 所在的分頁本身就在那個資料夾裡（在 worktree 裡啟動的 claude、或舊版搬過去的分頁）則搬回 repo 的主工作區，
 * 側欄才不會留下指向已刪資料夾的工作區，Windows 上也不會有 shell 卡住資料夾。
 * @param a.from Claude 所在的分頁 id；不在 panex 的話只關其他分頁
 * @param a.path 要刪的 worktree 資料夾
 * @returns 空物件；刪資料夾是 panex-cli 的事，這裡不會失敗
 */
function worktreeRemove(a: WorktreeRemoveArgs) {
  const tab = tabs.get(a.from);
  const keep = new Set<string>();
  if (tab && inFolder(tab.cwd, a.path)) {
    moveHome(tab, a.path);
    keep.add(tab.id);
  }
  closeInside(a.path, keep);
  saveSession();
  scheduleRender();
  return {};
}

/**
 * 分頁所在的 worktree 要刪或已刪：把它搬回 repo 群組的主工作區；沒有主工作區就留在原工作區、清掉 worktree 取的名字。
 * shell 若還在 worktree 裡，下一個提示字元會帶它 cd 回主 checkout。
 * @param tab 要搬的分頁（通常是還開著 Claude 的那個）
 * @param path worktree 資料夾
 */
function moveHome(tab: Tab, path: string) {
  const ws = workspaces.get(tab.wsId);
  if (!ws) return;
  const group = ws.group;
  // 排除自己：Claude Code 預設的 .claude/worktrees 在主 checkout 底下，會被當成主工作區。
  const lead = group ? groupLead(group, groupMembers(group).filter((id) => id !== ws.id)) : undefined;
  const home = tab.repo ?? group;
  Object.assign(tab, { worktree: false, branch: undefined, branchAt: undefined, cwd: home ?? tab.cwd });
  if (home) tab.leaveDir = { from: path, to: home };
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
  } else if (ws.customTitle === basename(path)) {
    // 名字是 worktree 建立時取的，留著會誤導；清掉改回自動標題。
    ws.customTitle = undefined;
  }
  refreshBranch(tab);
}

/**
 * 關掉開在 `path` 裡的分頁（空掉的工作區跟著消失）。還有 agent 在跑的不關：中斷別人的工作比多留一列糟。
 * @param path worktree 資料夾
 * @param keep 不關的分頁 id
 */
function closeInside(path: string, keep: Set<string>) {
  const busy = new Set(workingTabs().map((t) => t.id));
  const stale = [...tabs.values()].filter((t) => !keep.has(t.id) && !t.ssh && !busy.has(t.id) && inFolder(t.cwd, path));
  if (stale.length) closeTabs(stale.map((t) => t.id));
}

// `panex-cli list` / `wake` / `send`: a control tab's agent (the one the user reaches from the
// phone) looks at the other tabs, wakes hibernated ones and passes them a message.

/** Every tab in sidebar order, with the names `matchTargets` looks at. */
function targets() {
  return wsOrder.flatMap((wid) => {
    const ws = workspaces.get(wid)!;
    return ws.tabs.map((id) => {
      const tab = tabs.get(id)!;
      return { id, tab, workspace: wsTitle(ws), title: tabTitle(tab), folder: tab.cwd ? basename(tab.cwd) : "" };
    });
  });
}

type Target = ReturnType<typeof targets>[number];

/** @throws when no tab matches */
function find(target: string) {
  const hits = matchTargets(targets(), target);
  if (!hits.length) throw `no tab matches "${target}"; see panex-cli list`;
  return hits;
}

const hasClaude = (t: Tab) => !!(t.agentLive || t.agentSession);

function claudeState(t: Tab) {
  if (!hasClaude(t)) return "none";
  if (t.asking) return "needs-input";
  return t.status === "running" ? "running" : "idle";
}

function list(a: { from?: string }) {
  return {
    tabs: targets().map(({ id, tab, workspace, title }) => ({
      tab: id,
      workspace,
      title,
      cwd: tab.cwd ?? null,
      shell: tab.hibernated ? "asleep" : tab.running ? "running" : "stopped",
      claude: claudeState(tab),
      message: tab.note ?? "",
      noSleep: !!tab.noSleep,
      self: id === a.from,
    })),
  };
}

async function wakeTabs(a: { targets: string[]; from?: string }) {
  if (!a.targets?.length) throw "give a tab id or name";
  const hits = new Map<string, Target>();
  for (const target of a.targets) for (const t of find(target)) hits.set(t.id, t);
  const out = [];
  for (const t of hits.values()) {
    const woke = await wake(t.tab);
    // `claude --resume` sends no hook, so nothing else would start its idle countdown.
    if (woke) armHibernate(t.tab);
    out.push({ tab: t.id, workspace: t.workspace, title: t.title, state: woke ? "woken" : "already-running" });
  }
  return { tabs: out };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until a just-started tab has gone quiet: the shell, then `claude --resume` drawing its
 * screen. Text typed earlier could reach the shell instead of Claude Code.
 * @throws when the shell ends, or it is still busy after 45 s (under the backend's 60 s)
 */
async function settle(tab: Tab) {
  const start = Date.now();
  while (Date.now() - start < 45_000) {
    await pause(250);
    if (!tab.running) throw "the tab's shell ended while starting";
    const out = tab.outAt ?? 0;
    if (out >= start && Date.now() - out >= 2000 && Date.now() - start >= 4000) return;
  }
  throw "Claude Code is still starting in that tab; send again in a moment";
}

/** Types the message into the tab's Claude Code and submits it, waking the tab first if it sleeps. */
async function send(a: { target: string; text: string; from?: string }) {
  let hits = find(a.target);
  if (hits.length > 1) hits = hits.filter((t) => hasClaude(t.tab));
  if (hits.length !== 1) {
    const all = find(a.target).map((t) => `${t.id} (${t.workspace} › ${t.title})`);
    throw `"${a.target}" matches ${all.length} tabs; use the tab id: ${all.join(", ")}`;
  }
  const { tab, id } = hits[0];
  if (id === a.from) throw "that is this tab";
  if (!hasClaude(tab)) throw "no Claude Code in that tab; send only types into Claude Code";
  if (tab.asking) throw "its Claude Code is asking the user something; answer that in panex first";
  const text = cleanText(a.text ?? "");
  if (!text) throw "nothing to send";
  const woke = await wake(tab);
  if (woke) {
    if (!tab.agentLive) throw "the tab started but did not resume Claude Code";
    await settle(tab);
  }
  // Claude Code reads a quick text + Enter as one paste with a line break, so Enter goes separately.
  const paste = tab.term.modes.bracketedPasteMode;
  await invoke("pty_write", { id, data: paste ? `\x1b[200~${text}\x1b[201~` : text.replace(/\n/g, " ") });
  await pause(150);
  // Before the answer: a `wait` right after must not see the previous turn's "done".
  notify(tab, "running", "");
  await invoke("agent_state", { id, state: "running", message: "" });
  await invoke("pty_write", { id, data: "\r" });
  return { tab: id, workspace: hits[0].workspace, title: hits[0].title, woke };
}

let sweeping = false;

/**
 * 收掉側欄裡指向已刪 worktree 的工作區。panex 外刪的（終端機裡 `git worktree remove`、`rm -rf`、別的 Claude）
 * 不會通知 panex，所以在視窗拿回焦點、任一分頁回到提示字元、啟動時各檢查一次。
 * 開著 Claude 的分頁搬回主工作區（關掉會中斷對話），其餘分頁關掉。
 * 沒有 worktree 分頁時不呼叫後端；後端只讀檔案系統、不開 git 程序。
 */
export async function sweepGoneWorktrees() {
  if (sweeping) return;
  // 還原後還沒被看過的分頁沒有 git 資訊，所以也看群組：在 repo 群組裡、cwd 卻不在主 checkout 底下，就是 worktree。
  const paths = new Set<string>();
  for (const t of tabs.values()) {
    const group = workspaces.get(t.wsId)?.group;
    if (t.cwd && !t.ssh && (t.worktree || (group && !inFolder(t.cwd, group)))) paths.add(t.cwd);
  }
  if (!paths.size) return;
  sweeping = true;
  try {
    const gone = await invoke<string[]>("worktrees_gone", { paths: [...paths] });
    for (const path of gone) {
      const keep = new Set<string>();
      for (const t of [...tabs.values()]) {
        if (t.agentLive && inFolder(t.cwd, path)) {
          moveHome(t, path);
          keep.add(t.id);
        }
      }
      closeInside(path, keep);
    }
    if (gone.length) {
      saveSession();
      scheduleRender();
    }
  } catch {
    // 檢查失敗就等下一次，側欄多留一列不要緊。
  } finally {
    sweeping = false;
  }
}

export function wireControl() {
  listen<{ req: number; op: string; args: any }>("ctl-request", async ({ payload: p }) => {
    let ok = true;
    let value: unknown;
    try {
      if (p.op === "open") value = await open(p.args);
      else if (p.op === "worktree") value = await worktree(p.args);
      else if (p.op === "worktree-remove") value = worktreeRemove(p.args);
      else if (p.op === "list") value = list(p.args);
      else if (p.op === "wake") value = await wakeTabs(p.args);
      else if (p.op === "send") value = await send(p.args);
      else throw "unknown request";
    } catch (e) {
      ok = false;
      value = String(e);
    }
    invoke("ctl_reply", { req: p.req, ok, value }).catch(() => {});
  });
}
