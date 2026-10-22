// Right-click menus for workspaces and tabs.

import { t as tr } from "./i18n";
import { type Tab, type Workspace } from "./types";
import { $, COLORS, esc } from "./util";
import { tabs, workspaces, wsActiveTab, wsOrder } from "./state";
import { keyLabel } from "./config";
import { askCloseTab, askCloseTabs, askCloseWorkspaces, moveTab, newTab, setColor, showWorkspace } from "./workspaces";
import { canMove, groupMembers, groupName, inRepo, isCollapsed, joinGroup, leaveGroup, moveBy, moveToTop, repoName, setCollapsed, ungroup } from "./groups";
import { openWorktreeDialog } from "./worktree-dialog";
import { startRename } from "./rename";

export const ctxEl = $("ctx");

type MenuItem = { label: string; keys?: string; run: () => void; disabled?: boolean } | "-" | { colors: Workspace };

export function wsMenu(ws: Workspace): MenuItem[] {
  const i = wsOrder.indexOf(ws.id);
  const others = wsOrder.filter((id) => id !== ws.id);
  // The same path the sidebar shows under the workspace name: its active tab's cwd.
  const cwd = wsActiveTab(ws)?.cwd;
  return [
    { label: tr("重新命名工作區…"), keys: keyLabel("renameWorkspace"), run: () => startRename("ws", ws.id) },
    { colors: ws },
    "-",
    { label: tr("新分頁"), keys: keyLabel("newTab"), run: () => (showWorkspace(ws.id), newTab()) },
    { label: tr("用新 worktree 開新工作區…"), keys: keyLabel("newWorktree"), run: () => (showWorkspace(ws.id), openWorktreeDialog()) },
    ...groupItems(ws),
    copyPathItem(cwd),
    "-",
    { label: tr("上移"), keys: keyLabel("moveWorkspaceUp"), run: () => moveBy(ws.id, -1), disabled: !canMove(ws.id, -1) },
    { label: tr("下移"), keys: keyLabel("moveWorkspaceDown"), run: () => moveBy(ws.id, 1), disabled: !canMove(ws.id, 1) },
    { label: tr("移到最上面"), run: () => moveToTop(ws.id), disabled: !canMove(ws.id, -1) },
    "-",
    { label: tr("關閉工作區"), keys: keyLabel("closeWorkspace"), run: () => askCloseWorkspaces([ws.id]) },
    { label: tr("關閉其他工作區"), run: () => askCloseWorkspaces(others), disabled: !others.length },
    { label: tr("關閉下方工作區"), run: () => askCloseWorkspaces(wsOrder.slice(i + 1)), disabled: i === wsOrder.length - 1 },
    { label: tr("關閉上方工作區"), run: () => askCloseWorkspaces(wsOrder.slice(0, i)), disabled: i === 0 },
  ];
}

/** Leave the group, or join / start the group of the repo this workspace is a checkout of. */
function groupItems(ws: Workspace): MenuItem[] {
  if (ws.group) return [{ label: tr("移出群組"), run: () => leaveGroup(ws.id) }];
  const repo = wsActiveTab(ws)?.repo;
  if (!repo) return [];
  const members = groupMembers(repo);
  if (members.length) return [{ label: tr("加入「{name}」群組", { name: groupName(repo, members) }), run: () => joinGroup([ws.id], repo) }];
  const name = repoName(repo);
  // Other open checkouts of the same repo (its worktrees) that are in no group either.
  const same = wsOrder.filter((id) => !workspaces.get(id)!.group && inRepo(workspaces.get(id)!, repo));
  if (same.length < 2) return [];
  return [{ label: tr("把「{name}」的 {n} 個工作區設為群組", { name, n: same.length }), run: () => joinGroup(same, repo) }];
}

/** The header of a repo's group. */
export function groupMenu(group: string): MenuItem[] {
  const members = groupMembers(group);
  const first = members[0];
  const folded = isCollapsed(group);
  // Base the new worktree on the main checkout's branch when one of its tabs shows it.
  const main = members.flatMap((id) => workspaces.get(id)!.tabs.map((t) => tabs.get(t)!)).find((t) => t.repo && !t.worktree && t.branch);
  return [
    { label: tr("在這個 repo 開新 worktree…"), run: () => openWorktreeDialog({ cwd: group, base: main?.branch ?? "", after: members[members.length - 1] }) },
    { label: folded ? tr("展開") : tr("收合"), run: () => setCollapsed(group, !folded) },
    "-",
    { label: tr("上移"), run: () => moveBy(first, -1, true), disabled: !canMove(first, -1, true) },
    { label: tr("下移"), run: () => moveBy(first, 1, true), disabled: !canMove(first, 1, true) },
    { label: tr("移到最上面"), run: () => moveToTop(first, true), disabled: !canMove(first, -1, true) },
    "-",
    { label: tr("解散群組"), run: () => ungroup(group) },
    { label: tr("關閉群組內的工作區"), run: () => askCloseWorkspaces(members) },
  ];
}

/** Copies a tab's cwd; disabled when there is none (e.g. an SSH tab). */
function copyPathItem(cwd: string | undefined): MenuItem {
  return { label: tr("複製路徑"), run: () => void navigator.clipboard.writeText(cwd!).catch(() => {}), disabled: !cwd };
}

export function tabMenu(tab: Tab): MenuItem[] {
  const ws = workspaces.get(tab.wsId)!;
  const i = ws.tabs.indexOf(tab.id);
  const others = ws.tabs.filter((id) => id !== tab.id);
  return [
    { label: tr("重新命名分頁…"), keys: keyLabel("renameTab"), run: () => startRename("tab", tab.id) },
    copyPathItem(tab.cwd),
    "-",
    { label: tr("左移"), keys: keyLabel("moveTabLeft"), run: () => moveTab(tab.id, i - 1), disabled: i === 0 },
    { label: tr("右移"), keys: keyLabel("moveTabRight"), run: () => moveTab(tab.id, i + 1), disabled: i === ws.tabs.length - 1 },
    "-",
    { label: tr("關閉分頁"), keys: keyLabel("closeTab"), run: () => askCloseTab(tab.id) },
    { label: tr("關閉其他分頁"), run: () => askCloseTabs(others), disabled: !others.length },
    { label: tr("關閉右側分頁"), run: () => askCloseTabs(ws.tabs.slice(i + 1)), disabled: i === ws.tabs.length - 1 },
  ];
}

export function showCtx(x: number, y: number, items: MenuItem[]) {
  ctxEl.replaceChildren(
    ...items.map((it) => {
      if (it === "-") return document.createElement("hr");
      if ("colors" in it) {
        const ws = it.colors;
        const row = document.createElement("div");
        row.className = "colors";
        const none = document.createElement("span");
        none.className = `none${ws.color ? "" : " sel"}`;
        none.title = tr("無顏色");
        none.onclick = () => (setColor(ws, undefined), hideCtx());
        row.append(
          none,
          ...Object.entries(COLORS).map(([name, hex]) => {
            const s = document.createElement("span");
            s.style.background = hex;
            s.title = name;
            if (ws.color === name) s.className = "sel";
            s.onclick = () => (setColor(ws, name), hideCtx());
            return s;
          }),
        );
        return row;
      }
      const d = document.createElement("div");
      d.className = `item${it.disabled ? " disabled" : ""}`;
      d.innerHTML = `<span>${esc(it.label)}</span>${it.keys ? `<kbd>${esc(it.keys)}</kbd>` : ""}`;
      d.onclick = () => {
        hideCtx();
        it.run();
      };
      return d;
    }),
  );
  ctxEl.hidden = false;
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  ctxEl.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
}

export function hideCtx() {
  ctxEl.hidden = true;
}
