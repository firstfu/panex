// Drawing the sidebar (workspaces, status lines, running timers), the tab bar, the ⌄ shell
// menu and the hooks status line. Renders are batched to one per animation frame.

import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { type Status, type Tab } from "./types";
import { $, COLORS, esc, fmtDuration } from "./util";
import { S, activeWs, loudest, shellTag, tabTitle, tabs, workspaces, wsActiveTab, wsStatus, wsTitle } from "./state";
import { digitHint, keyLabel, withKey } from "./config";
import { newWorkspace } from "./workspaces";
import { openSshDialog } from "./ssh-dialog";
import { gitBadges } from "./git-panel";
import { groupName, isCollapsed, repoName, units } from "./groups";
import { hiddenOrder, isHidden, visibleOrder } from "./hidden";
import { fmtBytes, fmtMemShort, memOf } from "./mem";

export const wsListEl = $("tabs");
export const hiddenEl = $("hidden-row");
let hiddenOpen = false;
export function toggleHiddenList() {
  hiddenOpen = !hiddenOpen;
  scheduleRender();
}
export const tabbarEl = $("tabbar");
export const shellMenuEl = $("shell-menu");
const hooksEl = $("hooks-row");
let renderQueued = false;

// A render replaces every row, and the browser fires no click when the pressed element is gone by
// the release. Renders come often (an agent's title spinner, memory reads after hovering a row),
// so hold them while a press on these lists is down. Click follows pointerup in the same task,
// so the render queued on release lands after it.
let pressed = false;
let renderHeld = false;
for (const el of [wsListEl, hiddenEl, tabbarEl]) el.addEventListener("pointerdown", () => (pressed = true), true);
function releasePress() {
  pressed = false;
  if (!renderHeld) return;
  renderHeld = false;
  scheduleRender();
}
window.addEventListener("pointerup", releasePress, true);
window.addEventListener("pointercancel", releasePress, true);
// Not capturing: the press itself blurs the terminal, and capture would see that blur too.
window.addEventListener("blur", releasePress);

export function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (pressed) renderHeld = true;
    else render();
  });
}

// Fold caret of a group: the same chevron as the shell menu button, turned sideways when folded.
// A text ▾ is drawn tiny in some fonts and reads as a dot.
const CARET = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>';

const renameInput = '<input class="rename-input" maxlength="80" spellcheck="false" />';

export function render() {
  // Re-rendering would destroy the rename field; render again when it closes.
  if (S.renaming && document.querySelector(".rename-input")) return;
  renderSidebar();
  renderHidden();
  renderTabbar();
  renderGitToggleBadge();
}

/** Count of uncommitted changes on the git toggle (the tab the panel would show); hidden at 0 or outside a repo. */
function renderGitToggleBadge() {
  const n = (S.visibleTabId ? tabs.get(S.visibleTabId)?.git?.total : 0) ?? 0;
  const el = $("git-toggle-badge");
  el.hidden = !n;
  el.textContent = n > 99 ? "99+" : String(n);
  const label = tr("顯示 / 隱藏 Git 面板");
  const btn = $("git-toggle");
  btn.setAttribute("aria-label", n ? `${label}（${tr("{n} 個未提交的變更", { n })}）` : label);
}

/** The "已隱藏" row under the list: a count (with the loudest status inside), opening to the hidden workspaces. */
function renderHidden() {
  const ids = hiddenOrder();
  hiddenEl.hidden = !ids.length;
  if (!ids.length) return hiddenEl.replaceChildren();
  const status = loudest(ids);
  const head = document.createElement("div");
  head.className = `hid-head st-${status}`;
  head.dataset.hiddenToggle = "";
  head.innerHTML =
    `<span class="grp-caret${hiddenOpen ? "" : " folded"}">${CARET}</span><span class="name">${esc(tr("已隱藏"))}</span>` +
    `<span class="t-count">${ids.length}</span>` + (status !== "idle" ? `<span class="s-ico ${status}"></span>` : "");
  hiddenEl.replaceChildren(
    head,
    ...(hiddenOpen
      ? ids.map((id) => {
          const ws = workspaces.get(id)!;
          const { status: st } = wsStatus(ws);
          const row = document.createElement("div");
          row.className = `hid-item st-${st}${id === S.activeWsId ? " active" : ""}`;
          row.dataset.ws = id;
          row.title = tr("點一下顯示這個工作區");
          row.innerHTML = `<span class="name">${esc(wsTitle(ws))}</span>${st !== "idle" ? `<span class="s-ico ${st}"></span>` : ""}`;
          return row;
        })
      : []),
  );
}

// Groups (one repo's checkouts) render as a box: a header row naming the repo (click to fold),
// then all its workspaces (main folder and worktrees) side by side. The rest render as plain rows.
function renderSidebar() {
  wsListEl.replaceChildren(
    ...units().flatMap((all) => {
      const run = all.filter((id) => !isHidden(id));
      if (!run.length) return [];
      const group = workspaces.get(run[0])!.group;
      if (!group) return wsRow(run[0]);
      const box = document.createElement("div");
      const folded = isCollapsed(group);
      box.dataset.repo = group;
      const status = folded ? loudest(run) : "idle";
      box.className = `ws-group${folded ? " folded" : ""}`;
      const head = document.createElement("div");
      head.className = `grp-head st-${status}${folded && run.includes(S.activeWsId ?? "") ? " active" : ""}`;
      head.dataset.group = group;
      head.title = group;
      head.innerHTML =
        `<span class="grp-caret${folded ? " folded" : ""}">${CARET}</span><span class="name">${esc(groupName(group, run))}</span>` +
        `<span class="t-count" title="${esc(tr("{n} 個工作區", { n: run.length }))}">${run.length}</span>` +
        (status !== "idle" ? `<span class="s-ico ${status}"></span>` : "");
      box.append(head, ...(folded ? [] : run.map((id) => wsRow(id))));
      return box;
    }),
  );
  if (wsListEl.querySelector(".t-elapsed")) startElapsedTimer();
}

/**
 * 側欄的一個工作區列。
 * @param wid 工作區 id
 */
function wsRow(wid: string) {
  const order = visibleOrder();
  const i = order.indexOf(wid);
  const ws = workspaces.get(wid)!;
  const cur = wsActiveTab(ws);
  const { status, tab: st } = wsStatus(ws);
  const active = wid === S.activeWsId;
  const d = document.createElement("div");
  d.className = `tab ws st-${status}${active ? " active" : ""}`;
  d.dataset.ws = wid;
  const num = i < 8 ? i + 1 : i === order.length - 1 ? 9 : 0;
  const hint = num ? digitHint("selectWorkspaceByNumber", num) : "";
  const dot = ws.color ? `<span class="t-dot" style="background:${COLORS[ws.color] ?? ws.color}"></span>` : "";
  const count = ws.tabs.length > 1 ? `<span class="t-count" title="${esc(tr("{n} 個分頁", { n: ws.tabs.length }))}">${ws.tabs.length}</span>` : "";
  const mem = memTag(ws.tabs, "t-mem");
  const title =
    S.renaming?.kind === "ws" && S.renaming.id === wid
      ? renameInput
      : `${dot}<span class="name">${esc(wsTitle(ws))}</span>${mem}${count}${hint ? `<span class="t-num">${hint}</span>` : ""}`;
  d.innerHTML =
    `<div class="t-title">${title}</div>` +
    (cur ? `<div class="t-meta"><span class="t-shell">${shellTag(cur.shell)}</span>${esc(cur.ssh ?? cur.cwd ?? "")}</div>` : "") +
    (cur?.branch ? `<div class="t-branch" title="git branch">⎇ ${worktreeTag(cur, !!ws.group)}${esc(cur.branch)}${gitBadges(cur)}</div>` : "") +
    stateLine(status, st) +
    `<button class="t-close" title="${esc(withKey("關閉工作區", "closeWorkspace"))}">×</button>`;
  return d;
}

/** The memory of the given tabs added up, as a small tag with the process count in its tooltip; "" before the first read. */
function memTag(ids: string[], cls: string) {
  let bytes = 0, procs = 0, any = false;
  for (const id of ids) {
    const u = memOf.get(id);
    if (!u) continue;
    any = true;
    bytes += u.bytes;
    procs += u.procs;
  }
  if (!any) return "";
  const title = tr("記憶體 {m}・{n} 個程序", { m: fmtBytes(bytes), n: procs });
  return `<span class="${cls}" title="${esc(title)}">${fmtMemShort(bytes)}</span>`;
}

/** Marks a linked worktree; outside a group (whose header names the repo) it also names the repo. */
function worktreeTag(tab: Tab, grouped: boolean) {
  if (!tab.worktree || !tab.repo) return "";
  const title = esc(tr("git worktree，主 repo：{repo}", { repo: tab.repo }));
  return `<span class="t-wt" title="${title}">worktree${grouped ? "" : ` · ${esc(repoName(tab.repo))}`}</span>`;
}

/** The status row under a workspace: glyph, note and the turn's running/finished time; running also gets the scan line. */
function stateLine(status: Status, tab?: Tab): string {
  if (status === "idle" || !tab) return "";
  let text = tab.note ?? "";
  let time = "";
  if (status === "running") {
    text = tr("執行中…");
    if (tab.runStart) time = `<span class="t-time t-elapsed" data-start="${tab.runStart}" title="${esc(tr("已執行時間"))}">${fmtDuration(Date.now() - tab.runStart)}</span>`;
  } else if (status === "done" && tab.runMs !== undefined) {
    time = `<span class="t-time" title="${esc(tr("這一輪花的時間"))}">${fmtDuration(tab.runMs)}</span>`;
  }
  return (
    `<div class="t-state ${status}"><span class="s-ico ${status}"></span><span class="t-note">${esc(text)}</span>${time}</div>` +
    (status === "running" ? '<span class="t-scan"></span>' : "")
  );
}

let elapsedTimer: number | undefined;

/** Ticks the running-time counters once a second; stops itself as soon as none is on screen. */
function startElapsedTimer() {
  if (elapsedTimer !== undefined) return;
  elapsedTimer = window.setInterval(() => {
    const els = wsListEl.querySelectorAll<HTMLElement>(".t-elapsed");
    if (!els.length) {
      clearInterval(elapsedTimer);
      elapsedTimer = undefined;
      return;
    }
    for (const el of els) el.textContent = fmtDuration(Date.now() - Number(el.dataset.start));
  }, 1000);
}

function renderTabbar() {
  const ws = activeWs();
  if (!ws) return tabbarEl.replaceChildren();
  const items = ws.tabs.map((tid, i) => {
    const t = tabs.get(tid)!;
    const d = document.createElement("div");
    d.className = `htab st-${t.status}${tid === S.visibleTabId ? " active" : ""}${t.hibernated ? " sleeping" : ""}`;
    d.dataset.tab = tid;
    if (t.note) d.title = t.note;
    if (t.hibernated) d.title = (t.note ? `${t.note}\n` : "") + tr("已休眠：切回來時自動接回");
    const num = i < 8 ? i + 1 : i === ws.tabs.length - 1 ? 9 : 0;
    const hint = num ? digitHint("selectTabByNumber", num) : "";
    d.innerHTML =
      S.renaming?.kind === "tab" && S.renaming.id === tid
        ? renameInput
        : `<span class="h-dot"></span><span class="h-name">${esc(tabTitle(t))}</span>${memTag([tid], "h-mem")}` +
          (hint ? `<span class="t-num">${hint}</span>` : "") +
          `<button class="h-close" title="${esc(withKey("關閉分頁", "closeTab"))}">×</button>`;
    return d;
  });
  const add = document.createElement("button");
  add.className = "h-add";
  add.textContent = "＋";
  add.title = withKey("新分頁", "newTab");
  tabbarEl.replaceChildren(...items, add);
}

const sshBtn = document.createElement("button");
sshBtn.onclick = () => {
  shellMenuEl.hidden = true;
  openSshDialog();
};

export function renderShellMenu() {
  shellMenuEl.replaceChildren(
    ...S.shells.map((s, i) => {
      const b = document.createElement("button");
      const hint = i < 9 ? digitHint("newWorkspaceWithShell", i + 1) : "";
      b.textContent = `${tr(s.name)}${hint ? `　${hint}` : ""}`;
      b.onclick = () => {
        shellMenuEl.hidden = true;
        newWorkspace(s.id);
      };
      return b;
    }),
    sshBtn,
  );
  const sshKey = keyLabel("newSsh");
  sshBtn.textContent = `${tr("SSH 連線…")}${sshKey ? `　${sshKey}` : ""}`;
  $("new-tab").title = withKey("新工作區", "newWorkspace");
  $("sidebar-toggle").title = withKey("顯示 / 隱藏側欄", "toggleSidebar");
  $("git-toggle").title = withKey("顯示 / 隱藏 Git 面板", "toggleGitPanel");
  $("files-tab").title = withKey("顯示 / 隱藏專案檔案", "toggleFilesPanel");
}

/** Updates the sidebar's hook status line; resolves to whether the hooks are installed. */
export async function refreshHooks(): Promise<boolean> {
  const ok = await invoke<boolean>("hooks_status").catch(() => false);
  // Installed at launch, so the line only appears when that failed, to offer a retry.
  hooksEl.hidden = ok;
  hooksEl.textContent = ok ? "" : tr("Claude Code 通知：未啟用");
  if (!ok) {
    const b = document.createElement("button");
    b.textContent = tr("啟用");
    b.title = tr("在 ~/.claude/settings.json 加入 panex 的 hooks（會先備份）");
    b.onclick = async () => {
      try {
        await invoke("hooks_install");
      } catch (e) {
        hooksEl.textContent = tr("啟用失敗：{e}", { e: String(e) });
        return;
      }
      refreshHooks();
    };
    hooksEl.appendChild(b);
  }
  return ok;
}
