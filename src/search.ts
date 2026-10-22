// The scrollback find bar. The search addon is a separate chunk loaded on first use.

import { t as tr } from "./i18n";
import { type Tab } from "./types";
import { $ } from "./util";
import { activeTab } from "./state";

export const searchEl = $("search");
const searchInput = $<HTMLInputElement>("search-input");
const searchCountEl = $("search-count");
let searchTab: Tab | undefined;
// Decoration colors must be #RRGGBB.
const SEARCH_DECOR = {
  matchBackground: "#4d3d0a",
  matchOverviewRuler: "#eab308",
  activeMatchBackground: "#a16207",
  activeMatchBorder: "#fbbf24",
  activeMatchColorOverviewRuler: "#f59e0b",
};

/** Opens the find bar over the visible terminal; the search addon is fetched and loaded only on first use. */
export async function openSearch() {
  const tab = activeTab();
  if (!tab?.opened) return;
  if (!tab.search) {
    const { SearchAddon } = await import("@xterm/addon-search");
    tab.search ??= new SearchAddon();
    tab.term.loadAddon(tab.search);
    tab.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (searchTab !== tab) return;
      searchCountEl.textContent = !searchInput.value
        ? ""
        : resultCount === 0
          ? tr("沒有符合")
          : resultIndex < 0
            ? `${resultCount}+`
            : `${resultIndex + 1} / ${resultCount}`;
    });
  }
  searchTab = tab;
  const sel = tab.term.getSelection();
  if (sel && !sel.includes("\n")) searchInput.value = sel;
  searchEl.hidden = false;
  searchInput.focus();
  searchInput.select();
  if (searchInput.value) runSearch(true);
}

function runSearch(next: boolean, incremental = false) {
  const s = searchTab?.search;
  if (!s) return;
  const q = searchInput.value;
  if (!q) {
    s.clearDecorations();
    searchCountEl.textContent = "";
    return;
  }
  const opts = { decorations: SEARCH_DECOR, incremental };
  if (next) s.findNext(q, opts);
  else s.findPrevious(q, opts);
}

export function closeSearch(focusTerm = true) {
  if (searchEl.hidden) return;
  searchEl.hidden = true;
  searchTab?.search?.clearDecorations();
  if (focusTerm) searchTab?.term.focus();
  searchTab = undefined;
}

// Typing searches from the current match on (incremental); Enter / Shift+Enter step through.
searchInput.addEventListener("input", () => runSearch(true, true));
searchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  runSearch(!e.shiftKey);
});
$("search-next").addEventListener("click", () => runSearch(true));
$("search-prev").addEventListener("click", () => runSearch(false));
$("search-close").addEventListener("click", () => closeSearch());
