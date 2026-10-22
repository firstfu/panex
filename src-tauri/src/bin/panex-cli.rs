//! panex-cli: tiny helper for agent hooks, and the way an agent drives panex.
//!
//!   panex-cli notify [message]      (agent hooks)
//!   panex-cli open … / wait …       (an agent starting other agents in new tabs; see HELP)
//!   panex-cli worktree-create       (Claude Code's WorktreeCreate hook; see worktree_create)
//!   panex-cli worktree-remove       (Claude Code's WorktreeRemove hook; see worktree_remove)
//!   panex-cli worktree-guard        (Claude Code's PreToolUse hook for EnterWorktree; see worktree_guard)
//!
//! notify reads the hook JSON from stdin (Claude Code passes it there), adds the pane id from
//! PANEX_PANE_ID and sends it to the running panex over PANEX_PIPE. Outside panex those
//! variables are missing and it exits 0 immediately. It always exits 0 so a hook never
//! shows an error or blocks the agent. open and wait send a request with PANEX_TOKEN and
//! print panex's JSON answer; they exit 1 on errors and 2 when wait times out.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("notify") => notify(&args[1..]),
        Some("open") => std::process::exit(run(open_request(&args[1..]))),
        Some("wait") => std::process::exit(run(wait_request(&args[1..]))),
        Some("worktree-create") => std::process::exit(worktree_create()),
        Some("worktree-remove") => std::process::exit(worktree_remove()),
        Some("worktree-guard") => worktree_guard(),
        #[cfg(feature = "e2e")]
        Some("e2e") => std::process::exit(e2e(&args[1..])),
        Some("help" | "--help" | "-h") | None => print!("{HELP}"),
        Some(other) => {
            eprintln!("panex-cli: unknown command {other:?}; see `panex-cli help`");
            std::process::exit(1);
        }
    }
}

const HELP: &str = r#"panex-cli: start a crew of agents in new panex tabs and wait for them.
Works only inside a panex tab (PANEX_PANE_ID, PANEX_PIPE and PANEX_TOKEN are set there).
Answers are one line of JSON on stdout. Exit code: 0 ok, 1 error, 2 wait timed out.

panex-cli open [--cwd DIR] [--worktree BRANCH [--base BRANCH]] [--title TEXT] [-- COMMAND...]
    Opens a new workspace (sidebar entry) with one tab and types COMMAND into its shell.
    The tab starts at once but is not brought to the front; the user sees it in the sidebar.
    --cwd       folder for the tab (default: the current folder)
    --worktree  first runs `git worktree add` for BRANCH (created from --base, or the current
                HEAD, if it doesn't exist) next to the repo of --cwd, and opens the tab there.
                The files in panex's worktree.copyFiles setting are copied in and
                worktree.setupCommand runs before COMMAND.
    --title     sidebar name (default: the branch, or the folder name)
    COMMAND     typed into the tab's shell (cmd on Windows by default). Arguments with spaces
                are wrapped in double quotes. Keep it short: put long instructions in a file
                and point the agent at it, e.g. -- claude "Do what TASK.md says, then commit".
    Prints {"tab":"<id>","cwd":"<folder>"}.

panex-cli wait TAB... [--timeout SECONDS]
    Waits until no agent in the given tabs is still working, then prints
    {"tabs":[{"tab","state","message"}],"timedOut":false}. state is one of
      done         the agent finished its turn (message = its last reply, shortened)
      needs-input  it is asking the user something (permission, question)
      error        the turn stopped on an API error
      exited       the agent or the tab's shell ended
      running / starting   still working (only when timedOut is true)
    The states come from the Claude Code hooks panex installs, so wait is for Claude Code;
    a plain command never reports and wait just times out.
    --timeout   seconds before giving up (default 110, max 3600). The default stays under the
                2-minute default of an agent's shell tool; call wait again to keep waiting.

The user can watch and type into every tab; a tab in needs-input is waiting for them. Once
they answer it the tab counts as running again, so call wait again after telling them.
Results are best collected from git: have each agent commit in its worktree, then read
`git diff <base>...<branch>`.
"#;

/// `panex-cli worktree-create`: Claude Code's WorktreeCreate hook, installed while panex's
/// agent.worktreeViaPanex setting is on. The hook replaces Claude Code's own `git worktree` step
/// everywhere, so this must also work outside panex.
/// - In a panex tab, panex makes the worktree its own way (`<repo>-worktrees/<name>`, the files
///   in worktree.copyFiles copied in) and, when it is for the session itself rather than a
///   subagent, moves the tab into a new workspace under the repo in the sidebar.
/// - Outside panex, or when panex can't be reached, it does what Claude Code does by default:
///   `.claude/worktrees/<name>` on a new branch `worktree-<name>`.
///
/// Returns the exit code. Claude Code reads the worktree's path from the last stdout line, so
/// everything else goes to stderr; a non-zero exit makes the worktree step fail with that message.
fn worktree_create() -> i32 {
    let hook = read_stdin_json().unwrap_or(Value::Null);
    let name = hook["name"].as_str().unwrap_or_default().trim().to_string();
    let cwd = hook["cwd"].as_str().map(PathBuf::from).or_else(|| std::env::current_dir().ok()).unwrap_or_default();
    if name.is_empty() {
        eprintln!("panex-cli: the hook input has no worktree name");
        return 1;
    }
    if let (Ok(pane), Ok(pipe), Ok(token)) = (std::env::var("PANEX_PANE_ID"), std::env::var("PANEX_PIPE"), std::env::var("PANEX_TOKEN")) {
        let req = json!({
            "op": "worktree", "token": token, "from": pane, "cwd": cwd, "name": name,
            // A subagent's worktree is created quietly: the tab stays with the main session.
            "show": hook.get("agent_id").is_none(),
        });
        match request(&pipe, &req) {
            Ok(v) if v["path"].is_string() => {
                println!("{}", v["path"].as_str().unwrap_or_default());
                return 0;
            }
            Ok(v) => {
                eprintln!("panex-cli: {}", v["error"].as_str().unwrap_or("panex could not create the worktree"));
                return 1;
            }
            Err(e) => eprintln!("panex-cli: cannot reach panex ({e}); creating the worktree the way Claude Code does"),
        }
    }
    match default_worktree(&cwd, &name) {
        Ok(path) => {
            println!("{}", path.display());
            0
        }
        Err(e) => {
            eprintln!("panex-cli: {e}");
            1
        }
    }
}

/// 從 `cwd` 往上找 `.git`：是檔案（指標檔）代表 cwd 已經在 linked worktree 裡。
/// 只看檔案系統、不開 git 程序，hook 每次都會跑所以要快。
fn in_linked_worktree(cwd: &Path) -> bool {
    cwd.ancestors().find_map(|d| std::fs::metadata(d.join(".git")).ok()).is_some_and(|m| m.is_file())
}

/// 給 deny 用的說明，Claude 會把它當工具結果讀到，所以寫成英文指令。
const GUARD_REASON: &str = "This session runs inside panex, so do not switch this conversation into a worktree. \
Hand the task to a new agent instead: run `panex-cli help`, then start it with \
`panex-cli open --worktree <branch> -- claude \"<task>\"` (pick a short branch name from the task; for a \
long task write it to TASK.md in the worktree and tell the agent to follow it), then `panex-cli wait <tab>`. \
Tell the user which tab you opened. Do not repeat the work in this session.";

/// `panex-cli worktree-guard`：PreToolUse hook（matcher `EnterWorktree`），在 panex 分頁裡攔下 Claude Code
/// 內建的原地切換。原因：切換後 Claude 的 cwd 在 worktree、對話卻還掛在原工作區，panex 另開的 worktree
/// 工作區反而是空 shell；使用者要的是任務交給 worktree 裡的新 agent。攔動作而不是靠 skill 猜措辭，
/// 使用者怎麼說都一樣。放行：不在 panex 內（hook 是全域的）、cwd 已在 linked worktree（交棒出去的 agent
/// 自己再呼叫時不能再轉一次）、子 agent。一律 exit 0，deny 靠 stdout 的 JSON。
fn worktree_guard() {
    let hook = read_stdin_json().unwrap_or(Value::Null);
    let cwd = hook["cwd"].as_str().map(PathBuf::from).or_else(|| std::env::current_dir().ok()).unwrap_or_default();
    if std::env::var_os("PANEX_PANE_ID").is_none() || hook.get("agent_id").is_some() || in_linked_worktree(&cwd) {
        return;
    }
    let out = json!({ "hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": GUARD_REASON,
    } });
    println!("{out}");
}

/// `panex-cli worktree-remove`：Claude Code 的 WorktreeRemove hook，跟 worktree-create 一起安裝。
/// Claude Code 刪除 worktree-create 建的 worktree 時（ExitWorktree 選擇移除、離開 `claude --worktree`）呼叫它；
/// 有這個 hook 時 Claude Code 自己不刪任何東西，所以這裡照它原本的做法跑 `git worktree remove --force`。
/// 分支保留（Claude Code 也不刪分支）。到這一步 Claude Code 已經檢查過、或被告知可以丟掉未 commit 的內容。
/// - 在 panex 分頁裡：先通知 panex，讓它把 Claude 的分頁搬回 repo 的主工作區、關掉 worktree 的工作區，
///   資料夾裡就沒有 shell 了（Windows 刪不掉程序正當作 cwd 的資料夾）。
/// - panex 外或連不到 panex：只刪 worktree。
///
/// 回傳 exit code：非 0（原因寫在 stderr）會讓 Claude Code 回報 worktree 沒刪掉。
fn worktree_remove() -> i32 {
    let hook = read_stdin_json().unwrap_or(Value::Null);
    let Some(path) = hook["worktree_path"].as_str().map(PathBuf::from) else {
        eprintln!("panex-cli: the hook input has no worktree_path");
        return 1;
    };
    if let (Ok(pane), Ok(pipe), Ok(token)) = (std::env::var("PANEX_PANE_ID"), std::env::var("PANEX_PIPE"), std::env::var("PANEX_TOKEN")) {
        let req = json!({ "op": "worktree-remove", "token": token, "from": pane, "path": path });
        // 側欄整理不了不是保留 worktree 的理由。
        if let Err(e) = request(&pipe, &req) {
            eprintln!("panex-cli: cannot reach panex ({e}); removing the worktree anyway");
        }
    }
    match remove_worktree(&path) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("panex-cli: {e}");
            1
        }
    }
}

/// 從主 checkout 跑 `git worktree remove --force <path>`（git 不刪自己正在裡面的 worktree），
/// `<repo>-worktrees` 因此空了就一併刪。資料夾已經不在算成功。panex 剛關掉的 shell 可能還沒結束，失敗會重試幾次。
/// 錯誤：不是 git worktree（照 Claude Code 的做法留在原地）或重試後仍刪不掉。
fn remove_worktree(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let common = PathBuf::from(git(path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).map_err(|_| format!("{} is not a git worktree; left as it is", path.display()))?);
    let root = match common.file_name() {
        Some(n) if n == ".git" => common.parent().map(Path::to_path_buf).ok_or("the repository has no main checkout")?,
        _ => return Err("the repository has no main checkout".into()),
    };
    let path_str = path.to_string_lossy().into_owned();
    let mut last = Ok(String::new());
    for attempt in 0..4 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(400));
        }
        last = git(&root, &["worktree", "remove", "--force", &path_str]);
        if last.is_ok() || !path.exists() {
            last = Ok(String::new());
            break;
        }
    }
    last?;
    if let Some(parent) = path.parent().filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().ends_with("-worktrees"))) {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

/// Runs git in `dir`; its output never reaches our stdout (Claude Code reads the path there).
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().map_err(|e| format!("cannot run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Claude Code's default worktree, for sessions outside panex: `<main checkout>/.claude/worktrees/<name>`
/// on branch `worktree-<name>`, from the remote's default branch when it is known locally, else
/// HEAD. An existing one is reused (Claude Code asks again when it resumes a session in it).
/// Not covered: Claude Code's fetch of a stale default branch, `.worktreeinclude` and `worktree.baseRef`.
fn default_worktree(cwd: &Path, name: &str) -> Result<PathBuf, String> {
    let slug: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' }).collect();
    let slug = slug.trim_matches('.').to_string();
    if slug.is_empty() {
        return Err(format!("{name:?} is not a usable worktree name"));
    }
    let common = PathBuf::from(git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).map_err(|_| "not inside a git repository".to_string())?);
    // The main checkout, also from inside a worktree: the folder holding the shared .git.
    let root = match common.file_name() {
        Some(n) if n == ".git" => common.parent().map(Path::to_path_buf).unwrap_or(common.clone()),
        _ => PathBuf::from(git(cwd, &["rev-parse", "--show-toplevel"])?),
    };
    let dir = root.join(".claude").join("worktrees").join(&slug);
    if dir.join(".git").exists() {
        return Ok(dir);
    }
    let dir_str = dir.to_string_lossy().into_owned();
    let branch = format!("worktree-{slug}");
    if git(&root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok() {
        git(&root, &["worktree", "add", &dir_str, &branch])?;
    } else {
        let base = if git(&root, &["rev-parse", "--verify", "--quiet", "origin/HEAD"]).is_ok() { "origin/HEAD" } else { "HEAD" };
        git(&root, &["worktree", "add", "-b", &branch, &dir_str, base])?;
    }
    Ok(dir)
}

/// Sends the request and prints the answer; returns the exit code.
fn run(req: Result<Value, String>) -> i32 {
    let answer = req.and_then(|mut req| {
        let (Ok(pipe), Ok(token)) = (std::env::var("PANEX_PIPE"), std::env::var("PANEX_TOKEN")) else {
            return Err("not inside a panex tab (PANEX_PIPE / PANEX_TOKEN not set)".into());
        };
        req["token"] = token.into();
        request(&pipe, &req).map_err(|e| format!("cannot reach panex: {e}"))
    });
    match answer {
        Ok(v) if v.get("error").is_some() => {
            println!("{v}");
            1
        }
        Ok(v) => {
            println!("{v}");
            if v["timedOut"] == true { 2 } else { 0 }
        }
        Err(e) => {
            println!("{}", json!({ "error": e }));
            1
        }
    }
}

fn open_request(args: &[String]) -> Result<Value, String> {
    let mut req = json!({ "op": "open", "from": std::env::var("PANEX_PANE_ID").unwrap_or_default() });
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let key = match a.as_str() {
            "--cwd" => "cwd",
            "--worktree" => "worktree",
            "--base" => "base",
            "--title" => "title",
            "--" => {
                let cmd: Vec<String> = it.by_ref().map(|a| quote(a)).collect();
                req["command"] = cmd.join(" ").into();
                break;
            }
            other => return Err(format!("unknown option {other:?}; see `panex-cli help`")),
        };
        let v = it.next().ok_or_else(|| format!("{a} needs a value"))?;
        req[key] = v.clone().into();
    }
    // Relative to where panex-cli runs, not to panex's own folder.
    let cwd = match req["cwd"].as_str() {
        Some(c) => std::path::absolute(c),
        None => std::env::current_dir(),
    }
    .map_err(|e| e.to_string())?;
    req["cwd"] = cwd.to_string_lossy().into_owned().into();
    Ok(req)
}

fn wait_request(args: &[String]) -> Result<Value, String> {
    let mut tabs = Vec::new();
    let mut timeout = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--timeout" {
            let v = it.next().and_then(|v| v.parse::<u64>().ok()).ok_or("--timeout needs a number of seconds")?;
            timeout = Some(v);
        } else if a.starts_with('-') {
            return Err(format!("unknown option {a:?}; see `panex-cli help`"));
        } else {
            tabs.push(a.clone());
        }
    }
    if tabs.is_empty() {
        return Err("give at least one tab id (from `panex-cli open`)".into());
    }
    Ok(json!({ "op": "wait", "tabs": tabs, "timeout": timeout }))
}

/// `panex-cli e2e <js | ->` (test builds only): runs the JS body in the test instance named by
/// PANEX_PIPE_NAME and prints its JSON result. See src/e2e.rs.
#[cfg(feature = "e2e")]
fn e2e(args: &[String]) -> i32 {
    let js = match args.first().map(String::as_str) {
        Some("-") => {
            let mut s = String::new();
            let _ = std::io::stdin().read_to_string(&mut s);
            s
        }
        Some(js) => js.to_string(),
        None => {
            eprintln!("usage: panex-cli e2e <js | ->");
            return 1;
        }
    };
    let pipe = std::env::var("PANEX_PIPE_NAME").unwrap_or_default();
    let req = json!({ "op": "e2e-eval", "e2e": std::env::var("PANEX_E2E_TOKEN").unwrap_or_default(), "js": js });
    match request(&pipe, &req) {
        Ok(v) => {
            println!("{v}");
            i32::from(v.get("error").is_some())
        }
        Err(e) => {
            println!("{}", json!({ "error": format!("cannot reach panex: {e}") }));
            1
        }
    }
}

/// Double-quotes an argument that has spaces or quotes, so the program typed into the shell
/// reads it back as one argument (Windows C runtime rules; plain text in POSIX shells).
fn quote(a: &str) -> String {
    if !a.is_empty() && !a.chars().any(|c| c.is_whitespace() || c == '"') {
        return a.to_string();
    }
    format!("\"{}\"", a.replace('"', "\\\""))
}

fn notify(rest: &[String]) {
    let (Ok(pane), Ok(pipe)) = (std::env::var("PANEX_PANE_ID"), std::env::var("PANEX_PIPE")) else {
        return;
    };
    let hook = read_stdin_json().unwrap_or(Value::Null);
    let event = hook["hook_event_name"].as_str().unwrap_or("Notification").to_string();
    let message = match event.as_str() {
        // For StopFailure this holds the API error text, e.g. "API Error: Rate limit reached".
        "Stop" | "StopFailure" => hook["last_assistant_message"].as_str(),
        _ => hook["message"].as_str(),
    }
    .map(|s| truncate(s, 140))
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| rest.join(" "));

    let payload = json!({
        "pane": pane,
        "event": event,
        "message": message,
        "notificationType": hook["notification_type"],
        "sessionId": hook["session_id"],
        // 讓 panex 分辨這個分頁是哪一次啟動開的（notify.rs 會丟掉別次啟動的 hook）。
        "token": std::env::var("PANEX_TOKEN").ok(),
    });
    let result = send(&pipe, payload.to_string().as_bytes());
    if std::env::var_os("PANEX_DEBUG").is_some() {
        eprintln!("panex-cli: {payload} -> {pipe}: {result:?}");
    }
}

/// Reads stdin unless it's an interactive console; gives up after 2 s so a stray
/// open stdin can never hang the agent.
fn read_stdin_json() -> Option<Value> {
    if std::io::stdin().is_terminal() {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::stdin().take(1 << 20).read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let buf = rx.recv_timeout(Duration::from_secs(2)).ok()?;
    // Windows PowerShell may prepend a UTF-8 BOM when piping to native programs.
    let json = buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&buf);
    serde_json::from_slice(json).ok()
}

fn truncate(s: &str, max: usize) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    match one_line.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &one_line[..i]),
        None => one_line,
    }
}

/// One request line out, one answer line back.
fn request(pipe: &str, req: &Value) -> std::io::Result<Value> {
    let mut conn = connect(pipe, true)?;
    let mut line = req.to_string().into_bytes();
    line.push(b'\n');
    conn.write_all(&line)?;
    let mut answer = String::new();
    BufReader::new(conn).read_line(&mut answer)?;
    serde_json::from_str(&answer).map_err(|_| std::io::Error::other("no answer (is this panex too old?)"))
}

fn send(pipe: &str, bytes: &[u8]) -> std::io::Result<()> {
    connect(pipe, false)?.write_all(bytes)
}

#[cfg(windows)]
fn connect(pipe: &str, read: bool) -> std::io::Result<std::fs::File> {
    // All pipe instances can be momentarily busy; retry briefly.
    let mut last = None;
    for _ in 0..10 {
        match std::fs::OpenOptions::new().read(read).write(true).open(pipe) {
            Ok(f) => return Ok(f),
            // 231 = ERROR_PIPE_BUSY; anything else (e.g. panex not running) fails fast.
            Err(e) if e.raw_os_error() != Some(231) => return Err(e),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(30));
            }
        }
    }
    Err(last.unwrap())
}

#[cfg(not(windows))]
fn connect(pipe: &str, _read: bool) -> std::io::Result<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(pipe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(quote("claude"), "claude");
        assert_eq!(quote("fix issue 12"), "\"fix issue 12\"");
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote(""), "\"\"");
    }

    #[test]
    fn open_parses_options_and_command() {
        let args: Vec<String> = ["--worktree", "fix-12", "--title", "Fix", "--", "claude", "do it"].iter().map(|s| s.to_string()).collect();
        let req = open_request(&args).unwrap();
        assert_eq!(req["worktree"], "fix-12");
        assert_eq!(req["title"], "Fix");
        assert_eq!(req["command"], "claude \"do it\"");
        assert!(req["cwd"].as_str().is_some_and(|c| std::path::Path::new(c).is_absolute()));
        assert!(open_request(&["--bogus".to_string()]).is_err());
        assert!(open_request(&["--cwd".to_string()]).is_err());
    }

    #[test]
    fn wait_needs_tabs() {
        assert!(wait_request(&[]).is_err());
        let req = wait_request(&["a".into(), "--timeout".into(), "5".into(), "b".into()]).unwrap();
        assert_eq!(req["tabs"], json!(["a", "b"]));
        assert_eq!(req["timeout"], 5);
    }
}
