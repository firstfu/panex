// "Resources": memory and process count per running tab, read from each tab's Job Object
// (Windows only). Nothing is polled: the dialog reads once when opened or refreshed, and
// the sidebar reads a workspace's tabs when the pointer moves onto its row.

import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { $, esc } from "./util";
import { activeTab, tabs, tabTitle, workspaces, wsOrder, wsTitle } from "./state";
import { showTab } from "./workspaces";
import { hideCtx } from "./context-menu";
import { IS_WIN } from "./platform";

type Usage = { id: string; bytes: number; procs: number };

const usageEl = $("usage");
const listEl = $("usage-list");

export function fmtBytes(n: number) {
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const read = () => invoke<Usage[]>("pty_usage").catch(() => [] as Usage[]);

export function openUsage() {
  if (!IS_WIN) return;
  hideCtx();
  usageEl.hidden = false;
  refresh();
  $("usage-close").focus();
}

function closeUsage() {
  usageEl.hidden = true;
  activeTab()?.term.focus();
}

async function refresh() {
  const rows = (await read()).filter((u) => tabs.has(u.id)).sort((a, b) => b.bytes - a.bytes);
  const wsOf = (id: string) => wsOrder.map((w) => workspaces.get(w)!).find((w) => w.tabs.includes(id));
  let bytes = 0, procs = 0;
  const body = rows.map((u) => {
    bytes += u.bytes;
    procs += u.procs;
    const ws = wsOf(u.id);
    const name = `${ws ? `${esc(wsTitle(ws))} / ` : ""}${esc(tabTitle(tabs.get(u.id)!))}`;
    return `<tr data-tab="${u.id}"><td class="u-name">${name}</td><td>${fmtBytes(u.bytes)}</td><td>${u.procs}</td></tr>`;
  });
  listEl.innerHTML = rows.length
    ? `<thead><tr><th>${esc(tr("工作區 / 分頁"))}</th><th>${esc(tr("記憶體"))}</th><th>${esc(tr("程序"))}</th></tr></thead>` +
      `<tbody>${body.join("")}</tbody>` +
      `<tfoot><tr><td>${esc(tr("合計"))}</td><td>${fmtBytes(bytes)}</td><td>${procs}</td></tr></tfoot>`
    : `<tbody><tr><td class="muted">${esc(tr("沒有執行中的分頁"))}</td></tr></tbody>`;
}

$("usage-refresh").onclick = refresh;
$("usage-close").onclick = closeUsage;
usageEl.addEventListener("mousedown", (e) => e.target === usageEl && closeUsage());
usageEl.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") closeUsage();
});
listEl.addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (!id) return;
  usageEl.hidden = true;
  showTab(id);
});

// Hovering a workspace row reads its tabs and puts the total in the row's tooltip.
// The sidebar re-renders often, so remember the element, not just the id.
let hovered: HTMLElement | null = null;
$("tabs").addEventListener("mouseover", (e) => {
  if (!IS_WIN) return;
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-ws]");
  if (!row || row === hovered) return;
  hovered = row;
  const ws = workspaces.get(row.dataset.ws!);
  if (!ws) return;
  read().then((list) => {
    const mine = list.filter((u) => ws.tabs.includes(u.id));
    if (!mine.length || hovered !== row) return;
    const bytes = mine.reduce((s, u) => s + u.bytes, 0);
    const procs = mine.reduce((s, u) => s + u.procs, 0);
    row.title = tr("記憶體 {m}・{n} 個程序", { m: fmtBytes(bytes), n: procs });
  });
});
$("tabs").addEventListener("mouseleave", () => (hovered = null));
