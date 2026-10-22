// Global keyboard and mouse handling: shortcut and chord matching, Ctrl+wheel zoom, clicks
// on the sidebar and tab bar, drag to reorder, files dropped from Explorer, sidebar resizing.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { IS_MAC } from "./platform";
import { ACTIONS, digitFamily, eventCombo } from "./keys";
import { $ } from "./util";
import { S, activeTab, tabs, workspaces } from "./state";
import { setFontSize, updateSettings } from "./config";
import { termsEl } from "./terminal";
import { askCloseTab, askCloseWorkspaces, moveTab, newTab, newWorkspace, showTab, showWorkspace } from "./workspaces";
import { groupLead, groupMembers, isCollapsed, placeRun, sameRepo, setCollapsed } from "./groups";
import { wtEl } from "./worktree-dialog";
import { closeGitView, gitViewEl } from "./git-panel";
import { closeSearch, searchEl } from "./search";
import { startRename } from "./rename";
import { scheduleRender, shellMenuEl, tabbarEl, wsListEl } from "./render";
import { closeAskEl } from "./close-ask";
import { wtRmEl } from "./worktree-remove";
import { ctxEl, groupMenu, hideCtx, showCtx, tabMenu, wsMenu } from "./context-menu";
import { captureKey, closeSettings, isCapturing, openSettings, settingsEl } from "./settings-panel";
import { copySelection, runAction } from "./actions";

let chord: { steps: string[]; timer: number } | undefined;
let dragging = false;

function stop(e: KeyboardEvent, fn: () => void) {
  e.preventDefault();
  e.stopPropagation();
  fn();
}

/** Finds the action for a combo: exact single-combo bindings, digit families, then chord starts. */
function matchCombo(combo: string, step: number, prefix: string[]): { id: string; digit: number; partial: boolean } | undefined {
  const fam = digitFamily(combo);
  for (const a of ACTIONS) {
    for (const steps of S.bindings.get(a.id) ?? []) {
      if (steps.length <= step || prefix.some((p, k) => steps[k] !== p)) continue;
      const want = steps[step];
      const hit = want === combo ? 0 : a.digits && fam && want === fam.family ? fam.digit : -1;
      if (hit < 0) continue;
      return { id: a.id, digit: hit, partial: steps.length > step + 1 };
    }
  }
}

// The modifiers of the default digit shortcuts (workspaces Ctrl/⌘+1–9, tabs Alt/⌥+1–9).
const HINT_KEY = IS_MAC ? "Meta" : "Control";

// Capture phase, so app shortcuts win over xterm.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === HINT_KEY || e.key === "Alt") document.body.classList.add("show-nums");
    if (S.renaming || !wtEl.hidden || !closeAskEl.hidden || !wtRmEl.hidden) return;
    if (!gitViewEl.hidden && e.key === "Escape") return stop(e, () => closeGitView());
    // Esc in the search box closes it; with the terminal focused it still goes to the program (interrupting Claude).
    if (e.key === "Escape" && searchEl.contains(document.activeElement)) return stop(e, () => closeSearch());
    if (isCapturing()) return stop(e, () => captureKey(e));
    const combo = eventCombo(e);
    if (!settingsEl.hidden || !ctxEl.hidden) {
      if (e.key === "Escape") return stop(e, () => (hideCtx(), closeSettings()));
      // Inside the settings panel only its own toggle works; typing goes to the form fields.
      if (combo && S.bindings.get("openSettings")?.some((s) => s.length === 1 && s[0] === combo)) stop(e, closeSettings);
      return;
    }
    if (!combo) return;

    const prefix = chord?.steps ?? [];
    const m = matchCombo(combo, prefix.length, prefix);
    if (chord) {
      clearTimeout(chord.timer);
      chord = undefined;
    }
    if (m?.partial) {
      // First key(s) of a chord: wait up to 1.5 s for the next one.
      return stop(e, () => (chord = { steps: [...prefix, combo], timer: window.setTimeout(() => (chord = undefined), 1500) }));
    }
    if (m) return stop(e, () => runAction(m.id, m.digit));
    if (prefix.length) return stop(e, () => {}); // wrong second key: swallow it, like VS Code

    // macOS copies and pastes with ⌘, so Ctrl+C / Ctrl+V always belong to the terminal there.
    if (IS_MAC) return;
    const tab = activeTab();
    if (S.settings.smartCopyPaste && combo === "ctrl+c" && tab?.term.hasSelection()) return stop(e, () => copySelection(tab));
    // Keep xterm from sending ^V; the browser then fires a paste event that xterm handles.
    if (S.settings.smartCopyPaste && combo === "ctrl+v") return e.stopPropagation();
  },
  true,
);
document.addEventListener("keyup", (e) => {
  if (e.key === HINT_KEY || e.key === "Alt") document.body.classList.remove("show-nums");
});
window.addEventListener("blur", () => document.body.classList.remove("show-nums"));

// Ctrl+wheel (⌘+wheel on macOS) zooms like a browser / Windows Terminal.
termsEl.addEventListener(
  "wheel",
  (e) => {
    if (!(IS_MAC ? e.metaKey : e.ctrlKey) || gitViewEl.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    setFontSize(S.settings.fontSize + (e.deltaY < 0 ? 1 : -1));
  },
  { capture: true, passive: false },
);

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const t = e.target as HTMLElement;
  const ws = workspaces.get(t.closest<HTMLElement>("[data-ws]")?.dataset.ws ?? "");
  const tab = tabs.get(t.closest<HTMLElement>("[data-tab]")?.dataset.tab ?? "");
  const group = t.closest<HTMLElement>("[data-group]")?.dataset.group;
  if (group) showCtx(e.clientX, e.clientY, groupMenu(group));
  else if (ws) showCtx(e.clientX, e.clientY, wsMenu(ws));
  else if (tab) showCtx(e.clientX, e.clientY, tabMenu(tab));
  else hideCtx();
});
document.addEventListener("mousedown", (e) => {
  if (!ctxEl.hidden && !ctxEl.contains(e.target as Node)) hideCtx();
});

// Double-click is detected by hand: the first click re-renders the list, and a native
// dblclick doesn't fire when its target was replaced between the two clicks.
let lastClick = { id: "", at: 0 };
function isDoubleClick(id: string) {
  const now = performance.now();
  const dbl = lastClick.id === id && now - lastClick.at < 450;
  lastClick = dbl ? { id: "", at: 0 } : { id, at: now };
  return dbl;
}

wsListEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest(".rename-input")) return;
  const group = target.closest<HTMLElement>("[data-group]")?.dataset.group;
  if (group) return setCollapsed(group, !isCollapsed(group));
  const id = target.closest<HTMLElement>("[data-ws]")?.dataset.ws;
  if (!id) return;
  // The caret on a group's main workspace folds the group; the rest of that row selects it.
  const own = workspaces.get(id)?.group;
  if (own && target.closest("[data-caret]")) return setCollapsed(own, !isCollapsed(own));
  if (target.closest(".t-close")) return askCloseWorkspaces([id]);
  if (isDoubleClick(id)) return startRename("ws", id);
  showWorkspace(id);
});
tabbarEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest(".rename-input")) return;
  if (target.closest(".h-add")) return newTab();
  const id = target.closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (!id) return;
  if (target.closest(".h-close")) return askCloseTab(id);
  if (isDoubleClick(id)) return startRename("tab", id);
  showTab(id);
});
// Double-clicking the empty part of the tab bar opens a tab, like browsers.
tabbarEl.addEventListener("dblclick", (e) => {
  if (e.target === tabbarEl) newTab();
});
// Middle click closes, like browser tabs.
wsListEl.addEventListener("auxclick", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-ws]")?.dataset.ws;
  if (e.button === 1 && id) askCloseWorkspaces([id]);
});
tabbarEl.addEventListener("auxclick", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (e.button === 1 && id) askCloseTab(id);
});

// Drag to reorder: workspaces vertically in the sidebar, tabs horizontally in the bar.
// Pointer events rather than HTML5 drag-and-drop: the window must keep native file drop on
// (dragDropEnabled), and WebView2 then no longer delivers HTML5 drag events to the page.
function clearDropMarks() {
  document.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
}
/** What a drag moves (`run`), and where it may land under the pointer. */
interface DragPick {
  el: HTMLElement; // dimmed while dragging
  run: string[];
  targetAt(node: Element | null): { el: HTMLElement; run: string[] } | undefined;
}
function wireDrag(
  container: HTMLElement,
  horizontal: boolean,
  pick: (target: HTMLElement) => DragPick | undefined,
  drop: (run: string[], target: string[], after: boolean) => void,
) {
  container.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || S.renaming || t.closest("input")) return;
    const p = pick(t);
    if (!p) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let target: { run: string[]; after: boolean } | undefined;

    const onMove = (m: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(m.clientX - startX, m.clientY - startY) < 5) return;
        dragging = true;
        document.body.classList.add("reordering");
        p.el.classList.add("dragging");
      }
      clearDropMarks();
      target = undefined;
      const over = p.targetAt(document.elementFromPoint(m.clientX, m.clientY));
      if (!over || !container.contains(over.el)) return;
      const r = over.el.getBoundingClientRect();
      const after = horizontal ? m.clientX > r.left + r.width / 2 : m.clientY > r.top + r.height / 2;
      over.el.classList.add(after ? "drop-after" : "drop-before");
      target = { run: over.run, after };
    };
    const end = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("reordering");
      clearDropMarks();
      // The release would otherwise count as a click and switch to the dragged item.
      const swallow = (c: Event) => c.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 100);
      if (target) drop(p.run, target.run, target.after);
      scheduleRender();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  });
}

// Sidebar: a workspace in a group moves only among its group; anything else (a lone workspace,
// or a whole group dragged by its header) moves among the top-level rows and groups.
const topLevel = (n: Element | null) => {
  let el = n as HTMLElement | null;
  while (el && el.parentElement !== wsListEl) el = el.parentElement;
  return el ?? undefined;
};
const runOf = (el: HTMLElement) => (el.classList.contains("ws-group") ? groupMembers(el.dataset.repo!) : [el.dataset.ws!]);
function pickWorkspace(t: HTMLElement): DragPick | undefined {
  const head = t.closest<HTMLElement>("[data-group]");
  const row = t.closest<HTMLElement>("[data-ws]");
  const group = !head && row ? workspaces.get(row.dataset.ws!)?.group : undefined;
  // A group's main workspace is its top row: dragging it moves the whole group, like the header.
  const lead = group ? groupLead(group, groupMembers(group)) : undefined;
  if (row && group && row.dataset.ws !== lead) {
    return {
      el: row,
      run: [row.dataset.ws!],
      targetAt: (n) => {
        const o = (n as HTMLElement | null)?.closest?.<HTMLElement>("[data-ws]");
        return o && o.dataset.ws !== lead && sameRepo(workspaces.get(o.dataset.ws!)?.group, group) ? { el: o, run: [o.dataset.ws!] } : undefined;
      },
    };
  }
  const el = topLevel(head ?? row);
  if (!el) return;
  return {
    el,
    run: runOf(el),
    targetAt: (n) => {
      const o = topLevel(n);
      return o && { el: o, run: runOf(o) };
    },
  };
}
function pickTab(t: HTMLElement): DragPick | undefined {
  const el = t.closest<HTMLElement>("[data-tab]");
  if (!el) return;
  return {
    el,
    run: [el.dataset.tab!],
    targetAt: (n) => {
      const o = (n as HTMLElement | null)?.closest?.<HTMLElement>("[data-tab]");
      return o ? { el: o, run: [o.dataset.tab!] } : undefined;
    },
  };
}
function dropTab([id]: string[], [over]: string[], after: boolean) {
  const list = workspaces.get(tabs.get(id)?.wsId ?? "")?.tabs;
  if (!list) return;
  const from = list.indexOf(id);
  let to = list.indexOf(over) + (after ? 1 : 0);
  if (from < to) to--;
  moveTab(id, to);
}
// Files dragged in from Explorer: type their paths into the current terminal, quoted when they
// contain spaces (what Windows Terminal does). Goes through paste, so a program that asked for
// bracketed paste (Claude Code) sees one paste and can pick up image paths.
getCurrentWebview()
  .onDragDropEvent((e) => {
    const p = e.payload;
    document.body.classList.toggle("file-over", p.type === "over" || p.type === "enter");
    if (p.type !== "drop" || !p.paths.length) return;
    const tab = activeTab();
    if (!tab) return;
    tab.term.paste(p.paths.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(" ") + " ");
    tab.term.focus();
  })
  .catch(() => {});

wireDrag(wsListEl, false, pickWorkspace, placeRun);
wireDrag(tabbarEl, true, pickTab, dropTab);

// Drag the sidebar's right edge to resize it; the width is a per-machine UI preference.
const SIDEBAR_W = { min: 160, max: 280, def: 220 };
const sidebarResizer = $("sidebar-resizer");
function setSidebarWidth(w: number, save = false) {
  const px = Math.round(Math.min(SIDEBAR_W.max, Math.max(SIDEBAR_W.min, w)));
  document.documentElement.style.setProperty("--sidebar-w", `${px}px`);
  if (save) {
    try { localStorage.setItem("panex.sidebarWidth", String(px)); } catch { /* storage unavailable */ }
  }
}
try {
  const saved = Number(localStorage.getItem("panex.sidebarWidth"));
  if (saved) setSidebarWidth(saved);
} catch { /* storage unavailable */ }
sidebarResizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  sidebarResizer.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing-sidebar");
});
sidebarResizer.addEventListener("pointermove", (e) => {
  if (sidebarResizer.hasPointerCapture(e.pointerId)) setSidebarWidth(e.clientX);
});
sidebarResizer.addEventListener("pointerup", (e) => {
  if (!sidebarResizer.hasPointerCapture(e.pointerId)) return;
  sidebarResizer.releasePointerCapture(e.pointerId);
  document.body.classList.remove("resizing-sidebar");
  setSidebarWidth($("sidebar").getBoundingClientRect().width, true);
});
sidebarResizer.addEventListener("dblclick", () => setSidebarWidth(SIDEBAR_W.def, true));

$("sidebar-toggle").onclick = () => updateSettings({ sidebarHidden: !S.settings.sidebarHidden });
$("new-tab").onclick = () => newWorkspace();
$("shell-menu-btn").onclick = () => (shellMenuEl.hidden = !shellMenuEl.hidden);
$("settings-btn").onclick = openSettings;

let resizeTimer: number | undefined;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const tab = activeTab();
    if (tab?.opened) tab.fit.fit();
  }, 30);
}).observe(termsEl);
