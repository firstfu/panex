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

    await check("worktree hooks: Claude's tab stays, the worktree gets its own workspace, removing closes it", async () => {
      // What Claude Code does around EnterWorktree / ExitWorktree, from inside tab t1.
      const script = join(tmp, "hooks.sh");
      writeFileSync(
        script,
        `cd "${repo}"
printf '{"hook_event_name":"WorktreeCreate","name":"e2e-rm","cwd":"%s"}' "$PWD" | "${CLI}" worktree-create > "${tmp}/create.out"
echo $? > "${tmp}/create.code"
sleep 3
printf '{"hook_event_name":"WorktreeRemove","worktree_path":"%s","cwd":"%s"}' "$(cat "${tmp}/create.out")" "$PWD" | "${CLI}" worktree-remove 2> "${tmp}/remove.err"
echo $? > "${tmp}/remove.code"
`,
      );
      evalJs(`document.querySelector("#tabbar > *").click(); return true;`);
      evalJs(`window.__e2e.run(${JSON.stringify(`sh '${script}'`)}); return true;`);
      await waitFor("the create hook", () => existsSync(join(tmp, "create.code")));
      const path = readFileSync(join(tmp, "create.out"), "utf8").trim();
      if (readFileSync(join(tmp, "create.code"), "utf8").trim() !== "0" || !path.endsWith("repo-worktrees/e2e-rm")) throw new Error(`create gave ${path}`);
      await waitFor("the e2e-rm workspace", () => evalJs(`return document.querySelector("#tabs").textContent.includes("e2e-rm")`), 5000);
      // The conversation stays in w1; the worktree is a new workspace of its own with a shell in the folder.
      const session = join(home, "Library/Application Support/dev.panex.terminal.test/session.json");
      await waitFor("t1 kept in w1 next to the worktree's workspace", () => {
        const s = JSON.parse(readFileSync(session, "utf8"));
        return s.workspaces.find((w) => w.id === "w1")?.tabs.some((t) => t.id === "t1") && s.workspaces.some((w) => w.tabs.some((t) => t.cwd === path));
      }, 2500);
      await waitFor("the remove hook", () => existsSync(join(tmp, "remove.code")));
      const code = readFileSync(join(tmp, "remove.code"), "utf8").trim();
      if (code !== "0") throw new Error(`remove exited ${code}: ${readFileSync(join(tmp, "remove.err"), "utf8")}`);
      if (existsSync(path)) throw new Error("the worktree folder is still there");
      if (sh("git", ["worktree", "list"], { cwd: repo }).includes("e2e-rm")) throw new Error("git still lists the worktree");
      if (evalJs(`return document.querySelector("#tabs").textContent.includes("e2e-rm")`)) throw new Error("the e2e-rm workspace is still in the sidebar");
      await waitFor("t1 still in w1", () => JSON.parse(readFileSync(session, "utf8")).workspaces.find((w) => w.id === "w1")?.tabs.some((t) => t.id === "t1"), 5000);
    });

    await check("workspace menu: 關閉工作區並刪除 worktree", async () => {
      const wt = join(tmp, "repo-worktrees", "e2e-a");
      writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");
      const main = evalJs(`
        const ws = [...document.querySelectorAll("#tabs .ws")].find((e) => !e.textContent.includes("e2e-a"));
        const items = window.__e2e.menu(ws).map((d) => d.textContent);
        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return items;`);
      if (main.some((t) => t.includes("刪除 worktree"))) throw new Error("offered on the main checkout's workspace");
      evalJs(`
        const ws = [...document.querySelectorAll("#tabs .ws")].find((e) => e.textContent.includes("e2e-a"));
        window.__e2e.menu(ws).find((d) => d.textContent === "關閉工作區並刪除 worktree…").click();
        return true;`);
      const dlg = await waitFor("the dialog filled in", () => {
        const d = evalJs(`return { ok: document.querySelector("#wt-rm-ok").textContent, disabled: document.querySelector("#wt-rm-ok").disabled,
          warn: [...document.querySelectorAll("#wt-rm-warn li")].map((l) => l.textContent), branch: document.querySelector("#wt-rm-branch").checked,
          label: document.querySelector("#wt-rm-branch-label").textContent, focus: document.activeElement?.id }`);
        return !d.disabled && d;
      }, 5000);
      // One untracked file; the fake agent's commit is only on e2e-a, so the branch is kept by default.
      if (dlg.ok !== "仍要刪除" || dlg.warn.length !== 1 || !dlg.warn[0].startsWith("1 個檔案") || dlg.branch || dlg.focus !== "wt-rm-cancel")
        throw new Error(JSON.stringify(dlg));
      evalJs(`document.querySelector("#wt-rm-branch").click(); return true;`);
      const warn = evalJs(`return [...document.querySelectorAll("#wt-rm-warn li")].map((l) => l.textContent)`);
      if (warn.length !== 2 || !warn[1].includes("e2e-a")) throw new Error(`with the branch ticked: ${JSON.stringify(warn)}`);
      evalJs(`document.querySelector("#wt-rm-branch").click(); document.querySelector("#wt-rm-ok").click(); return true;`);
      await waitFor("the dialog to close", () => evalJs(`return document.querySelector("#wt-rm").hidden`), 10000);
      if (existsSync(wt)) throw new Error("the worktree folder is still there");
      if (evalJs(`return document.querySelector("#tabs").textContent.includes("e2e-a")`)) throw new Error("the e2e-a workspace is still in the sidebar");
      sh("git", ["rev-parse", "--verify", "--quiet", "refs/heads/e2e-a"], { cwd: repo }); // kept: throws if gone
      if (existsSync(join(tmp, "repo-worktrees"))) throw new Error("the empty repo-worktrees folder is left");
    });

    await check("workspace menu: a worktree deleted outside panex only closes its workspace", async () => {
      const out = join(tmp, "gone.json");
      evalJs(`window.__e2e.run(${JSON.stringify(`cd '${repo}' && '${CLI}' open --worktree e2e-gone > '${out}'`)}); return true;`);
      const opened = JSON.parse(await waitFor("open", () => existsSync(out) && readFileSync(out, "utf8").trim(), 20000));
      await waitFor("the e2e-gone workspace", () => evalJs(`return document.querySelector("#tabs").textContent.includes("e2e-gone")`), 5000);
      sh("git", ["worktree", "remove", "--force", opened.cwd], { cwd: repo });
      evalJs(`
        const ws = [...document.querySelectorAll("#tabs .ws")].find((e) => e.textContent.includes("e2e-gone"));
        window.__e2e.menu(ws).find((d) => d.textContent === "關閉工作區並刪除 worktree…").click();
        return true;`);
      await waitFor("the missing-folder notice", () => evalJs(`return document.querySelector("#wt-rm-warn").textContent === "這個資料夾已經不在了" && document.querySelector("#wt-rm-ok").textContent === "關閉工作區"`), 5000);
      evalJs(`document.querySelector("#wt-rm-ok").click(); return true;`);
      await waitFor("the workspace to go", () => !evalJs(`return document.querySelector("#tabs").textContent.includes("e2e-gone")`), 5000);
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
