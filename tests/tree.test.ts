// Files panel helpers: folder tree, change marks, links between files, anchors, languages, file kinds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ancestors, buildTree, changeMarks, diffMarks, fmtSize, isImage, kindOf, langOf, resolveLink, slug } from "../src/tree.ts";

test("builds a sorted folder tree from flat paths", () => {
  const t = buildTree(["src/b.ts", "README.md", "src/a/x.ts", "Cargo.toml", "src/A.ts"]);
  assert.deepEqual(t.files, ["Cargo.toml", "README.md"]);
  assert.deepEqual(t.dirs.map((d) => d.path), ["src"]);
  assert.deepEqual(t.dirs[0].files, ["A.ts", "b.ts"]);
  assert.deepEqual(t.dirs[0].dirs.map((d) => d.path), ["src/a"]);
});

test("change marks reach every folder above a change, and untracked folders", () => {
  const files = ["src/a/x.ts", "src/b.ts", "docs/new/n.md", "README.md"];
  const { letters, dirs } = changeMarks(files, [
    { path: "src/a/x.ts", letter: "M" },
    { path: "docs/new/", letter: "U" },
  ]);
  assert.equal(letters.get("src/a/x.ts"), "M");
  assert.equal(letters.get("docs/new/n.md"), "U");
  assert.equal(letters.has("src/b.ts"), false);
  assert.deepEqual([...dirs].sort(), ["docs", "docs/new", "src", "src/a"]);
});

test("ancestors lists the folders above a path", () => {
  assert.deepEqual(ancestors("a/b/c.ts"), ["a", "a/b"]);
  assert.deepEqual(ancestors("c.ts"), []);
});

test("links resolve relative to the file and never leave the project", () => {
  assert.equal(resolveLink("docs/context/reference/overview.md", "boundaries.md"), "docs/context/reference/boundaries.md");
  assert.equal(resolveLink("docs/context/reference/overview.md", "../journal/./process.md"), "docs/context/journal/process.md");
  assert.equal(resolveLink("docs/a.md", "/README.md"), "README.md");
  assert.equal(resolveLink("docs/a.md", "../../etc/passwd"), undefined);
});

test("heading anchors follow GitHub", () => {
  assert.equal(slug("Session 開始順序"), "session-開始順序");
  assert.equal(slug("What's `new`?"), "whats-new");
});

test("languages come from the extension or a known name", () => {
  assert.equal(langOf("src/main.rs"), "rs");
  assert.equal(langOf("Dockerfile"), "dockerfile");
  assert.equal(langOf(".env.local"), "bash");
  assert.equal(langOf("LICENSE"), "");
});

test("images, kinds and sizes", () => {
  assert.equal(isImage("assets/Logo.SVG"), true);
  assert.equal(isImage("a.pdf"), false);
  assert.equal(kindOf("眼誌/中短距離4.xlsx"), "試算表");
  assert.equal(kindOf("voice0.aac"), "音訊");
  assert.equal(kindOf("blob"), "二進位檔案");
  assert.equal(fmtSize(512), "512 B");
  assert.equal(fmtSize(1536), "1.5 KB");
  assert.equal(fmtSize(20 * 1024 * 1024), "20 MB");
});

test("diff marks give added lines and where removals sit, in new-file numbers", () => {
  const diff = ["diff --git a/f b/f", "index 1..2 100644", "--- a/f", "+++ b/f", "@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", "-d", "@@ -10,0 +10,2 @@", "+x", "+y"].join("\n");
  const m = diffMarks(diff);
  assert.deepEqual([...m.added], [2, 10, 11]);
  assert.deepEqual([...m.removedAt], [2, 4]);
  assert.equal(m.adds, 3);
  assert.equal(m.dels, 2);
});
