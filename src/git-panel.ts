// The right panel, read only: its Git tab (status, diffs, recent commits), the sidebar git badges,
// and the overlay viewer it shares with the Files tab (files-panel.ts).

import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { type GitCommit, type GitFile, type GitStatus, type GitText, type Tab } from "./types";
import { $, esc } from "./util";
import { S, activeTab, tabs, workspaces, wsActiveTab } from "./state";
import { scheduleRender } from "./render";
import { clearFileSel, markFilesStale, renderFilesPanel } from "./files-panel";

// Read only. Nothing polls or watches the repo: a status read (one short `git status`) runs only
// after a shell prompt, a Claude Code "Stop", the window regaining focus, or the panel opening,
// and only for tabs on screen (the sidebar shows each workspace's active tab). The commit list
// is read only while the panel is open, and again only when HEAD or the unpushed count moves.

const GIT_DEBOUNCE_MS = 300;
const GIT_LOG_COUNT = 30;
const GIT_VIEW_MAX_LINES = 5000;
const gitEl = $("git");
const gitBodyEl = $("git-body");
const gitResizer = $("git-resizer");
export const gitViewEl = $("git-view");
const gvBodyEl = $("gv-body");
let gitOpen = false;
let gitLog: { root: string; key: string; commits: GitCommit[]; error?: string } | undefined;
let gitSel = ""; // the row whose diff is on screen
const collapsed = new Set<string>(); // section labels folded shut
try { for (const s of JSON.parse(localStorage.getItem("panex.gitCollapsed") ?? "[]")) collapsed.add(String(s)); } catch { /* storage unavailable */ }
let gvReq = 0; // drops viewer answers that arrive after a newer request
export type PanelMode = "git" | "log" | "files";
let panelMode: PanelMode = "git";
try { const m = localStorage.getItem("panex.panelTab"); if (m === "files" || m === "log") panelMode = m; } catch { /* storage unavailable */ }

export function scheduleGit(tab?: Tab) {
  if (!tab?.cwd || tab.ssh) return;
  clearTimeout(tab.gitTimer);
  tab.gitTimer = window.setTimeout(() => {
    tab.gitTimer = undefined;
    refreshGit(tab);
  }, GIT_DEBOUNCE_MS);
}

/** A tab nobody sees (not its workspace's active tab) is marked stale and read when shown. */
async function refreshGit(tab: Tab) {
  const ws = workspaces.get(tab.wsId);
  if (!tabs.has(tab.id) || !ws || wsActiveTab(ws) !== tab) {
    tab.gitStale = true;
    return;
  }
  if (tab.gitBusy) {
    tab.gitAgain = true;
    return;
  }
  tab.gitBusy = true;
  tab.gitStale = false;
  const before = gitBadges(tab);
  try {
    tab.git = (await invoke<GitStatus | null>("git_status", { cwd: tab.cwd })) ?? undefined;
    tab.gitErr = undefined;
  } catch (e) {
    tab.git = undefined;
    tab.gitErr = String(e);
  } finally {
    tab.gitBusy = false;
  }
  if (gitBadges(tab) !== before) scheduleRender();
  if (tab.id === S.visibleTabId) {
    markFilesStale(); // the same events (prompt, Stop, focus) are when files may have come or gone
    renderGitPanel();
  }
  if (tab.gitAgain) {
    tab.gitAgain = false;
    scheduleGit(tab);
  }
}

/** Sidebar suffix after the branch: ↑ unpushed, ↓ behind upstream (as of the last fetch), ● uncommitted. */
export function gitBadges(tab: Tab): string {
  const g = tab.git;
  if (!g) return "";
  return (
    (g.ahead ? `<span class="g-badge ahead" title="${esc(tr("{n} 個未推送的提交", { n: g.ahead }))}">↑${g.ahead}</span>` : "") +
    (g.behind ? `<span class="g-badge behind" title="${esc(tr("上游有 {n} 個新提交（上次 fetch 的結果）", { n: g.behind }))}">↓${g.behind}</span>` : "") +
    (g.total ? `<span class="g-badge dirty" title="${esc(tr("{n} 個未提交的變更", { n: g.total }))}">●${g.total}</span>` : "")
  );
}

/** Shows the panel on the given tab; open and already there, closes it (the shortcuts' toggle). */
export function togglePanel(mode: PanelMode) {
  if (gitOpen && panelMode === mode) return setGitOpen(false);
  setPanelMode(mode);
  if (!gitOpen) setGitOpen(true);
}

export function setPanelMode(mode: PanelMode) {
  panelMode = mode;
  try { localStorage.setItem("panex.panelTab", mode); } catch { /* storage unavailable */ }
  for (const b of document.querySelectorAll<HTMLElement>(".g-tab")) b.classList.toggle("on", b.dataset.mode === mode);
  gitBodyEl.hidden = mode === "files";
  $("files-body").hidden = mode !== "files";
  if (mode === "files") markFilesStale();
  if (mode !== "log") gitLog = undefined; // the commit list isn't kept fresh while hidden
  renderGitPanel();
}

export function setGitOpen(open: boolean) {
  gitOpen = open;
  gitEl.hidden = gitResizer.hidden = !open;
  $("git-toggle").classList.toggle("on", open);
  try { localStorage.setItem("panex.gitOpen", open ? "1" : ""); } catch { /* storage unavailable */ }
  if (!open) {
    gitLog = undefined; // re-read on the next open; nothing to keep fresh meanwhile
    gitBodyEl.replaceChildren();
    $("files-body").replaceChildren();
    closeGitView();
    return;
  }
  scheduleGit(activeTab()); // first, so the Files tab waits for the repo root instead of listing the cwd
  setPanelMode(panelMode);
}

const gitMsg = (text: string) => `<div class="g-msg">${esc(text)}</div>`;

/** Splits "src/a/b.ts" into the file name and its folder. */
function splitPath(p: string): [string, string] {
  const clean = p.replace(/\/$/, "");
  const i = clean.lastIndexOf("/");
  return i < 0 ? [p, ""] : [clean.slice(i + 1) + (p.endsWith("/") ? "/" : ""), clean.slice(0, i)];
}

function fileRow(f: GitFile, kind: "staged" | "unstaged" | "untracked"): string {
  const letter = kind === "untracked" ? "U" : kind === "staged" ? f.x : f.y;
  const cls = kind === "untracked" ? "new" : letter;
  const [name, dir] = splitPath(f.path);
  const key = `${kind}:${f.path}`;
  const title = f.orig ? `${f.orig} → ${f.path}` : f.path;
  return (
    `<div class="g-row g-file${gitSel === key ? " sel" : ""}" data-kind="${kind}" data-path="${esc(f.path)}" data-orig="${esc(f.orig ?? "")}" title="${esc(title)}">` +
    `<span class="g-name">${esc(name)}</span><span class="g-dir">${esc(dir)}</span><span class="g-st ${cls}">${esc(letter)}</span></div>`
  );
}

export function renderGitPanel() {
  if (!gitOpen) return;
  if (panelMode === "files") return renderFilesPanel();
  const tab = activeTab();
  const g = tab?.git;
  if (!tab) return void gitBodyEl.replaceChildren();
  if (tab.ssh) return void (gitBodyEl.innerHTML = gitMsg(tr("SSH 分頁看不到本機的 git 狀態")));
  if (tab.gitErr) return void (gitBodyEl.innerHTML = gitMsg(tr("讀取失敗：{e}", { e: tab.gitErr })));
  if (!g) return void (gitBodyEl.innerHTML = gitMsg(tr(tab.gitTimer || tab.gitBusy ? "載入中…" : "目前的工作目錄不在 git repo 裡")));

  if (panelMode === "log") return renderLogPanel(g);

  const sync = g.upstream
    ? [
        g.ahead ? tr("{n} 個未推送的提交", { n: g.ahead }) : "",
        g.behind ? tr("上游有 {n} 個新提交（上次 fetch 的結果）", { n: g.behind }) : "",
      ].filter(Boolean).join("，") || tr("與 {u} 同步", { u: g.upstream })
    : tr("沒有設定 upstream");
  const staged = g.files.filter((f) => f.x !== "." && f.x !== "?");
  const unstaged = g.files.filter((f) => f.y !== "." && f.x !== "?");
  const untracked = g.files.filter((f) => f.x === "?");
  const changes = unstaged.length + untracked.length;
  const sec = (label: string, n?: number) =>
    `<div class="g-sec${collapsed.has(label) ? " shut" : ""}" data-sec="${esc(label)}"><span class="g-arrow"></span>${esc(tr(label))}` +
    `${n === undefined ? "" : `<span class="t-count">${n}</span>`}</div>`;
  const body = (label: string, rows: () => string) => (collapsed.has(label) ? "" : rows());

  let html =
    `<div class="g-repo"><div class="g-branch" title="${esc(g.root)}">⎇ ${esc(g.branch ?? "")}</div>` +
    `<div class="g-sync">${esc(sync)}</div></div>`;
  if (staged.length) html += sec("已暫存的變更", staged.length) + body("已暫存的變更", () => staged.map((f) => fileRow(f, "staged")).join(""));
  if (changes) html += sec("變更", changes) + body("變更", () => unstaged.map((f) => fileRow(f, "unstaged")).join("") + untracked.map((f) => fileRow(f, "untracked")).join(""));
  if (!g.total) html += gitMsg(tr("沒有未提交的變更"));
  else if (g.total > g.files.length) html += gitMsg(tr("只列出前 {shown} 個（共 {total} 個）", { shown: g.files.length, total: g.total }));

  const top = gitBodyEl.scrollTop;
  gitBodyEl.innerHTML = html;
  gitBodyEl.scrollTop = top;
}

/** The History tab: the repo's recent commits, one list that owns the whole panel. */
function renderLogPanel(g: GitStatus) {
  let html = "";
  const key = `${g.oid ?? ""}:${g.ahead}`;
  if (!g.oid) html += gitMsg(tr("還沒有提交"));
  else if (gitLog?.root === g.root) {
    if (gitLog.error) html += gitMsg(gitLog.error);
    else if (!gitLog.commits.length) html += gitMsg(tr("還沒有提交"));
    html += gitLog.commits
      .map((c) => {
        const title = `${c.hash.slice(0, 7)} · ${c.author}${c.unpushed ? ` · ${tr("未推送")}` : ""}`;
        return (
          `<div class="g-row g-commit${gitSel === `commit:${c.hash}` ? " sel" : ""}" data-hash="${c.hash}" title="${esc(title)}">` +
          `<span class="g-push${c.unpushed ? " on" : ""}"></span><span class="g-name">${esc(c.subject)}</span><span class="g-when">${esc(c.when)}</span></div>`
        );
      })
      .join("");
  } else html += gitMsg(tr("載入中…"));
  const top = gitBodyEl.scrollTop;
  gitBodyEl.innerHTML = html;
  gitBodyEl.scrollTop = top;
  if (g.oid && (gitLog?.root !== g.root || gitLog.key !== key)) loadGitLog(g, key);
}

async function loadGitLog(g: GitStatus, key: string) {
  // Mark first, so the render this triggers doesn't ask again.
  const prev = gitLog?.root === g.root ? gitLog.commits : [];
  gitLog = { root: g.root, key, commits: prev };
  try {
    const commits = await invoke<GitCommit[]>("git_log", { root: g.root, count: GIT_LOG_COUNT });
    if (gitLog?.key === key && gitLog.root === g.root) gitLog.commits = commits;
  } catch (e) {
    if (gitLog?.key === key && gitLog.root === g.root) gitLog.error = tr("讀取失敗：{e}", { e: String(e) });
  }
  renderGitPanel();
}

/** Diff and commit lines, colored the way `git diff` colors them. */
export function gitLines(text: string, allAdded = false): string {
  const lines = text.replace(/\n$/, "").split("\n");
  let html = lines
    .slice(0, GIT_VIEW_MAX_LINES)
    .map((l) => {
      const cls = allAdded
        ? "ga"
        : /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity |rename |old mode|new mode|Binary files )/.test(l)
          ? "gm"
          : l.startsWith("@@")
            ? "gh"
            : l.startsWith("+")
              ? "ga"
              : l.startsWith("-")
                ? "gd"
                : "";
      return `<div class="${cls}">${esc(l) || " "}</div>`;
    })
    .join("");
  if (lines.length > GIT_VIEW_MAX_LINES) html += `<div class="gn">${esc(tr("只顯示前 {n} 行", { n: GIT_VIEW_MAX_LINES }))}</div>`;
  return html;
}

/** Opens the overlay viewer with a loading line; returns the request number for isViewerCurrent. */
export function openViewer(title: string) {
  if (gitSel) {
    gitSel = "";
    renderGitPanel();
  }
  return showGitView(title);
}

/** False once the viewer was closed or reused for something newer. */
export const isViewerCurrent = (req: number) => req === gvReq && !gitViewEl.hidden;

function showGitView(title: string) {
  $("gv-title").textContent = title;
  gvBodyEl.innerHTML = `<div class="gn">${esc(tr("載入中…"))}</div>`;
  gitViewEl.hidden = false;
  document.body.classList.add("git-viewing");
  // Keys must not reach the hidden terminal underneath.
  gvBodyEl.focus();
  return ++gvReq;
}

export function closeGitView(refocus = true) {
  if (gitViewEl.hidden) return;
  gvReq++;
  gitViewEl.hidden = true;
  gvBodyEl.replaceChildren(); // a big diff shouldn't stay in the DOM
  document.body.classList.remove("git-viewing");
  gitSel = "";
  clearFileSel();
  renderGitPanel();
  if (refocus) activeTab()?.term.focus();
}

function fillGitView(req: number, r: GitText, allAdded = false, empty = tr("沒有差異")) {
  if (req !== gvReq) return;
  let html = r.binary ? `<div class="gn">${esc(tr("二進位檔案，不顯示內容"))}</div>` : r.text ? gitLines(r.text, allAdded) : `<div class="gn">${esc(empty)}</div>`;
  if (r.truncated) html += `<div class="gn">${esc(tr("內容太長，只顯示前面的部分"))}</div>`;
  gvBodyEl.innerHTML = html;
  gvBodyEl.scrollTop = 0;
}

function failGitView(req: number, e: unknown) {
  if (req === gvReq) gvBodyEl.innerHTML = `<div class="gn">${esc(tr("讀取失敗：{e}", { e: String(e) }))}</div>`;
}

gitBodyEl.addEventListener("click", (e) => {
  const sec = (e.target as HTMLElement).closest<HTMLElement>(".g-sec");
  if (sec?.dataset.sec) {
    const label = sec.dataset.sec;
    if (!collapsed.delete(label)) collapsed.add(label);
    try { localStorage.setItem("panex.gitCollapsed", JSON.stringify([...collapsed])); } catch { /* storage unavailable */ }
    return renderGitPanel();
  }
  const row = (e.target as HTMLElement).closest<HTMLElement>(".g-row");
  const g = activeTab()?.git;
  if (!row || !g) return;
  if (row.dataset.hash) {
    const hash = row.dataset.hash;
    gitSel = `commit:${hash}`;
    renderGitPanel();
    const subject = row.querySelector(".g-name")?.textContent ?? "";
    const req = showGitView(`${hash.slice(0, 7)}  ${subject}`);
    invoke<GitText>("git_show", { root: g.root, hash }).then((r) => fillGitView(req, r), (err) => failGitView(req, err));
    return;
  }
  const kind = row.dataset.kind as "staged" | "unstaged" | "untracked";
  const path = row.dataset.path ?? "";
  gitSel = `${kind}:${path}`;
  renderGitPanel();
  const label = kind === "staged" ? tr("已暫存") : kind === "untracked" ? tr("未追蹤") : tr("未暫存");
  const req = showGitView(`${path}  ·  ${label}`);
  invoke<GitText>("git_diff", { root: g.root, path, orig: row.dataset.orig || null, staged: kind === "staged", untracked: kind === "untracked" }).then(
    (r) => fillGitView(req, r, kind === "untracked", path.endsWith("/") ? tr("未追蹤的資料夾") : tr("空檔案")),
    (err) => failGitView(req, err),
  );
});
$("git-toggle").onclick = () => setGitOpen(!gitOpen);
$("git-close").onclick = () => setGitOpen(false);
$("git-refresh").onclick = () => {
  gitLog = undefined;
  markFilesStale();
  const tab = activeTab();
  if (tab) refreshGit(tab);
};
$("gv-close").onclick = () => closeGitView();
for (const b of document.querySelectorAll<HTMLElement>(".g-tab")) b.onclick = () => setPanelMode(b.dataset.mode as PanelMode);

// Drag the panel's left edge to resize it, like the sidebar.
const GIT_W = { min: 200, max: 560, def: 280 };
function setGitWidth(w: number, save = false) {
  const px = Math.round(Math.min(GIT_W.max, Math.max(GIT_W.min, w)));
  document.documentElement.style.setProperty("--git-w", `${px}px`);
  if (save) {
    try { localStorage.setItem("panex.gitWidth", String(px)); } catch { /* storage unavailable */ }
  }
}
try {
  const saved = Number(localStorage.getItem("panex.gitWidth"));
  if (saved) setGitWidth(saved);
} catch { /* storage unavailable */ }
gitResizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  gitResizer.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing-git");
});
gitResizer.addEventListener("pointermove", (e) => {
  if (gitResizer.hasPointerCapture(e.pointerId)) setGitWidth(window.innerWidth - e.clientX);
});
gitResizer.addEventListener("pointerup", (e) => {
  if (!gitResizer.hasPointerCapture(e.pointerId)) return;
  gitResizer.releasePointerCapture(e.pointerId);
  document.body.classList.remove("resizing-git");
  setGitWidth(gitEl.getBoundingClientRect().width, true);
});
gitResizer.addEventListener("dblclick", () => setGitWidth(GIT_W.def, true));

export const isGitOpen = () => gitOpen;
