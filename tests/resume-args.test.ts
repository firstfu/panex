import { test } from "node:test";
import assert from "node:assert/strict";
import { keepResumeArgs, resumeCommand } from "../src/resume-args.ts";

test("keeps known flags with their values", () => {
  assert.deepEqual(
    keepResumeArgs(["--dangerously-skip-permissions", "--settings", "a b.json", "--allowedTools", "Bash", "Read", "--strict-mcp-config"]),
    ["--dangerously-skip-permissions", "--settings", "a b.json", "--allowedTools", "Bash", "Read", "--strict-mcp-config"],
  );
});

test("never keeps a prompt", () => {
  assert.deepEqual(keepResumeArgs(["fix the bug"]), []);
  assert.deepEqual(keepResumeArgs(["--strict-mcp-config", "fix the bug"]), ["--strict-mcp-config"]);
  assert.deepEqual(keepResumeArgs(["--settings", "s.json", "fix the bug"]), ["--settings", "s.json"]);
  assert.deepEqual(keepResumeArgs(["--strict-mcp-config", "--", "--settings", "x"]), ["--strict-mcp-config"]);
  assert.deepEqual(keepResumeArgs(["--unknown", "--verbose"]), ["--verbose"]);
});

test("drops what picks a session, and the model", () => {
  for (const argv of [["--resume", "abc"], ["-r", "abc"], ["--continue"], ["-c"], ["--session-id", "abc"], ["--fork-session"], ["--model", "haiku"], ["-w", "x"], ["-p", "hi"]]) {
    assert.deepEqual(keepResumeArgs(argv), [], argv.join(" "));
  }
});

test("splits --flag=value, keeps a value starting with a dash for a one-value flag", () => {
  assert.deepEqual(keepResumeArgs(["--effort=high"]), ["--effort", "high"]);
  assert.deepEqual(keepResumeArgs(["--append-system-prompt", "-x"]), ["--append-system-prompt", "-x"]);
  assert.deepEqual(keepResumeArgs(["--remote-control", "phone", "prompt"]), ["--remote-control", "phone"]);
  assert.deepEqual(keepResumeArgs(["--remote-control", "--verbose"]), ["--remote-control", "--verbose"]);
});

test("a value that can't be typed goes, and takes a one-value flag with it", () => {
  assert.deepEqual(keepResumeArgs(["--append-system-prompt", "a\nb", "--verbose"]), ["--verbose"]);
  assert.deepEqual(keepResumeArgs(["--allowedTools", "Bash", "a\rb"]), ["--allowedTools", "Bash"]);
});

test("bad input is no flags", () => {
  assert.deepEqual(keepResumeArgs(undefined), []);
  assert.deepEqual(keepResumeArgs("--verbose"), []);
  assert.deepEqual(keepResumeArgs(["toString", 3]), []);
});

test("no flags: the plain command", () => {
  assert.equal(resumeCommand("s1", [], "cmd"), "claude --resume s1");
  assert.equal(resumeCommand("s1", undefined, "default"), "claude --resume s1");
  assert.equal(resumeCommand("s1", ["--verbose"], "ssh"), "claude --resume s1");
});

test("cmd: carets around everything special", () => {
  assert.equal(resumeCommand("s1", ["--settings", "a.json"], "cmd"), "claude --resume s1 --settings a.json");
  assert.equal(resumeCommand("s1", ["--settings", "C:\\a b\\"], "cmd"), 'claude --resume s1 --settings ^"C:\\a b\\\\^"');
  assert.equal(resumeCommand("s1", ["--settings", '{"a":"%PATH%&x"}'], "cmd"), 'claude --resume s1 --settings ^"{\\^"a\\^":\\^"^%PATH^%^&x\\^"}^"');
});

test("PowerShell: single quotes, and legacy passing only when a quote needs it", () => {
  assert.equal(resumeCommand("s1", ["--settings", "a b.json"], "pwsh"), "claude --resume s1 --settings 'a b.json'");
  assert.equal(resumeCommand("s1", ["--agent", "it's"], "powershell"), "claude --resume s1 --agent 'it''s'");
  assert.equal(resumeCommand("s1", ["--settings", '{"a":1}'], "pwsh"), `$PSNativeCommandArgumentPassing='Legacy'; claude --resume s1 --settings '{\\"a\\":1}'`);
});

test("zsh: single quotes", () => {
  assert.equal(resumeCommand("s1", ["--agent", "it's a $x"], "default"), `claude --resume s1 --agent 'it'\\''s a $x'`);
});
