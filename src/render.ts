// Drawing the sidebar (workspaces, status lines, running timers), the tab bar, the ⌄ shell
// menu and the hooks status line. Renders are batched to one per animation frame.

import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { type Status, type Tab } from "./types";
import { $, COLORS, esc, fmtDuration } from "./util";
import { S, activeWs, shellTag, tabTitle, tabs, workspaces, wsActiveTab, wsOrder, wsStatus, wsTitle } from "./state";
import { digitHint, keyLabel, withKey } from "./config";
import { newWorkspace } from "./workspaces";
import { openSshDialog } from "./ssh-dialog";
import { gitBadges } from "./git-panel";

export const wsListEl = $("tabs");
export const tabbarEl = $("tabbar");
export const shellMenuEl = $("shell-menu");
const hooksEl = $("hooks-row");
let renderQueued = false;

export function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

const renameInput = '<input class="rename-input" maxlength="80" spellcheck="false" />';

export function render() {
  // Re-rendering would destroy the rename field; render again when it closes.
  if (S.renaming && document.querySelector(".rename-input")) return;
  renderSidebar();
  renderTabbar();
}

function renderSidebar() {
  wsListEl.replaceChildren(
    ...wsOrder.map((wid, i) => {
      const ws = workspaces.get(wid)!;
      const cur = wsActiveTab(ws);
      const { status, tab: st } = wsStatus(ws);
      const d = document.createElement("div");
      d.className = `tab ws st-${status}${wid === S.activeWsId ? " active" : ""}`;
      d.dataset.ws = wid;
      const num = i < 8 ? i + 1 : i === wsOrder.length - 1 ? 9 : 0;
      const hint = num ? digitHint("selectWorkspaceByNumber", num) : "";
      const dot = ws.color ? `<span class="t-dot" style="background:${COLORS[ws.color] ?? ws.color}"></span>` : "";
      const count = ws.tabs.length > 1 ? `<span class="t-count" title="${esc(tr("{n} 個分頁", { n: ws.tabs.length }))}">${ws.tabs.length}</span>` : "";
      const title =
        S.renaming?.kind === "ws" && S.renaming.id === wid
          ? renameInput
          : `${dot}<span class="name">${esc(wsTitle(ws))}</span>${count}${hint ? `<span class="t-num">${hint}</span>` : ""}`;
      d.innerHTML =
        `<div class="t-title">${title}</div>` +
        (cur ? `<div class="t-meta"><span class="t-shell">${shellTag(cur.shell)}</span>${esc(cur.ssh ?? cur.cwd ?? "")}</div>` : "") +
        (cur?.branch ? `<div class="t-branch" title="git branch">⎇ ${esc(cur.branch)}${gitBadges(cur)}</div>` : "") +
        stateLine(status, st) +
        `<button class="t-close" title="${esc(withKey("關閉工作區", "closeWorkspace"))}">×</button>`;
      return d;
    }),
  );
  if (wsListEl.querySelector(".t-elapsed")) startElapsedTimer();
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
    d.className = `htab st-${t.status}${tid === S.visibleTabId ? " active" : ""}`;
    d.dataset.tab = tid;
    if (t.note) d.title = t.note;
    const num = i < 8 ? i + 1 : i === ws.tabs.length - 1 ? 9 : 0;
    const hint = num ? digitHint("selectTabByNumber", num) : "";
    d.innerHTML =
      S.renaming?.kind === "tab" && S.renaming.id === tid
        ? renameInput
        : `<span class="h-dot"></span><span class="h-name">${esc(tabTitle(t))}</span>` +
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
}

/** Updates the sidebar's hook status line; resolves to whether the hooks are installed. */
export async function refreshHooks(): Promise<boolean> {
  const ok = await invoke<boolean>("hooks_status").catch(() => false);
  hooksEl.textContent = ok ? tr("Claude Code 通知：已啟用") : tr("Claude Code 通知：未啟用");
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
