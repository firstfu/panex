// Ctrl/⌘+click in the terminal: web links (addon) and file paths (our own provider), the
// latter linked only once the backend confirms the file exists.

import { type IBufferLine, type ILink, type ILinkProvider } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { IS_MAC } from "./platform";
import { type Tab } from "./types";
import { S } from "./state";
import { showNotice } from "./config";

const LINK_KEY = IS_MAC ? "⌘" : "Ctrl";
// A plain click stays a click (selecting text); only Ctrl/⌘+click opens.
export const linkClick = (e: MouseEvent) => (IS_MAC ? e.metaKey : e.ctrlKey);
export const linkHint = (tab: Tab, on: boolean) => (tab.el.title = on ? tr("按住 {key} 點擊開啟", { key: LINK_KEY }) : "");
export const openLink = (cmd: string, args: Record<string, unknown>) => invoke(cmd, args).catch((e) => showNotice(String(e)));

// One path segment: no separators, whitespace, or characters that don't occur in file names or
// usually wrap them in output (quotes, brackets, commas…).
const SEG = String.raw`[^\s\\/:"'` + "`" + String.raw`<>|*?()\[\]{},;]+`;
// [C:|~][/]dir/dir/name[:line[:col]]
const PATH_RE = new RegExp(String.raw`(?:[A-Za-z]:|~)?[\\/]?(?:${SEG}[\\/])*${SEG}(?::(\d+)(?::(\d+))?)?`, "g");

/** A buffer line's text plus, for each UTF-16 unit, the 1-based cell column and width it occupies (CJK takes two). */
function lineCells(line: IBufferLine, cols: number) {
  let text = "";
  const at: number[] = [];
  const wid: number[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const w = cell.getWidth();
    if (w === 0) continue; // right half of a wide character
    const ch = cell.getChars() || " ";
    for (let k = 0; k < ch.length; k++) at.push(x + 1), wid.push(w);
    text += ch;
  }
  return { text, at, wid };
}

/** File paths printed in the terminal (`src/main.ts:120`, `D:\x\y.rs`), linked only if they exist. Not for SSH tabs: remote paths can't be opened here. */
export function fileLinks(tab: Tab): ILinkProvider {
  return {
    provideLinks(y, done) {
      const line = tab.term.buffer.active.getLine(y - 1);
      if (tab.ssh || !line) return done(undefined);
      const { text, at, wid } = lineCells(line, tab.term.cols);
      const found: { path: string; line?: number; col?: number; start: number; end: number }[] = [];
      for (const m of text.matchAll(PATH_RE)) {
        // Starting mid-token means part of a URL or longer word, e.g. the "/x.com/a" of "https://x.com/a".
        if (m.index > 0 && /[\w/\\:.~-]/.test(text[m.index - 1])) continue;
        const path = m[0].replace(/:\d+(?::\d+)?$/, "").replace(/\.+$/, ""); // drop the line suffix and a sentence's full stop
        if (path.length < 2 || !(/[\\/]/.test(path) || /\.[A-Za-z][\w-]*$/.test(path))) continue;
        const len = m[1] ? m[0].length : path.length;
        found.push({ path, line: m[1] ? +m[1] : undefined, col: m[2] ? +m[2] : undefined, start: m.index, end: m.index + len });
        if (found.length >= 32) break;
      }
      if (!found.length) return done(undefined);
      invoke<(string | null)[]>("links_resolve", { cwd: tab.cwd ?? null, paths: found.map((f) => f.path) }).then(
        (resolved) => {
          const links: ILink[] = [];
          found.forEach((f, i) => {
            const path = resolved[i];
            if (!path) return;
            links.push({
              range: { start: { x: at[f.start], y }, end: { x: at[f.end - 1] + wid[f.end - 1] - 1, y } },
              text: text.slice(f.start, f.end),
              activate: (e) =>
                linkClick(e) && openLink("open_file", { path, line: f.line ?? null, col: f.col ?? null, editor: S.settings.openFilesWith }),
              hover: () => linkHint(tab, true),
              leave: () => linkHint(tab, false),
            });
          });
          done(links.length ? links : undefined);
        },
        () => done(undefined),
      );
    },
  };
}
