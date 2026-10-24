// Unit tests for src/sanitize.ts (input checks and the scrollback blank-line fix). Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { squeezeBlankRuns, validSessionId, validSshTarget } from "../src/sanitize.ts";

test("validSshTarget accepts what ssh.rs valid_target accepts", () => {
  for (const t of ["example.com", "user@example.com", "host:2222", "u@h.lan:22", "::1", "[::1]:22", "u@[fe80::1%eth0]:22", "my-host_01"]) {
    assert.ok(validSshTarget(t), t);
  }
});

test("validSshTarget rejects option injection and shell syntax", () => {
  for (const t of ["", "-oProxyCommand=calc", "-p", "a b", "a;b", "a&b", "a|b", "$(x)", "`x`", "a\nb", "h'q", 'h"q', "a/b", "a\\b", "x".repeat(256)]) {
    assert.ok(!validSshTarget(t), JSON.stringify(t));
  }
});

test("validSessionId accepts Claude Code session ids", () => {
  assert.ok(validSessionId("0f6e1c2a-9b3d-4e5f-8a7b-1c2d3e4f5a6b"));
  assert.ok(validSessionId("abcdefgh"));
  assert.ok(validSessionId("a".repeat(64)));
});

test("validSessionId rejects anything that could change the typed command", () => {
  for (const id of [undefined, null, 42, {}, "", "short", "a".repeat(65), "abc def12", "abcdefgh; rm -rf ~", "abcdefgh&calc", "abcdefgh\r", "--dangerously-skip-permissions", "-abcdefgh"]) {
    assert.ok(!validSessionId(id), JSON.stringify(id));
  }
});

test("squeezeBlankRuns caps runs of blank lines at two", () => {
  assert.equal(squeezeBlankRuns("a\n\n\n\n\n\nb"), "a\n\n\nb");
  assert.equal(squeezeBlankRuns("a\r\n   \r\n\t\r\n\r\n\r\nb"), "a\n\n\nb");
});

test("squeezeBlankRuns leaves ordinary output alone", () => {
  for (const s of ["a\nb", "a\n\nb", "a\n\n\nb", "a\r\n\r\nb", "  indented\n\nnext", ""]) {
    assert.equal(squeezeBlankRuns(s), s);
  }
});

test("createDimFilter 把 dim 換成灰色並在 22 還原前景", async () => {
  const { createDimFilter } = await import("../src/sanitize.ts");
  const f = createDimFilter();
  assert.equal(f("\x1b[2mhi\x1b[22m"), "\x1b[38;2;114;114;118mhi\x1b[22;39m");
  assert.equal(f("\x1b[22m"), "\x1b[22m"); // 沒有 dim 就不補 39
  assert.equal(f("\x1b[38;2;2;2;2m"), "\x1b[38;2;2;2;2m"); // 擴充色裡的 2 不是 dim
  assert.equal(f("\x1b[38;5;2m"), "\x1b[38;5;2m");
  assert.equal(f("\x1b[2;3m"), "\x1b[38;2;114;114;118m"); // 斜體被丟掉
  assert.equal(f("\x1b[3mi\x1b[23m"), "i"); // 只剩斜體的序列整段消失，不能變成 \x1b[m
});

test("createDimFilter 跨 chunk 的跳脫序列與自設前景", async () => {
  const { createDimFilter } = await import("../src/sanitize.ts");
  const f = createDimFilter();
  assert.equal(f("a\x1b["), "a");
  assert.equal(f("2mb"), "\x1b[38;2;114;114;118mb");
  assert.equal(f("\x1b[32mx\x1b[22m"), "\x1b[32mx\x1b[22m"); // 自設綠色後不該被 39 蓋掉
});
