//! panex-cli: tiny helper for agent hooks, and the way an agent drives panex.
//!
//!   panex-cli notify [message]      (agent hooks)
//!   panex-cli open … / wait …       (an agent starting other agents in new tabs; see HELP)
//!
//! notify reads the hook JSON from stdin (Claude Code passes it there), adds the pane id from
//! PANEX_PANE_ID and sends it to the running panex over PANEX_PIPE. Outside panex those
//! variables are missing and it exits 0 immediately. It always exits 0 so a hook never
//! shows an error or blocks the agent. open and wait send a request with PANEX_TOKEN and
//! print panex's JSON answer; they exit 1 on errors and 2 when wait times out.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::sync::mpsc;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("notify") => notify(&args[1..]),
        Some("open") => std::process::exit(run(open_request(&args[1..]))),
        Some("wait") => std::process::exit(run(wait_request(&args[1..]))),
        Some("help" | "--help" | "-h") | None => print!("{HELP}{}", browser_help(&crew_browser())),
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

/// agent.crewBrowser from panex.json, read on every `help` so it follows the settings page
/// without restarting any tab. Same location as config::dir (not linked: that pulls in Tauri).
fn crew_browser() -> String {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let file = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(home).join(".config"))
        .join("panex")
        .join("panex.json");
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["agent"]["crewBrowser"].as_str().map(String::from))
        .unwrap_or_default()
}

/// The part of the help that depends on the user's choice in Settings → crew browser.
fn browser_help(choice: &str) -> &'static str {
    match choice {
        "playwright" => r#"
Testing web pages (the user picked Playwright with their own Chrome in panex's settings):
    Agents drive the user's real Chrome through Playwright CLI, so they reuse the user's logins.
    Start each agent with Claude in Chrome turned off:
        -- claude --no-chrome "Do what TASK.md says, then commit"
    and tell it in TASK.md, with its branch name as the session:
        playwright-cli -s=BRANCH attach --extension     connect to the user's Chrome
        playwright-cli -s=BRANCH tab-new URL            work only in tabs you opened
        playwright-cli -s=BRANCH snapshot / click / fill / screenshot ...
        playwright-cli -s=BRANCH detach                 when done; never `close`, it is the user's browser
    Only one agent can be attached to the user's Chrome at a time: another attach fails with
    "Could not start the session" until the first one detaches. So let one agent at a time do
    the browser part (have the others wait for it, or do it yourself after they commit), and
    have every agent detach as soon as its browser checks are done.
    playwright-cli is the npm package @playwright/cli (use `npx -y @playwright/cli` if it is not
    installed). It needs the Playwright Extension in the user's Chrome; unless
    PLAYWRIGHT_MCP_EXTENSION_TOKEN is set, the user must approve each connection in Chrome, and
    the agent just looks busy until they do, so tell them to click the plain "Allow" (no tab
    needed: the agent opens its own tabs, which go into the green "Playwright" tab group).
"#,
        "claude-in-chrome" => r#"
Testing web pages (the user picked Claude in Chrome in panex's settings):
    Start each agent with it turned on: -- claude --chrome "Do what TASK.md says, then commit"
    and tell it in TASK.md to open its own tab and leave the user's tabs alone.
"#,
        _ => "",
    }
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
        assert!(browser_help("playwright").contains("attach --extension"));
        assert!(browser_help("claude-in-chrome").contains("--chrome"));
        assert_eq!(browser_help(""), "");
        assert_eq!(browser_help("bogus"), "");
    }

    #[test]
    fn wait_needs_tabs() {
        assert!(wait_request(&[]).is_err());
        let req = wait_request(&["a".into(), "--timeout".into(), "5".into(), "b".into()]).unwrap();
        assert_eq!(req["tabs"], json!(["a", "b"]));
        assert_eq!(req["timeout"], 5);
    }
}
