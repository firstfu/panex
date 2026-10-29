// panex-cli list / wake / send helpers: which tabs a name means, and text safe to type into Claude Code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, groupOf, matchTargets } from "../src/remote.ts";

const tabs = [
  { id: "a1", workspace: "shop_api", title: "Claude Code", folder: "shop_api" },
  { id: "a2", workspace: "shop_api", title: "dev server", folder: "shop_api" },
  { id: "b1", workspace: "web", title: "Claude Code", folder: "web" },
  { id: "c1", workspace: "notes", title: "zsh", folder: "shop_api-worktrees" },
];
const ids = (list: { id: string }[]) => list.map((t) => t.id);

test("an exact tab id wins over names", () => {
  assert.deepEqual(ids(matchTargets(tabs, "b1")), ["b1"]);
});

test("a workspace name brings all its tabs, ignoring case", () => {
  assert.deepEqual(ids(matchTargets(tabs, "SHOP_API")), ["a1", "a2"]);
});

test("exact names beat partial ones", () => {
  // "web" equals b1's workspace; nothing else contains it either way.
  assert.deepEqual(ids(matchTargets(tabs, "web")), ["b1"]);
  // "shop" equals nothing, so every tab containing it matches.
  assert.deepEqual(ids(matchTargets(tabs, "shop")), ["a1", "a2", "c1"]);
  assert.deepEqual(ids(matchTargets(tabs, "dev server")), ["a2"]);
});

test("the same tab title in two workspaces matches both", () => {
  assert.deepEqual(ids(matchTargets(tabs, "claude code")), ["a1", "b1"]);
});

test("nothing or blank matches nothing", () => {
  assert.deepEqual(matchTargets(tabs, "nope"), []);
  assert.deepEqual(matchTargets(tabs, "  "), []);
});

test("overview groups: no shell first, then what the agent is doing", () => {
  const t = (o: object) => groupOf({ status: "idle", running: true, ...o });
  assert.equal(t({ hibernated: true, running: false, status: "done" }), "asleep");
  assert.equal(t({ running: false }), "stopped");
  assert.equal(t({ status: "running", asking: true }), "needs");
  assert.equal(t({ status: "attention" }), "needs");
  assert.equal(t({ status: "running" }), "running");
  assert.equal(t({ status: "done" }), "done");
  assert.equal(t({}), "idle");
});

test("text keeps line breaks and tabs, loses every other control character", () => {
  assert.equal(cleanText("run\r\nthe\ttests\r"), "run\nthe\ttests");
  assert.equal(cleanText("a\x1b[201~b\x03c\x7f"), "a[201~bc");
  assert.equal(cleanText("  \x1b  "), "");
});
