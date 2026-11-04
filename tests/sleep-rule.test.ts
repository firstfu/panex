import { test } from "node:test";
import assert from "node:assert/strict";
import { IDLE_MS, REFUSED_MS, isTerminalReply, sleepOrder, sleepable, underPressure, type SleepInfo } from "../src/sleep-rule.ts";

const GB = 2 ** 30;
const now = 100 * IDLE_MS;
const idle: SleepInfo = { visible: false, running: true, agentLive: true, agentSession: "s", status: "done", outAt: 0, typedAt: 0, seenAt: 0 };

test("pressure: half the machine in tabs, or under a tenth left", () => {
  assert.equal(underPressure(8 * GB, { total: 32 * GB, available: 20 * GB }), false);
  assert.equal(underPressure(16 * GB, { total: 32 * GB, available: 20 * GB }), true);
  assert.equal(underPressure(1 * GB, { total: 32 * GB, available: 3 * GB }), true);
  assert.equal(underPressure(1 * GB, { total: 32 * GB, available: 3.2 * GB }), false);
});

test("pressure: the commit limit running out counts, with physical memory still free", () => {
  const free = { total: 32 * GB, available: 10 * GB };
  assert.equal(underPressure(1 * GB, { ...free, commitTotal: 50 * GB, commitAvailable: 4 * GB }), true);
  assert.equal(underPressure(1 * GB, { ...free, commitTotal: 50 * GB, commitAvailable: 5 * GB }), false);
  assert.equal(underPressure(1 * GB, { ...free, commitTotal: null, commitAvailable: null }), false);
  assert.equal(underPressure(1 * GB, { ...free, commitTotal: 0, commitAvailable: 0 }), false);
});

test("pressure: a nonsense reading is not pressure", () => {
  assert.equal(underPressure(1 * GB, { total: 0, available: 0 }), false);
});

test("an idle hidden tab can go", () => assert.equal(sleepable(idle, now), true));

for (const [name, change] of Object.entries<Partial<SleepInfo>>({
  "visible": { visible: true },
  "not running": { running: false },
  "already asleep": { hibernated: true },
  "waking": { waking: true },
  "ssh": { ssh: true },
  "no claude": { agentLive: false },
  "no session to resume": { agentSession: undefined },
  "phone connected": { agentRemote: true },
  "background work": { agentBackground: true },
  "mid-turn": { status: "running" },
  "asking": { asking: true },
  "output just now": { outAt: now - 1000 },
  "typed just now": { typedAt: now - 1000 },
  "just refused": { refusedAt: now - 1000 },
})) test(`stays: ${name}`, () => assert.equal(sleepable({ ...idle, ...change }, now), false));

test("idle time and refusals run out", () => {
  assert.equal(sleepable({ ...idle, outAt: now - IDLE_MS }, now), true);
  assert.equal(sleepable({ ...idle, refusedAt: now - REFUSED_MS }, now), true);
});

test("longest unused goes first, and only tabs that can go", () => {
  const a = { ...idle, seenAt: 300 };
  const b = { ...idle, seenAt: 100 };
  const c = { ...idle, seenAt: 200, typedAt: 900 };
  const d = { ...idle, seenAt: 1, visible: true };
  assert.deepEqual(sleepOrder([a, b, c, d], now), [b, a, c]);
});

test("terminal answers pass while keys wait", () => {
  for (const r of ["\x1b[24;80R", "\x1b[?1;2c", "\x1b[0n", "\x1b[I", "\x1b[O", "\x1b[<0;10;5M", "\x1b]11;rgb:0/0/0\x07", "\x1bP1$r0m\x1b\\"]) assert.equal(isTerminalReply(r), true, JSON.stringify(r));
  for (const k of ["a", "\r", "\x1b", "\x03", "\x1b[A", "\x1b[3~", "你好", "\x1b[200~pasted\x1b[201~"]) assert.equal(isTerminalReply(k), false, JSON.stringify(k));
});
