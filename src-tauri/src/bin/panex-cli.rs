//! panex-cli: tiny helper for agent hooks, and the way an agent drives panex.
//!
//!   panex-cli notify [message]      (agent hooks)
//!   panex-cli open … / wait …       (an agent starting other agents in new tabs; see HELP)
//!   panex-cli browser-login         (saves a login for crew agents' Playwright browsers)
//!   panex-cli worktree-create       (Claude Code's WorktreeCreate hook; see worktree_create)
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
        Some("browser-login") => {
            if let Err(e) = browser_login() {
                eprintln!("panex-cli: {e}");
                std::process::exit(1);
            }
        }
        #[cfg(feature = "e2e")]
        Some("e2e") => std::process::exit(e2e(&args[1..])),
        Some("help" | "--help" | "-h") | None => {
            let config = login_dir().join("cli.config.json");
            let choice = agent_config()["crewBrowser"].as_str().unwrap_or_default().to_string();
            print!("{HELP}{}", browser_help(&choice, config.is_file().then_some(config.as_path())));
        }
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

/// panex's config folder; same rule as config::dir (not linked: that pulls in Tauri).
fn config_dir() -> PathBuf {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".config"))
        .join("panex")
}

/// The "agent" section of panex.json, read on every call so it follows the settings page
/// without restarting any tab.
fn agent_config() -> Value {
    std::fs::read_to_string(config_dir().join("panex.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| v["agent"].clone())
        .unwrap_or(Value::Null)
}

/// Where `browser-login` keeps the saved login. Outside any worktree, so it never gets committed.
fn login_dir() -> PathBuf {
    config_dir().join("playwright")
}

/// Pinned: the config shape below (isolated + storageState + initScript) is only known to work here.
const PLAYWRIGHT_CLI: &str = "@playwright/cli@0.1.22";

/// The part of the help that depends on the user's choice in Settings → crew browser.
/// `config` is the saved login's cli.config.json, when there is one.
fn browser_help(choice: &str, config: Option<&Path>) -> String {
    match choice {
        "playwright" => {
            let open = match config {
                Some(c) => format!("open --headed --config=\"{}\" URL", c.display()),
                None => "open --headed URL".into(),
            };
            let login = match config {
                Some(_) => "The browsers start logged in as the user (saved with `panex-cli browser-login`).\n    The saved login is put back on every page load, so a logout test looks logged in again\n    after it navigates: test logged-out pages in a session opened without --config. If a page\n    lands on the login screen anyway, the saved login has expired: tell the user to log in\n    again from Settings → \"Log in and save\", and don't log in yourself.",
                None => "No login is saved yet, so the browsers start logged out. If the pages need a login,\n    ask the user to save one from Settings → \"Log in and save\" before you start the agents.",
            };
            format!(
                r#"
Testing web pages (the user picked Playwright with a shared login in panex's settings):
    Each agent drives its own Playwright browser, so several can test at once and the user's
    Chrome is never touched.
    {login}
    Start each agent with Claude in Chrome turned off:
        -- claude --no-chrome "Do what TASK.md says, then commit"
    and tell it in TASK.md, with its branch name as the session:
        npx -y {PLAYWRIGHT_CLI} -s=BRANCH {open}
        npx -y {PLAYWRIGHT_CLI} -s=BRANCH snapshot / click / fill / screenshot ...
        npx -y {PLAYWRIGHT_CLI} -s=BRANCH close        when done; a headed browser never closes by itself
    Drop --headed to run the browser hidden.
"#
            )
        }
        "claude-in-chrome" => r#"
Testing web pages (the user picked Claude in Chrome in panex's settings):
    Start each agent with it turned on: -- claude --chrome "Do what TASK.md says, then commit"
    and tell it in TASK.md to open its own tab and leave the user's tabs alone.
"#
        .into(),
        _ => String::new(),
    }
}

/// Script run before every page: puts the saved sessionStorage back on the saved origin, key by
/// key and only where missing (cookies and localStorage come back through storageState, but
/// sessionStorage is per tab and Playwright does not save it).
fn init_script(origin: &str, data: &serde_json::Map<String, Value>) -> String {
    format!(
        "(() => {{\n  if (location.origin !== {}) return;\n  const data = {};\n  for (const k in data) if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, data[k]);\n}})();\n",
        json!(origin),
        Value::Object(data.clone())
    )
}

/// playwright-cli config that opens an isolated browser with the saved login.
fn cli_config(dir: &Path) -> Value {
    json!({ "browser": {
        "isolated": true,
        "contextOptions": { "storageState": dir.join("auth.json") },
        "initScript": [dir.join("session-init.js")],
    }})
}

/// Runs playwright-cli in the login folder (its session files and snapshots land there too).
fn playwright(dir: &Path, args: &[&str], capture: bool) -> Result<String, String> {
    let mut cmd = std::process::Command::new(if cfg!(windows) { "npx.cmd" } else { "npx" });
    cmd.args(["-y", PLAYWRIGHT_CLI, "-s=panex-login"]).args(args).current_dir(dir);
    if capture {
        let out = cmd.output().map_err(|e| format!("cannot run npx: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let st = cmd.status().map_err(|e| format!("cannot run npx: {e}"))?;
        if st.success() { Ok(String::new()) } else { Err(format!("playwright-cli {} failed", args[0])) }
    }
}

/// `panex-cli browser-login`: opens agent.crewLoginUrl in a Playwright browser, waits while the
/// user logs in, then saves the login for crew agents. The URL comes from panex.json, not the
/// command line, so the settings page never types it into a shell.
fn browser_login() -> Result<(), String> {
    let url = agent_config()["crewLoginUrl"].as_str().unwrap_or_default().trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("set the login page URL in Settings → Terminal first".into());
    }
    let dir = login_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    playwright(&dir, &["open", "--headed", &url], false)?;
    print!("\nLog in in the browser window that just opened, then come back here and press Enter. ");
    std::io::stdout().flush().ok();
    std::io::stdin().read_line(&mut String::new()).map_err(|e| e.to_string())?;
    let result = (|| {
        playwright(&dir, &["state-save", "auth.json"], false)?;
        let raw = playwright(&dir, &["eval", "() => JSON.stringify({ origin: location.origin, data: { ...sessionStorage } })", "--raw"], true)?;
        // --raw prints the returned string as a JSON string literal.
        let text = serde_json::from_str::<String>(raw.trim()).unwrap_or_else(|_| raw.trim().to_string());
        let page: Value = serde_json::from_str(&text).map_err(|e| format!("unexpected eval output: {e}"))?;
        let origin = page["origin"].as_str().ok_or("unexpected eval output: no origin")?;
        let data = page["data"].as_object().cloned().unwrap_or_default();
        std::fs::write(dir.join("session-init.js"), init_script(origin, &data)).map_err(|e| e.to_string())?;
        let config = serde_json::to_string_pretty(&cli_config(&dir)).unwrap();
        std::fs::write(dir.join("cli.config.json"), config).map_err(|e| e.to_string())?;
        Ok::<_, String>(origin.to_string())
    })();
    let _ = playwright(&dir, &["close"], false);
    let origin = result?;
    println!("\nSaved the login for {origin}. Crew agents' browsers now start logged in; you can close this tab.");
    Ok(())
}

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
    fn browser_help_follows_the_setting() {
        let cfg = Path::new("cfg.json");
        assert!(browser_help("playwright", Some(cfg)).contains("--config=\"cfg.json\""));
        assert!(browser_help("playwright", None).contains("No login is saved yet"));
        assert!(browser_help("claude-in-chrome", None).contains("--chrome"));
        assert_eq!(browser_help("", None), "");
        assert_eq!(browser_help("bogus", None), "");
    }

    #[test]
    fn init_script_restores_only_missing_keys_on_its_origin() {
        let data = json!({ "user": "{\"a\":1}" }).as_object().unwrap().clone();
        let js = init_script("https://example.com", &data);
        assert!(js.contains("location.origin !== \"https://example.com\""));
        assert!(js.contains(r#"{"user":"{\"a\":1}"}"#));
        assert!(js.contains("sessionStorage.getItem(k) === null"));
        let cfg = cli_config(Path::new("dir"));
        assert_eq!(cfg["browser"]["isolated"], true);
        assert!(cfg["browser"]["initScript"][0].as_str().unwrap().ends_with("session-init.js"));
    }

    #[test]
    fn wait_needs_tabs() {
        assert!(wait_request(&[]).is_err());
        let req = wait_request(&["a".into(), "--timeout".into(), "5".into(), "b".into()]).unwrap();
        assert_eq!(req["tabs"], json!(["a", "b"]));
        assert_eq!(req["timeout"], 5);
    }
}
