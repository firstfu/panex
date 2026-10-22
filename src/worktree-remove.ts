// 「關閉工作區並刪除 worktree」對話框：先列出刪掉會失去什麼（未 commit 的檔案、只在這個分支上的 commit、
// 還在工作的 agent），使用者確認後關掉開在那個資料夾裡的分頁，再用 `git worktree remove` 刪掉它，可選擇連分支一起刪。
// 主 checkout 不會出現在這裡（後端 git_worktree_info 會拒絕）。

import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { type Workspace } from "./types";
import { $ } from "./util";
import { activeTab, tabs, wsActiveTab } from "./state";
import { workingTabs } from "./agent";
import { inFolder } from "./groups";
import { closeTabs } from "./workspaces";
import { hideCtx } from "./context-menu";

/** 對應 git.rs 的 WorktreeInfo。 */
interface WorktreeInfo {
  path: string;
  repo: string;
  branch?: string | null;
  changes: number;
  unique: number;
}

export const wtRmEl = $("wt-rm");

const pathEl = $("wt-rm-path");
const warnEl = $("wt-rm-warn");
const branchRowEl = $("wt-rm-branch-row");
const branchEl = $<HTMLInputElement>("wt-rm-branch");
const branchLabelEl = $("wt-rm-branch-label");
const errEl = $("wt-rm-err");
const okEl = $<HTMLButtonElement>("wt-rm-ok");
const cancelEl = $<HTMLButtonElement>("wt-rm-cancel");

/** 對話框開著時的對象；undefined 表示還在查或查失敗。 */
let target: { info: WorktreeInfo; ws: Workspace } | undefined;
/** 資料夾已經不在時的工作區：按鈕只關工作區，不呼叫刪除。 */
let gone: Workspace | undefined;
/** 每次開啟加一，舊的查詢晚回來時不會蓋掉新的。 */
let openSeq = 0;

/** 要一起關掉的分頁：這個工作區的全部分頁，加上其他工作區裡開在這個 worktree 資料夾裡的。 */
function tabsToClose(ws: Workspace, path: string): string[] {
  const inside = [...tabs.values()].filter((t) => !t.ssh && inFolder(t.cwd, path)).map((t) => t.id);
  return [...new Set([...ws.tabs, ...inside])];
}

/**
 * 判斷工作區是不是開在 worktree 裡，決定右鍵選單要不要出現刪除項目。
 * 還原後還沒被看過的分頁沒有 git 資訊，所以也看群組：在 repo 群組裡、cwd 卻不在主 checkout 底下，就是 worktree。
 * 判斷錯了也無妨，後端會再確認一次。
 * @param ws 要判斷的工作區
 */
export function isWorktreeWs(ws: Workspace): boolean {
  const tab = wsActiveTab(ws);
  if (!tab?.cwd || tab.ssh) return false;
  return !!tab.worktree || (!!ws.group && !inFolder(tab.cwd, ws.group));
}

/**
 * 開啟對話框並向後端查這個 worktree 的狀態；查到之前刪除鈕是停用的。
 * @param ws 被右鍵的工作區（以它目前分頁的 cwd 找 worktree）
 */
export function openWorktreeRemove(ws: Workspace) {
  hideCtx();
  const seq = ++openSeq;
  target = undefined;
  gone = undefined;
  pathEl.textContent = wsActiveTab(ws)?.cwd ?? "";
  warnEl.replaceChildren();
  branchRowEl.hidden = true;
  errEl.textContent = "";
  okEl.disabled = true;
  okEl.textContent = tr("刪除");
  wtRmEl.hidden = false;
  cancelEl.focus();
  invoke<WorktreeInfo>("git_worktree_info", { cwd: wsActiveTab(ws)?.cwd ?? "" })
    .then((info) => {
      if (seq !== openSeq || wtRmEl.hidden) return;
      target = { info, ws };
      pathEl.textContent = info.path;
      if (info.branch) {
        branchLabelEl.textContent = tr("一併刪除分支 {b}", { b: info.branch });
        // 分支上有別處找不到的 commit 就預設保留分支。
        branchEl.checked = info.unique === 0;
        branchRowEl.hidden = false;
      }
      okEl.disabled = false;
      update();
    })
    .catch((e) => {
      if (seq !== openSeq) return;
      if (String(e) !== "missing") {
        errEl.textContent = String(e);
        return;
      }
      // 資料夾已經被刪了（例如在 panex 外刪掉）：沒有東西可刪，只剩關掉工作區。
      gone = ws;
      warnEl.replaceChildren(Object.assign(document.createElement("li"), { textContent: tr("這個資料夾已經不在了") }));
      okEl.textContent = tr("關閉工作區");
      okEl.disabled = false;
      okEl.focus();
    });
}

/** 依目前的勾選重畫警告清單與按鈕；有任何會遺失的東西時按鈕改成「仍要刪除」，焦點留在取消。 */
function update() {
  if (!target) return;
  const { info, ws } = target;
  const busy = new Set(workingTabs().map((t) => t.id));
  const working = tabsToClose(ws, info.path).filter((id) => busy.has(id)).length;
  const warns: string[] = [];
  if (info.changes) warns.push(tr("{n} 個檔案的變更還沒 commit，刪除後找不回來", { n: info.changes }));
  if (info.unique && branchEl.checked && info.branch) warns.push(tr("分支 {b} 有 {n} 個 commit 不在其他分支上，刪掉分支就找不回來", { b: info.branch, n: info.unique }));
  if (working) warns.push(tr("{n} 個 agent 還在工作，會被中斷", { n: working }));
  warnEl.replaceChildren(...warns.map((w) => Object.assign(document.createElement("li"), { textContent: w })));
  okEl.textContent = warns.length ? tr("仍要刪除") : tr("刪除");
  (warns.length ? cancelEl : okEl).focus();
}

function closeDialog() {
  wtRmEl.hidden = true;
  target = undefined;
  gone = undefined;
  activeTab()?.term.focus();
}

/** 關掉分頁（shell 不能還在資料夾裡，Windows 會鎖住它），再刪 worktree；失敗時對話框留著顯示原因。 */
async function confirmRemove() {
  if (gone) {
    closeTabs(tabsToClose(gone, pathEl.textContent ?? ""));
    return closeDialog();
  }
  if (!target) return;
  const { info, ws } = target;
  okEl.disabled = true;
  errEl.textContent = "";
  closeTabs(tabsToClose(ws, info.path));
  try {
    await invoke("git_worktree_remove", {
      path: info.path,
      force: info.changes > 0,
      branch: branchEl.checked && info.branch ? info.branch : null,
    });
    closeDialog();
  } catch (e) {
    errEl.textContent = String(e);
    cancelEl.textContent = tr("關閉");
  }
}

branchEl.addEventListener("change", update);
okEl.onclick = () => void confirmRemove();
cancelEl.onclick = () => {
  cancelEl.textContent = tr("取消");
  closeDialog();
};
wtRmEl.addEventListener("mousedown", (e) => e.target === wtRmEl && cancelEl.click());
wtRmEl.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") cancelEl.click();
});
