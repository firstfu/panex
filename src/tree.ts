// Pure helpers for the Files panel (no DOM, no Tauri, so tests can load them): turning the flat
// file list into a folder tree, marking where uncommitted changes are, resolving links between
// files, heading anchors and the highlight language of a file.

export interface TreeDir {
  name: string;
  path: string; // "" for the root, else "a/b"
  dirs: TreeDir[];
  files: string[]; // file names (not paths), sorted
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/** Builds the folder tree of root-relative "/" paths; folders and files each sorted by name. */
export function buildTree(paths: string[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  const index = new Map<string, TreeDir>([["", root]]);
  for (const p of paths) {
    const parts = p.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = index.get(path);
      if (!next) {
        next = { name: parts[i], path, dirs: [], files: [] };
        index.set(path, next);
        dir.dirs.push(next);
      }
      dir = next;
    }
    dir.files.push(parts[parts.length - 1]);
  }
  const sort = (d: TreeDir) => {
    d.dirs.sort((a, b) => byName(a.name, b.name));
    d.files.sort(byName);
    d.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

/** A changed path as git status reports it: folders of untracked files end with "/". */
export interface Change {
  path: string;
  letter: string;
}

/**
 * Per-file letters (M, A, D, R, U…) for the listed files, and the set of folders containing a
 * change, so a collapsed folder still shows that an agent touched something inside.
 */
export function changeMarks(files: string[], changes: Change[]): { letters: Map<string, string>; dirs: Set<string> } {
  const letters = new Map<string, string>();
  const folders = changes.filter((c) => c.path.endsWith("/"));
  for (const c of changes) if (!c.path.endsWith("/")) letters.set(c.path, c.letter);
  if (folders.length) {
    for (const f of files) {
      const hit = folders.find((c) => f.startsWith(c.path));
      if (hit && !letters.has(f)) letters.set(f, hit.letter);
    }
  }
  const dirs = new Set<string>();
  for (const p of [...letters.keys(), ...folders.map((c) => c.path.slice(0, -1))]) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    if (p.endsWith("/") || folders.some((c) => c.path === `${p}/`)) dirs.add(p);
  }
  return { letters, dirs };
}

/** The folders above a path, outermost first: "a/b/c.ts" → ["a", "a/b"]. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * Resolves a relative link found in `from` (a root-relative path) to a root-relative path, or
 * undefined when it leaves the project. A leading "/" means the project root, as on GitHub.
 */
export function resolveLink(from: string, href: string): string | undefined {
  const parts = href.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join("/") : undefined;
}

export const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p);

/** GitHub-style heading anchor: lowercase, punctuation dropped, spaces to "-". */
export function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

// Names highlight.js doesn't know as extensions.
const SPECIAL: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile", "cargo.lock": "toml", ".gitignore": "bash", ".env": "bash" };

/** The highlight.js language (or alias) to try for a file name. */
export function langOf(path: string): string {
  const name = path.split("/").pop()!.toLowerCase();
  if (SPECIAL[name]) return SPECIAL[name];
  if (name.startsWith(".env")) return "bash";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}
