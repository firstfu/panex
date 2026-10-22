// End-to-end test of the real app: launches a test instance built with `--features e2e` in a
// throwaway HOME, drives its window through `panex-cli e2e` (src-tauri/src/e2e.rs) and checks
// the results on disk. macOS only for now (the session path below). Nothing of the user's
// panex, ~/.claude or clipboard is touched.
//
//   npm run build
//   cd src-tauri && TAURI_CONFIG='{"identifier":"dev.panex.terminal.test","productName":"panex-test","app":{"macOSPrivateApi":true}}' \
//     cargo build --profile test-build --features e2e,tauri/custom-protocol
//   cd .. && node tests/e2e/run.mjs [--keep]

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = process.env.PANEX_E2E_TARGET ?? join(ROOT, "src-tauri/target/test-build");
const BIN = join(OUT, "panex");
const CLI = join(OUT, "panex-cli");
const KEEP = process.argv.includes("--keep"); // leave the temp folder for a look afterwards

// Real path: on macOS /var is a link to /private/var, and the shell reports the latter.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "panex-e2e-")));
const home = join(tmp, "home");
const repo = join(tmp, "repo");
const env = {
  ...process.env,
  HOME: home, // app data, ~/.claude and shell rc files all land in the temp folder
  SHELL: "/bin/zsh",
  XDG_CONFIG_HOME: join(tmp, "config"),
  PANEX_PIPE_NAME: join(tmp, "e2e.sock"),
  PANEX_E2E_TOKEN: randomBytes(16).toString("hex"),
};
// Started from a Claude Code session these would leak into the tabs (see boundaries.md).
for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "NO_COLOR"]) delete env[k];

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", env, ...opts });

/** Runs an async JS function body in the app window and returns its JSON result. */
function evalJs(body) {
  const out = JSON.parse(sh(CLI, ["e2e", "-"], { input: body }).trim() || "null");
  if (out && typeof out === "object" && "error" in out) throw new Error(`eval failed: ${out.error}`);
  return out;
}

/** Polls `fn` until it returns something truthy; throws with `what` after `ms`. */
async function waitFor(what, fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// JS helpers installed once in the window. Keys are synthetic KeyboardEvents with keyCode
// patched in (WebKit ignores it in the constructor and xterm still reads it); text goes in as
// a paste event, which xterm forwards to the shell like a real paste.
const HELPERS = `
window.__e2e = {
  clip: [],
  textarea: () => document.querySelector(".term-wrap:not([hidden]) .xterm-helper-textarea, .xterm-helper-textarea"),
  key(key, code, keyCode, mods = {}) {
    const ta = this.textarea();
    ta.focus();
    const ev = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods });
    Object.defineProperty(ev, "keyCode", { get: () => keyCode });
    Object.defineProperty(ev, "which", { get: () => keyCode });
    ta.dispatchEvent(ev);
  },
  paste(text) {
    const ta = this.textarea();
    ta.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  },
  run(cmd) { this.paste(cmd); this.key("Enter", "Enter", 13); },
  menu(el) {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5 }));
    return [...document.querySelectorAll("#ctx .item")];
  },
};
// Record copies instead of touching the system clipboard.
navigator.clipboard.writeText = async (t) => void window.__e2e.clip.push(t);
return true;`;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

function setup() {
  for (const p of [BIN, CLI]) if (!existsSync(p)) throw new Error(`missing ${p}; build it first (operations.md)`);
  mkdirSync(home, { recursive: true });
  mkdirSync(repo);
  sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
  sh("git", ["config", "user.email", "e2e@example.com"], { cwd: repo });
  sh("git", ["config", "user.name", "e2e"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "e2e\n");
  sh("git", ["add", "."], { cwd: repo });
  sh("git", ["commit", "-qm", "init"], { cwd: repo });

  // Two tabs in the repo's workspace, so the tab menu has something to tell apart.
  const data = join(home, "Library/Application Support/dev.panex.terminal.test");
  mkdirSync(data, { recursive: true });
  const docs = join(repo, "docs");
  mkdirSync(docs);
  writeFileSync(
    join(data, "session.json"),
    JSON.stringify({
      active: "w1",
      workspaces: [{ id: "w1", title: "repo", tabs: [{ id: "t1", shell: "default", cwd: repo }, { id: "t2", shell: "default", cwd: docs }], active: "t1" }],
    }),
  );

  // A stand-in for Claude Code: commits in its folder, then reports Stop like the real hook.
  const fake = join(tmp, "fake-claude");
  writeFileSync(
    fake,
    `#!/bin/sh
echo "fake claude: $*"
echo work > fake.txt && git add fake.txt && git commit -qm "fake: $1"
printf '{"hook_event_name":"Stop","last_assistant_message":"fake done in %s"}' "$(basename "$PWD")" | "${CLI}" notify
`,
  );
  chmodSync(fake, 0o755);
  // What a lead agent would run: open a worker in a new worktree, then wait for it.
  writeFileSync(
    join(tmp, "squad.sh"),
    `cd "${repo}"
out=$("${CLI}" open --worktree e2e-a -- "${fake}" "do the task")
printf '%s' "$out" > "${tmp}/open.json"
tab=$(printf '%s' "$out" | sed -E 's/.*"tab":"([^"]+)".*/\\1/')
"${CLI}" wait "$tab" --timeout 60 > "${tmp}/wait.json"
`,
  );
}

async function main() {
  setup();
  const app = spawn(BIN, [], { env, stdio: "ignore" });
  try {
    await waitFor("the app to answer", () => evalJs("return document.readyState === 'complete' && !!document.querySelector('.xterm-helper-textarea')"));
    evalJs(HELPERS);
    // The shell is up once zsh reported its cwd (OSC 9;9) and the sidebar shows it.
    await waitFor("the first shell", () => evalJs(`return document.querySelector("#tabs").textContent.includes(${JSON.stringify(repo)})`));

    await check("workspace menu: 複製路徑 copies the active tab's folder", () => {
      const got = evalJs(`
        const ws = [...document.querySelectorAll("#tabs > *")].find((e) => e.textContent.includes("repo"));
        window.__e2e.menu(ws).find((d) => d.textContent === "複製路徑").click();
        return window.__e2e.clip.at(-1);`);
      if (got !== repo) throw new Error(`copied ${JSON.stringify(got)}`);
    });

    await check("tab menu: 複製路徑 copies that tab's own folder", () => {
      const got = evalJs(`
        const tab = [...document.querySelectorAll("#tabbar > *")][1];
        window.__e2e.menu(tab).find((d) => d.textContent === "複製路徑").click();
        return window.__e2e.clip.at(-1);`);
      if (got !== join(repo, "docs")) throw new Error(`copied ${JSON.stringify(got)}`);
    });

    await check("Shift+Enter sends ESC CR to the shell (macOS default)", async () => {
      const out = join(tmp, "shift.txt");
      evalJs(`window.__e2e.run(${JSON.stringify(`cat -v > '${out}'`)}); return true;`);
      await new Promise((r) => setTimeout(r, 800)); // let cat start reading
      evalJs(`window.__e2e.key("Enter", "Enter", 13, { shiftKey: true }); window.__e2e.key("d", "KeyD", 68, { ctrlKey: true }); return true;`);
      const got = await waitFor("cat to finish", () => existsSync(out) && readFileSync(out, "utf8"), 5000);
      // cat -v shows ESC as ^[; the tty turns the CR into a newline.
      if (got !== "^[\n") throw new Error(`shell got ${JSON.stringify(got)}`);
    });

    await check("squad: panex-cli open --worktree + wait on macOS", async () => {
      evalJs(`window.__e2e.run(${JSON.stringify(`sh '${join(tmp, "squad.sh")}'`)}); return true;`);
      const wait = await waitFor("wait.json", () => existsSync(join(tmp, "wait.json")) && readFileSync(join(tmp, "wait.json"), "utf8").trim(), 60000);
      const opened = JSON.parse(readFileSync(join(tmp, "open.json"), "utf8"));
      const w = JSON.parse(wait);
      if (opened.error) throw new Error(`open: ${opened.error}`);
      if (w.timedOut || w.tabs?.[0]?.state !== "done") throw new Error(`wait: ${wait}`);
      if (!existsSync(join(opened.cwd, "fake.txt"))) throw new Error(`worker did not run in ${opened.cwd}`);
      const log = sh("git", ["log", "-1", "--format=%s", "e2e-a"], { cwd: repo }).trim();
      if (log !== "fake: do the task") throw new Error(`branch e2e-a head is ${JSON.stringify(log)}`);
      const inSidebar = evalJs(`return document.querySelector("#tabs").textContent.includes("e2e-a")`);
      if (!inSidebar) throw new Error("no e2e-a workspace in the sidebar");
    });

    await check("eval is refused without the token", () => {
      let out;
      try {
        out = sh(CLI, ["e2e", "return 1"], { env: { ...env, PANEX_E2E_TOKEN: "wrong" } });
      } catch (e) {
        out = e.stdout; // exits 1 on an error answer
      }
      if (JSON.parse(out).error !== "refused") throw new Error(out);
    });
  } finally {
    app.kill();
    if (KEEP) console.log(`kept ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
