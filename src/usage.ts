// Tab overview: every tab grouped by what it is doing (needs you, working, done, idle, asleep,
// not started), with the agent's last message, the turn's time, and memory and process count
// read from each tab's process tree (Job Object on Windows, descendants of the shell on macOS).
// Each row can wake, hibernate or keep the tab awake. Nothing is polled: the dialog reads once
// when opened, refreshed or after one of its buttons. The numbers on the tabs and sidebar rows
// come from mem.ts; moving the pointer onto one re-reads them.

import { t as tr } from "./i18n";
import { type Tab, type Workspace } from "./types";
import { $, esc, fmtDuration } from "./util";
import { activeTab, tabs, tabTitle, workspaces, wsOrder, wsTitle } from "./state";
import { showTab } from "./workspaces";
import { hideCtx } from "./context-menu";
import { CAN_MANAGE } from "./platform";
import { armHibernate, canHibernate, hibernate, setNoSleep, wake } from "./hibernate";
import { GROUPS, type Group, groupOf } from "./remote";
import { fmtBytes, refreshMem, readUsage, setUsage, type Usage } from "./mem";

const usageEl = $("usage");
const listEl = $("usage-list");

/** Reads every tab's memory, and hands the read to the tab bar and sidebar too. */
async function read() {
  const list = await readUsage();
  setUsage(list);
  return list;
}

export function openUsage() {
  if (!CAN_MANAGE) return;
  hideCtx();
  usageEl.hidden = false;
  refresh();
  $("usage-close").focus();
}

function closeUsage() {
  usageEl.hidden = true;
  activeTab()?.term.focus();
}

const GROUP_LABEL: Record<Group, string> = {
  needs: "在等你",
  running: "正在做",
  done: "做完",
  idle: "閒著",
  asleep: "睡著了",
  stopped: "未啟動",
};

/** How long the turn has run (still going) or took (finished); "" when there is none. */
function turnTime(tab: Tab) {
  if (tab.runStart !== undefined) return fmtDuration(Date.now() - tab.runStart);
  return tab.status === "done" && tab.runMs !== undefined ? fmtDuration(tab.runMs) : "";
}

function button(kind: string, id: string, label: string, title: string, on = false) {
  return `<button class="u-btn${on ? " on" : ""}" data-${kind}="${id}" title="${esc(tr(title))}">${esc(tr(label))}</button>`;
}

function row(ws: Workspace, tab: Tab, group: Group, u: Usage | undefined) {
  const name = `${esc(wsTitle(ws))} / ${esc(tabTitle(tab))}`;
  const note = tab.note ? `<div class="u-note">${esc(tab.note)}</div>` : "";
  const mem = u ? `<span title="${esc(tr("{n} 個程序", { n: u.procs }))}">${fmtBytes(u.bytes)}</span>` : "";
  const btns: string[] = [];
  if ((group === "asleep" || group === "stopped") && !tab.ssh) {
    btns.push(group === "asleep"
      ? button("wake", tab.id, "叫醒", "在背景接回這個分頁的 Claude Code，不切過去")
      : button("wake", tab.id, "啟動", "在背景啟動這個分頁，不切過去"));
  }
  if (canHibernate(tab) && tab.status !== "running") btns.push(button("sleep", tab.id, "休眠", "結束這個分頁的程序以釋放記憶體，切回來時自動接回"));
  if (!tab.ssh) btns.push(button("nosleep", tab.id, "不休眠", "這個分頁不會被休眠（例如從手機連的控制分頁）；再按一次取消", !!tab.noSleep));
  return `<tr data-tab="${tab.id}"><td class="u-name"><div class="u-title">${name}</div>${note}</td>` +
    `<td>${turnTime(tab)}</td><td>${mem}</td><td><div class="u-acts">${btns.join("")}</div></td></tr>`;
}

async function refresh() {
  const usage = new Map((await read()).map((u) => [u.id, u]));
  const all = wsOrder.flatMap((wid) => {
    const ws = workspaces.get(wid)!;
    return ws.tabs.map((id) => ({ ws, tab: tabs.get(id)! }));
  });
  let bytes = 0, procs = 0;
  const body: string[] = [];
  for (const g of GROUPS) {
    const list = all.filter((r) => groupOf(r.tab) === g);
    if (!list.length) continue;
    body.push(`<tr class="u-group"><td colspan="4">${esc(tr(GROUP_LABEL[g]))} · ${list.length}</td></tr>`);
    for (const { ws, tab } of list) {
      const u = usage.get(tab.id);
      if (u) {
        bytes += u.bytes;
        procs += u.procs;
      }
      body.push(row(ws, tab, g, u));
    }
  }
  listEl.innerHTML =
    `<thead><tr><th>${esc(tr("工作區 / 分頁"))}</th><th>${esc(tr("這一輪"))}</th><th>${esc(tr("記憶體"))}</th><th></th></tr></thead>` +
    `<tbody>${body.join("")}</tbody>` +
    `<tfoot><tr><td>${esc(tr("合計"))}</td><td></td><td>${fmtBytes(bytes)}</td><td class="muted">${esc(tr("{n} 個程序", { n: procs }))}</td></tr></tfoot>`;
}

$("usage-refresh").onclick = refresh;
$("usage-close").onclick = closeUsage;
usageEl.addEventListener("mousedown", (e) => e.target === usageEl && closeUsage());
usageEl.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") closeUsage();
});
listEl.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".u-btn");
  if (btn) {
    const { sleep, wake: wakeId, nosleep } = btn.dataset;
    const tab = tabs.get(sleep ?? wakeId ?? nosleep ?? "");
    if (!tab) return;
    btn.disabled = true;
    if (sleep) await hibernate(tab);
    else if (nosleep) setNoSleep(tab, !tab.noSleep);
    else {
      // The shell starts behind the dialog; `claude --resume` sends no hook, so arm the countdown here.
      if (await wake(tab).catch(() => false)) armHibernate(tab);
      // Give the new process tree a moment, so its memory shows on the refresh.
      await new Promise((r) => setTimeout(r, 1000));
    }
    return refresh();
  }
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (!id) return;
  usageEl.hidden = true;
  showTab(id);
});

// Moving onto a workspace row or a tab re-reads the memory numbers shown on them.
// The sidebar re-renders often, so key on the id, not the element.
let hovered: string | undefined;
for (const el of [$("tabs"), $("tabbar")]) {
  el.addEventListener("mouseover", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-ws], [data-tab]");
    const key = row?.dataset.ws ?? row?.dataset.tab;
    if (!key || key === hovered) return;
    hovered = key;
    refreshMem();
  });
  el.addEventListener("mouseleave", () => (hovered = undefined));
}
