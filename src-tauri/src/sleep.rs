//! What memory-pressure hibernation needs from outside panex: how much memory the machine has
//! left, and whether a tab's Claude Code can be ended without losing anything. Claude Code writes
//! `<claude dir>/sessions/<pid>.json` for every interactive process and keeps its state there.
//! That format isn't documented, so anything unexpected counts as "don't touch this tab".

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// How much of a transcript's end is read when looking for unfinished background work.
const TRANSCRIPT_TAIL: u64 = 16 * 1024 * 1024;

/// Why a tab can't be hibernated right now, as the frontend sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No Claude Code found in the tab, or its state file made no sense.
    NoAgent,
    /// Connected to Remote Control: ending the process would drop the phone.
    Remote,
    /// Claude Code says it isn't idle.
    Busy,
    /// A background task or subagent started by this process hasn't finished.
    Background,
    /// Something other than Claude Code runs in the tab.
    Processes,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::NoAgent => "no-agent",
            Refusal::Remote => "remote",
            Refusal::Busy => "busy",
            Refusal::Background => "background",
            Refusal::Processes => "processes",
        }
    }
}

fn claude_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|h| PathBuf::from(h).join(".claude"))
}

#[derive(Debug, PartialEq, Eq)]
struct Live {
    session: String,
    remote: bool,
    idle: bool,
    started_ms: i64,
}

fn parse_live(text: &str) -> Option<Live> {
    let v: Value = serde_json::from_str(text).ok()?;
    Some(Live {
        session: v["sessionId"].as_str().filter(|s| !s.is_empty())?.to_string(),
        remote: v.get("bridgeSessionId").is_some_and(|b| !b.is_null()),
        idle: v["status"].as_str() == Some("idle"),
        started_ms: v["startedAt"].as_i64()?,
    })
}

/// The Claude Code among `pids`. None when there is none, or more than one (a claude started
/// from claude's own tool shell): which session the tab resumes is then unclear.
fn live_in(dir: &Path, pids: &[u32]) -> Option<Live> {
    parse_live(&live_file(dir, pids)?.1)
}

/// The one Claude Code's pid among `pids` and the text of its state file.
fn live_file(dir: &Path, pids: &[u32]) -> Option<(u32, String)> {
    let mut found = pids.iter().filter_map(|pid| Some((*pid, std::fs::read_to_string(dir.join("sessions").join(format!("{pid}.json"))).ok()?)));
    let first = found.next()?;
    if found.next().is_some() {
        return None;
    }
    Some(first)
}

/// The pid of the one Claude Code among these processes.
pub fn agent_pid(pids: &[u32]) -> Option<u32> {
    live_file(&claude_dir()?, pids).map(|(pid, _)| pid)
}

/// Whether a Claude Code is running among these processes.
pub fn agent_among(pids: &[u32]) -> bool {
    claude_dir().is_some_and(|dir| live_in(&dir, pids).is_some())
}

/// The checks that read Claude Code's files; the process tree is the caller's.
pub fn check_agent(pids: &[u32]) -> Result<(), Refusal> {
    let dir = claude_dir().ok_or(Refusal::NoAgent)?;
    let live = live_in(&dir, pids).ok_or(Refusal::NoAgent)?;
    if live.remote {
        return Err(Refusal::Remote);
    }
    if !live.idle {
        return Err(Refusal::Busy);
    }
    // Only a tab that passes the checks above costs a transcript read.
    let path = transcript_of(&dir, &live.session).ok_or(Refusal::Background)?;
    let tail = read_tail(&path, TRANSCRIPT_TAIL).ok_or(Refusal::Background)?;
    if background_pending(&tail, &iso_ms(live.started_ms)) {
        return Err(Refusal::Background);
    }
    Ok(())
}

/// The state-file part of `check_agent`, cheap enough to repeat right before ending the tab.
pub fn check_state(pids: &[u32]) -> Result<(), Refusal> {
    let dir = claude_dir().ok_or(Refusal::NoAgent)?;
    let live = live_in(&dir, pids).ok_or(Refusal::NoAgent)?;
    if live.remote {
        return Err(Refusal::Remote);
    }
    if !live.idle {
        return Err(Refusal::Busy);
    }
    Ok(())
}

fn transcript_of(dir: &Path, session: &str) -> Option<PathBuf> {
    // The session id came from Claude Code's own file, but it still becomes a path.
    if !session.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    std::fs::read_dir(dir.join("projects")).ok()?.flatten().map(|e| e.path().join(format!("{session}.jsonl"))).find(|p| p.is_file())
}

/// The end of a file, starting at a line boundary.
fn read_tail(path: &Path, max: u64) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(max);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    Some(if start == 0 { text } else { text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default() })
}

/// Whether the transcript shows background work (a backgrounded command, a Monitor, an async
/// subagent) that this process started and that has no `<task-notification>` with a status yet.
/// `since` is the process's start as an ISO time: older work died with the process before it.
/// Subagents run inside the Claude process, so the process tree can't show them.
fn background_pending(transcript: &str, since: &str) -> bool {
    let mut started: Vec<Vec<String>> = Vec::new();
    let mut finished: HashSet<String> = HashSet::new();
    for line in transcript.lines() {
        let launch = line.contains("\"backgroundTaskId\"") || line.contains("\"async_launched\"") || line.contains("\"taskId\"");
        let done = line.contains("<task-notification>");
        if !launch && !done {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if done && v["type"].as_str() == Some("user") {
            let text = v["message"]["content"].as_str().map(str::to_string).unwrap_or_else(|| {
                v["message"]["content"].as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n")
            });
            // A Monitor's event notifications have no status and don't end it. Text quoted from
            // a tool result arrives as `tool_result`, not as `text`, so it isn't looked at.
            for note in text.split("<task-notification>").skip(1) {
                if note.contains("<status>") {
                    for tag in ["task-id", "tool-use-id"] {
                        if let Some(id) = between(note, tag) {
                            finished.insert(id.to_string());
                        }
                    }
                }
            }
        }
        let Some(r) = v.get("toolUseResult") else { continue };
        let async_agent = r["status"].as_str() == Some("async_launched");
        let task = r["backgroundTaskId"].as_str().or(r["taskId"].as_str());
        if !async_agent && task.is_none() {
            continue;
        }
        if v["timestamp"].as_str().is_some_and(|t| t < since) {
            continue;
        }
        let mut ids: Vec<String> = [task, r["agentId"].as_str()].into_iter().flatten().map(str::to_string).collect();
        if let Some(blocks) = v["message"]["content"].as_array() {
            ids.extend(blocks.iter().filter_map(|b| b["tool_use_id"].as_str()).map(str::to_string));
        }
        started.push(ids);
    }
    started.iter().any(|ids| !ids.iter().any(|id| finished.contains(id)))
}

fn between<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let rest = &text[text.find(&open)? + open.len()..];
    Some(rest[..rest.find(&format!("</{tag}>"))?].trim())
}

/// Milliseconds since the epoch as the `YYYY-MM-DDTHH:MM:SS.mmmZ` form transcripts use, which
/// sorts as text.
fn iso_ms(ms: i64) -> String {
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    total: u64,
    available: u64,
    /// Windows only: the commit limit (physical memory plus page files) and what is left of it.
    commit_total: Option<u64>,
    commit_available: Option<u64>,
}

/// Physical memory and how much of it is free to use, for the frontend's pressure rule.
#[tauri::command]
pub fn memory_status(app: AppHandle) -> Result<Memory, String> {
    let (mut total, mut available, mut commit) = read_memory()?;
    // Pressure can't be forced on a machine someone is working on, so a test instance reads
    // "<total> <available> [<commit total> <commit available>]" from a file it names. The real instance never looks.
    if app.config().identifier != "dev.panex.terminal" {
        if let Some(text) = std::env::var_os("PANEX_TEST_MEM_FILE").and_then(|p| std::fs::read_to_string(p).ok()) {
            let mut nums = text.split_whitespace().filter_map(|n| n.parse::<u64>().ok());
            if let (Some(t), Some(a)) = (nums.next(), nums.next()) {
                (total, available) = (t, a);
            }
            if let (Some(t), Some(a)) = (nums.next(), nums.next()) {
                commit = Some((t, a));
            }
        }
    }
    let (commit_total, commit_available) = commit.unzip();
    Ok(Memory { total, available, commit_total, commit_available })
}

#[cfg(windows)]
fn read_memory() -> Result<(u64, u64, Option<(u64, u64)>), String> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut m: MEMORYSTATUSEX = std::mem::zeroed();
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut m) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // Despite the name these are the commit limit and what's left of it: allocations fail
        // once it runs out, however much physical memory is still free.
        Ok((m.ullTotalPhys, m.ullAvailPhys, Some((m.ullTotalPageFile, m.ullAvailPageFile))))
    }
}

#[cfg(unix)]
fn read_memory() -> Result<(u64, u64, Option<(u64, u64)>), String> {
    let sysctl = |name: &str| -> Result<u64, String> {
        let out = std::process::Command::new("/usr/sbin/sysctl").args(["-n", name]).output().map_err(|e| e.to_string())?;
        String::from_utf8_lossy(&out.stdout).trim().parse().map_err(|e| format!("{name}: {e}"))
    };
    let total = sysctl("hw.memsize")?;
    // The percentage of memory macOS considers free, the number its own pressure levels use.
    let level = sysctl("kern.memorystatus_level")?;
    // macOS grows its swap as needed, so there is no commit limit to watch.
    Ok((total, total / 100 * level.min(100), None))
}

/// Windows tells a waiting thread when memory runs low, so the app needs no timer to notice while
/// nothing else is happening. The signal stays on while memory is low, hence the pause.
#[cfg(windows)]
pub fn watch_low_memory(app: AppHandle) {
    use tauri::{Emitter, Manager};
    use windows_sys::Win32::System::Memory::{CreateMemoryResourceNotification, LowMemoryResourceNotification};
    use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    std::thread::spawn(move || unsafe {
        let signal = CreateMemoryResourceNotification(LowMemoryResourceNotification);
        if signal.is_null() {
            return;
        }
        loop {
            if WaitForSingleObject(signal, INFINITE) != 0 {
                return;
            }
            if app.state::<crate::AppState>().quitting() {
                return;
            }
            let _ = app.emit("memory-low", ());
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SINCE: &str = "2026-11-04T01:00:00.000Z";

    fn launch(time: &str, result: &str) -> String {
        format!(r#"{{"type":"user","timestamp":"{time}","message":{{"content":[{{"type":"tool_result","tool_use_id":"toolu_1"}}]}},"toolUseResult":{result}}}"#)
    }

    fn note(id: &str, extra: &str) -> String {
        let text = format!("<task-notification><task-id>{id}</task-id>{extra}</task-notification>");
        serde_json::json!({ "type": "user", "timestamp": "2026-11-04T02:00:00.000Z", "message": { "content": text } }).to_string()
    }

    #[test]
    fn background_command_blocks_until_its_notification() {
        let start = launch("2026-11-04T01:30:00.000Z", r#"{"backgroundTaskId":"bg1"}"#);
        assert!(background_pending(&start, SINCE));
        let both = format!("{start}\n{}", note("bg1", "<status>completed</status>"));
        assert!(!background_pending(&both, SINCE));
    }

    #[test]
    fn async_subagent_blocks_until_its_notification() {
        let start = launch("2026-11-04T01:30:00.000Z", r#"{"isAsync":true,"status":"async_launched","agentId":"a1"}"#);
        assert!(background_pending(&start, SINCE));
        assert!(!background_pending(&format!("{start}\n{}", note("a1", "<status>completed</status>")), SINCE));
    }

    #[test]
    fn notification_can_name_the_tool_use_instead() {
        let start = launch("2026-11-04T01:30:00.000Z", r#"{"isAsync":true,"status":"async_launched"}"#);
        let done = note("other", "<tool-use-id>toolu_1</tool-use-id><status>completed</status>");
        assert!(!background_pending(&format!("{start}\n{done}"), SINCE));
    }

    #[test]
    fn monitor_event_without_status_does_not_finish_it() {
        let start = launch("2026-11-04T01:30:00.000Z", r#"{"taskId":"m1"}"#);
        assert!(background_pending(&format!("{start}\n{}", note("m1", "<event>line</event>")), SINCE));
    }

    #[test]
    fn work_from_before_this_process_is_ignored() {
        let start = launch("2026-11-04T00:30:00.000Z", r#"{"backgroundTaskId":"old"}"#);
        assert!(!background_pending(&start, SINCE));
    }

    #[test]
    fn notification_quoted_in_a_tool_result_does_not_count() {
        let start = launch("2026-11-04T01:30:00.000Z", r#"{"backgroundTaskId":"bg1"}"#);
        let quoted = serde_json::json!({ "type": "user", "message": { "content": [{
            "type": "tool_result", "content": "<task-notification><task-id>bg1</task-id><status>completed</status></task-notification>"
        }] } }).to_string();
        assert!(background_pending(&format!("{start}\n{quoted}"), SINCE));
    }

    #[test]
    fn broken_lines_are_skipped() {
        assert!(!background_pending("{ not json \"backgroundTaskId\"\n\n", SINCE));
    }

    #[test]
    fn state_file_is_read_strictly() {
        let good = r#"{"sessionId":"s1","status":"idle","startedAt":5,"bridgeSessionId":"session_x"}"#;
        assert_eq!(parse_live(good), Some(Live { session: "s1".into(), remote: true, idle: true, started_ms: 5 }));
        let local = parse_live(r#"{"sessionId":"s1","status":"busy","startedAt":5}"#).unwrap();
        assert!(!local.remote && !local.idle);
        assert_eq!(parse_live(r#"{"status":"idle","startedAt":5}"#), None);
        assert_eq!(parse_live(r#"{"sessionId":"s1","status":"idle"}"#), None);
        assert_eq!(parse_live("not json"), None);
    }

    #[test]
    fn iso_matches_transcript_times() {
        assert_eq!(iso_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_ms(1_793_844_000_123), "2026-11-05T02:00:00.123Z");
    }

    #[test]
    fn tail_starts_at_a_line_boundary() {
        let dir = std::env::temp_dir().join(format!("panex-sleep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        std::fs::write(&p, "first line\nsecond\nthird\n").unwrap();
        assert_eq!(read_tail(&p, 10).unwrap(), "third\n");
        assert_eq!(read_tail(&p, 100).unwrap(), "first line\nsecond\nthird\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn more_than_one_claude_is_not_a_clear_session() {
        let dir = std::env::temp_dir().join(format!("panex-sleep-live-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        let body = r#"{"sessionId":"s1","status":"idle","startedAt":5}"#;
        std::fs::write(dir.join("sessions").join("10.json"), body).unwrap();
        std::fs::write(dir.join("sessions").join("11.json"), body).unwrap();
        assert!(live_in(&dir, &[10]).is_some());
        assert!(live_in(&dir, &[10, 11]).is_none());
        assert!(live_in(&dir, &[12]).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
