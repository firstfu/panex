// The Files tab of the right panel: the current tab's whole project as a folder tree (what git
// tracks plus untracked files it doesn't ignore), with the Git tab's change letters on files and
// a dot on folders that contain changes. A file opens read only in the diff viewer's overlay:
// Markdown rendered, code with line numbers and highlighting, images shown. Anything else (PDF,
// spreadsheets, audio…) gets Quick Look / default app / reveal buttons. No editing, no watcher.

import { invoke } from "@tauri-apps/api/core";
import type { MarkdownIt, StateCore } from "markdown-it";
import type { HLJSApi } from "highlight.js";
import { t as tr } from "./i18n";
import { type Change, type DiffMarks, type TreeDir, ancestors, buildTree, changeMarks, diffMarks, fmtSize, isImage, isMarkdown, kindOf, langOf, resolveLink, slug } from "./tree";
import { type Tab } from "./types";
import { $, esc } from "./util";
import { activeTab } from "./state";
import { gitLines, isViewerCurrent, openViewer } from "./git-panel";
import { openLink } from "./links";
import { showNotice } from "./config";
import { IS_MAC } from "./platform";

// The tree is read when the tab is shown and again after each git status refresh (shell prompt,
// Claude Code Stop, window focus), and only while this tab is on screen.

const HIGHLIGHT_MAX = 300_000; // bigger files are shown plain: highlighting them would stall the UI
const OPEN_KEY = "panex.treeOpen";
const OPEN_ROOTS = 30; // remembered projects

interface FileText {
  text: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

const filesBodyEl = $("files-body");
const viewerBody = $("gv-body"); // the overlay shared with the Git panel
let list: { root: string; files: string[]; set: Set<string>; tree: TreeDir; truncated: boolean; error?: string } | undefined;
let stale = true;
let loading = "";
let sel = ""; // path of the file on screen
let selRoot = ""; // the root that file belongs to
let mdPromise: Promise<MarkdownIt> | undefined;
let hljsPromise: Promise<HLJSApi> | undefined;

/** Expanded folders per project root, remembered across launches (a personal preference). */
const opened: Record<string, string[]> = (() => {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") ?? {}; } catch { return {}; }
})();
const autoOpened = new Set<string>(); // "root|dir" already opened for its changes, so a manual collapse sticks
const openSet = (root: string) => new Set(opened[root] ?? []);
function saveOpen(root: string, set: Set<string>) {
  delete opened[root];
  opened[root] = [...set];
  const roots = Object.keys(opened);
  for (const r of roots.slice(0, Math.max(0, roots.length - OPEN_ROOTS))) delete opened[r];
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(opened)); } catch { /* storage unavailable */ }
}

/** The folder whose files are listed: the repo root, or the tab's folder outside git. */
function projectRoot(tab: Tab): string | undefined {
  return tab.git?.root ?? (tab.gitTimer || tab.gitBusy ? undefined : tab.cwd ?? undefined);
}

/** The next render re-reads the tree (files may have been added or removed). */
export function markFilesStale() {
  stale = true;
}

/** Called when the viewer closes. */
export function clearFileSel() {
  sel = "";
  shown = undefined;
}

const msg = (text: string) => `<div class="g-msg">${esc(text)}</div>`;

/** Uncommitted changes of the tab's repo, as tree.ts wants them (only when it is this tree's root). */
function changes(tab: Tab): Change[] {
  const g = tab.git;
  if (!g || g.root !== list?.root) return [];
  return g.files.map((f) => ({ path: f.path, letter: f.x === "?" ? "U" : f.y !== "." ? f.y : f.x }));
}

export function renderFilesPanel() {
  const tab = activeTab();
  if (!tab) return void filesBodyEl.replaceChildren();
  if (tab.ssh) return void (filesBodyEl.innerHTML = msg(tr("SSH 分頁看不到本機的檔案")));
  const root = projectRoot(tab);
  if (!root) return void (filesBodyEl.innerHTML = msg(tr("載入中…")));
  if (list?.root !== root || stale) loadTree(root);
  if (list?.root !== root) return void (filesBodyEl.innerHTML = msg(tr("載入中…")));
  if (list.error) return void (filesBodyEl.innerHTML = msg(list.error));

  const { letters, dirs } = changeMarks(list.files, changes(tab));
  const open = openSet(root);
  // Folders holding uncommitted changes open themselves the first time they show up.
  let added = false;
  for (const d of dirs) {
    const k = `${root}|${d}`;
    if (autoOpened.has(k)) continue;
    autoOpened.add(k);
    if (!open.has(d)) { open.add(d); added = true; }
  }
  if (added) saveOpen(root, open);
  const out: string[] = [];
  const pad = (depth: number) => `style="padding-left:${10 + depth * 14}px"`;
  const walk = (d: TreeDir, depth: number) => {
    for (const sub of d.dirs) {
      const isOpen = open.has(sub.path);
      out.push(
        `<div class="g-row f-row f-dir${isOpen ? " open" : ""}${dirs.has(sub.path) ? " chg" : ""}" data-dir="${esc(sub.path)}" ${pad(depth)} title="${esc(sub.path)}">` +
          `<span class="f-chev"></span><span class="g-name">${esc(sub.name)}</span>` +
          (dirs.has(sub.path) ? `<span class="f-dot" title="${esc(tr("裡面有未提交的變更"))}"></span>` : "") +
          `</div>`,
      );
      if (isOpen) walk(sub, depth + 1);
    }
    for (const name of d.files) {
      const path = d.path ? `${d.path}/${name}` : name;
      const letter = letters.get(path);
      out.push(
        `<div class="g-row f-row f-file${sel === path ? " sel" : ""}${letter ? ` chg-${letter === "U" ? "new" : esc(letter)}` : ""}" data-path="${esc(path)}" ${pad(depth)} title="${esc(path)}">` +
          `<span class="f-chev"></span><span class="g-name">${esc(name)}</span>` +
          (letter ? `<span class="g-st ${letter === "U" ? "new" : esc(letter)}">${esc(letter)}</span>` : "") +
          `</div>`,
      );
    }
  };
  walk(list.tree, 0);
  const name = root.split(/[\\/]/).filter(Boolean).pop() || root;
  let html =
    `<div class="g-repo f-head"><div class="g-branch" title="${esc(root)}">${esc(name)}</div>` +
    `<div class="g-sync">${esc(tr("{n} 個檔案", { n: list.files.length }))}</div>` +
    (open.size ? `<button class="f-collapse" title="${esc(tr("全部收合"))}" aria-label="${esc(tr("全部收合"))}">⊟</button>` : "") +
    `</div>`;
  if (!list.files.length) html += msg(tr("這個資料夾是空的"));
  html += out.join("");
  if (list.truncated) html += msg(tr("檔案太多，只列出一部分"));
  const scroll = filesBodyEl.scrollTop;
  filesBodyEl.innerHTML = html;
  filesBodyEl.scrollTop = scroll;
}

async function loadTree(root: string) {
  if (loading === root) return;
  loading = root;
  stale = false;
  try {
    const r = await invoke<{ files: string[]; truncated: boolean }>("project_tree", { root });
    list = { root, files: r.files, set: new Set(r.files), tree: buildTree(r.files), truncated: r.truncated };
  } catch (e) {
    list = { root, files: [], set: new Set(), tree: buildTree([]), truncated: false, error: tr("讀取失敗：{e}", { e: String(e) }) };
  } finally {
    loading = "";
  }
  renderFilesPanel();
}

/** highlight.js (its common languages), loaded the first time a file is opened. */
function highlighter(): Promise<HLJSApi> {
  hljsPromise ??= import("highlight.js/lib/common").then((m) => m.default);
  return hljsPromise;
}

function highlight(hljs: HLJSApi, code: string, lang: string): string {
  if (!lang || code.length > HIGHLIGHT_MAX || !hljs.getLanguage(lang)) return esc(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return esc(code);
  }
}

/** markdown-it, loaded on first use so it costs nothing until a document is opened. */
function markdown(): Promise<MarkdownIt> {
  mdPromise ??= Promise.all([import("markdown-it"), highlighter()]).then(([{ default: MarkdownIt }, hljs]) => {
    // html: false — raw HTML in a document is shown as text, never run: this page can drive the shells.
    const md = new MarkdownIt({ html: false, linkify: true, highlight: (code, lang) => highlight(hljs, code, lang) });
    // Images would be fetched from the network or the app's own origin; show the alt text instead.
    md.renderer.rules.image = (tokens, i) => `<span class="md-img">🖼 ${esc(tokens[i].content || String(tokens[i].attrGet("src") ?? ""))}</span>`;
    // Anchors get an "md-" prefix so a heading can't collide with the app's own element ids.
    md.core.ruler.push("panex_heading_ids", (state: StateCore) => {
      const used = new Map<string, number>();
      state.tokens.forEach((tok, i) => {
        if (tok.type !== "heading_open") return;
        const base = slug(state.tokens[i + 1]?.content ?? "");
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        tok.attrSet("id", `md-${n ? `${base}-${n}` : base}`);
      });
    });
    return md;
  });
  return mdPromise;
}

/**
 * Code with a line-number gutter; the two columns share one line height so they stay aligned.
 * Uncommitted changes are drawn as a band layer over the same lines: green on added or edited
 * lines, a red edge where lines were removed.
 */
function codeHtml(hljs: HLJSApi, path: string, text: string, marks?: DiffMarks): string {
  const body = text.replace(/\n$/, "");
  const lines = body.split("\n").length;
  const nums = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  let bands = "";
  if (marks) {
    const rows: string[] = [];
    for (let n = 1; n <= lines; n++) rows.push(`<div${marks.added.has(n) ? ' class="b-add"' : marks.removedAt.has(n) ? ' class="b-del"' : ""}> </div>`);
    if (marks.removedAt.has(lines + 1)) rows[lines - 1] = rows[lines - 1].replace("<div", `<div data-del-end="1"`);
    bands = `<div class="f-bands" aria-hidden="true">${rows.join("")}</div>`;
  }
  return `<div class="f-code">${bands}<pre class="f-ln" aria-hidden="true">${nums}</pre><pre class="f-src hljs">${highlight(hljs, body, langOf(path))}</pre></div>`;
}

/** The bar over a changed file: how much changed, and a switch between the file and its diff. */
function changeBar(m: DiffMarks, showingDiff: boolean): string {
  return (
    `<div class="f-chgbar"><span class="f-add">+${m.adds}</span><span class="f-del">−${m.dels}</span>` +
    `<span class="f-chgnote">${esc(tr("相對於最近一次提交"))}</span><span class="f-mgap"></span>` +
    `<button class="f-act" data-diff-toggle="1">${esc(tr(showingDiff ? "看全文" : "看差異"))}</button></div>`
  );
}

/** The open file's two renderings when it has uncommitted changes (see the toggle below). */
let shown: { file: string; diff: string; marks: DiffMarks; diffOn: boolean } | undefined;

/** Uncommitted diff of one file against HEAD; undefined when it isn't changed or git can't say. */
async function headDiff(root: string, path: string): Promise<string | undefined> {
  const tab = activeTab();
  if (!tab || tab.git?.root !== root) return undefined;
  const letter = changes(tab).find((c) => c.path === path)?.letter;
  if (!letter || letter === "U") return undefined; // untracked: the whole file is new, nothing to compare
  try {
    const r = await invoke<{ text: string; binary: boolean }>("git_diff", { root, path, orig: null, staged: false, untracked: false, head: true });
    return r.binary || !r.text ? undefined : r.text;
  } catch {
    return undefined;
  }
}

/** Buttons that hand the open file to the system; Quick Look only exists on macOS. */
function actionsHtml(): string {
  const btn = (act: string, label: string) => `<button class="f-act" data-file-act="${act}">${esc(tr(label))}</button>`;
  return (IS_MAC ? btn("quicklook", "快速查看") : "") + btn("open", "用預設 App 開啟") + btn("reveal", IS_MAC ? "在 Finder 中顯示" : "在檔案總管中顯示");
}

/** A file the panel can't show: what it is, how big, and the ways to open it. */
function otherHtml(path: string, size: number, note = ""): string {
  const name = path.split("/").pop()!;
  return (
    `<div class="f-other"><div class="f-kind">${esc(tr(kindOf(path)))}</div><div class="f-oname">${esc(name)}</div>` +
    `<div class="f-osize">${esc(fmtSize(size))}${note ? ` · ${esc(note)}` : ""}</div>` +
    `<div class="f-acts">${actionsHtml()}</div>` +
    (IS_MAC ? `<div class="f-ohint">${esc(tr("快速查看可以預覽 PDF、Office 文件、音訊與影片"))}</div>` : "") +
    `</div>`
  );
}

function imageHtml(path: string, url: string, size: number): string {
  const svg = /\.svg$/i.test(path);
  return (
    `<div class="f-media"><div class="f-mbar"><span class="f-dim"></span><span>${esc(fmtSize(size))}</span>` +
    (svg ? `<button class="f-act" data-file-act="source">${esc(tr("看原始碼"))}</button>` : "") +
    `<span class="f-mgap"></span>${actionsHtml()}</div>` +
    `<div class="f-stage"><img alt="${esc(path)}" src="${url}" /></div></div>`
  );
}

async function openFile(root: string, path: string, anchor = "", source = false) {
  sel = path;
  selRoot = root;
  // Show where the file is: a link from another file may land in a collapsed folder.
  const open = openSet(root);
  const missing = ancestors(path).filter((d) => !open.has(d));
  if (missing.length) {
    missing.forEach((d) => open.add(d));
    saveOpen(root, open);
  }
  renderFilesPanel();
  filesBodyEl.querySelector(`.f-file[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
  const req = openViewer(path);
  try {
    if (isImage(path) && !source) {
      const img = await invoke<{ url: string; size: number }>("file_image", { root, path });
      if (!isViewerCurrent(req)) return;
      viewerBody.innerHTML = img.url ? imageHtml(path, img.url, img.size) : otherHtml(path, img.size, tr("圖片太大，不在這裡顯示"));
      const el = viewerBody.querySelector<HTMLImageElement>(".f-stage img");
      el?.addEventListener("load", () => {
        const dim = viewerBody.querySelector(".f-dim");
        if (dim && el.naturalWidth) dim.textContent = `${el.naturalWidth} × ${el.naturalHeight}`;
      });
      return;
    }
    const [r, hljs, diff] = await Promise.all([invoke<FileText>("file_read", { root, path }), highlighter(), headDiff(root, path)]);
    const marks = diff && !r.binary && !r.truncated ? diffMarks(diff) : undefined;
    let html: string;
    if (r.binary) html = otherHtml(path, r.size);
    else if (!r.text) html = `<div class="gn">${esc(tr("空檔案"))}</div>`;
    else if (isMarkdown(path)) html = `<div class="md">${(await markdown()).render(r.text)}</div>`;
    else html = codeHtml(hljs, path, r.text, marks);
    if (r.truncated) html += `<div class="gn">${esc(tr("內容太長，只顯示前面的部分"))}</div>`;
    if (!isViewerCurrent(req)) return;
    shown = marks && diff ? { file: html, diff: gitLines(diff), marks, diffOn: false } : undefined;
    if (shown) html = changeBar(shown.marks, false) + html;
    viewerBody.innerHTML = html;
    viewerBody.scrollTop = 0;
    if (anchor) scrollToAnchor(anchor);
  } catch (e) {
    if (isViewerCurrent(req)) viewerBody.innerHTML = `<div class="gn">${esc(tr("讀取失敗：{e}", { e: String(e) }))}</div>`;
  }
}

function scrollToAnchor(anchor: string) {
  let id = anchor;
  try { id = decodeURIComponent(anchor); } catch { /* keep as is */ }
  viewerBody.querySelector(`[id="${CSS.escape(`md-${slug(id)}`)}"]`)?.scrollIntoView();
}

function toggleDir(root: string, dir: string) {
  const open = openSet(root);
  if (!open.delete(dir)) open.add(dir);
  saveOpen(root, open);
  renderFilesPanel();
}

filesBodyEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (!list) return;
  if (target.closest(".f-collapse")) {
    saveOpen(list.root, new Set());
    return renderFilesPanel();
  }
  const row = target.closest<HTMLElement>(".f-row");
  if (row?.dataset.dir !== undefined) toggleDir(list.root, row.dataset.dir);
  else if (row?.dataset.path) openFile(list.root, row.dataset.path);
});

// A changed file's switch between the file (changes marked) and its plain diff.
viewerBody.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("[data-diff-toggle]") || !shown) return;
  shown.diffOn = !shown.diffOn;
  viewerBody.innerHTML = changeBar(shown.marks, shown.diffOn) + (shown.diffOn ? shown.diff : shown.file);
  viewerBody.scrollTop = 0;
});

// The open file's system buttons, and an SVG's "view source".
viewerBody.addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>("[data-file-act]")?.dataset.fileAct;
  if (!act || !sel) return;
  if (act === "source") return void openFile(selRoot, sel, "", true);
  invoke("file_action", { root: selRoot, path: sel, action: act }).catch((err) => showNotice(String(err)));
});

// Links inside a rendered document never navigate the app's page.
viewerBody.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>(".md a[href]");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("#")) return scrollToAnchor(href.slice(1));
  if (/^https?:/i.test(href)) return void openLink("open_url", { url: href });
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || !sel) return; // mailto: and other schemes
  const [rawPath, anchor = ""] = href.split("#");
  let path = rawPath;
  try { path = decodeURIComponent(rawPath); } catch { /* keep as is */ }
  const target = resolveLink(sel, path.replace(/\/$/, ""));
  if (!target || list?.root !== selRoot) return;
  if (list.set.has(target)) return void openFile(selRoot, target, anchor);
  // A folder: open it and everything above it in the tree.
  if (list.files.some((f) => f.startsWith(`${target}/`))) {
    const open = openSet(selRoot);
    [...ancestors(`${target}/x`)].forEach((d) => open.add(d));
    saveOpen(selRoot, open);
    renderFilesPanel();
    filesBodyEl.querySelector(`.f-dir[data-dir="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "nearest" });
  }
});
