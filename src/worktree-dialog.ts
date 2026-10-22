// The "new worktree" dialog: `git worktree add` from the current tab's repo, then a new
// workspace in it, with copied files and the optional setup command.

import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { type Workspace } from "./types";
import { $, newId, newWsId } from "./util";
import { S, activeTab, workspaces, wsOrder } from "./state";
import { createTab } from "./terminal";
import { showTab } from "./workspaces";
import { hideCtx } from "./context-menu";

export const wtEl = $("wt");

const wtBranchEl = $<HTMLInputElement>("wt-branch");
const wtBaseEl = $<HTMLInputElement>("wt-base");
const wtErrEl = $("wt-err");
const wtOkEl = $<HTMLButtonElement>("wt-ok");
let wtCwd: string | undefined;

/** `git worktree add` next to cwd's repo, copying the files named in worktree.copyFiles. */
export function addWorktree(cwd: string, branch: string, base: string | null) {
  const copyFiles = Array.isArray(S.rawConfig.worktree?.copyFiles) ? S.rawConfig.worktree.copyFiles : [".env", ".env.local"];
  return invoke<{ path: string; copied: string[] }>("git_worktree_add", { cwd, branch, base, copyFiles });
}

/** The worktree.setupCommand to type into a new worktree's shell, if any. */
export function worktreeSetup(): string | undefined {
  const setup = S.rawConfig.worktree?.setupCommand;
  return typeof setup === "string" && setup.trim() ? setup.trim() : undefined;
}

export function openWorktreeDialog() {
  const tab = activeTab();
  wtCwd = tab?.cwd;
  hideCtx();
  wtBranchEl.value = "";
  wtBaseEl.value = tab?.branch ?? "";
  wtErrEl.textContent = wtCwd && tab?.branch ? "" : tr("目前的工作目錄不在 git repo 裡");
  wtOkEl.disabled = false;
  wtEl.hidden = false;
  wtBranchEl.focus();
  // Existing branches as suggestions for both fields; typing a new name still works.
  $("wt-branches").replaceChildren();
  if (wtCwd) {
    invoke<string[]>("git_branches", { cwd: wtCwd })
      .then((list) => $("wt-branches").replaceChildren(...list.map((b) => Object.assign(document.createElement("option"), { value: b }))))
      .catch(() => {});
  }
}

function closeWorktreeDialog() {
  wtEl.hidden = true;
  activeTab()?.term.focus();
}

async function createWorktree() {
  const branch = wtBranchEl.value.trim();
  if (!wtCwd || !branch) return;
  wtOkEl.disabled = true;
  wtErrEl.textContent = "";
  try {
    const wt = await addWorktree(wtCwd, branch, wtBaseEl.value.trim() || null);
    wtEl.hidden = true;
    const ws: Workspace = { id: newWsId(), tabs: [], customTitle: branch };
    workspaces.set(ws.id, ws);
    wsOrder.push(ws.id);
    const tab = createTab({ id: newId(), shell: S.settings.defaultShell, cwd: wt.path }, ws.id);
    tab.initialInput = worktreeSetup();
    if (wt.copied.length) tab.term.write(`\x1b[90m${tr("已複製：{files}", { files: wt.copied.join(", ") })}\x1b[0m\r\n`);
    ws.tabs.push(tab.id);
    showTab(tab.id);
  } catch (e) {
    wtErrEl.textContent = String(e);
    wtOkEl.disabled = false;
  }
}

$("wt-cancel").onclick = closeWorktreeDialog;
wtEl.addEventListener("mousedown", (e) => e.target === wtEl && closeWorktreeDialog());
wtEl.querySelector("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  createWorktree();
});
wtEl.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") closeWorktreeDialog();
});
