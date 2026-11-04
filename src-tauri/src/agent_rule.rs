//! The test for "ending this tab loses nothing but a Claude Code that `claude --resume` brings
//! back", shared by the Windows job (`job.rs`) and the macOS process tree (`job_unix.rs`);
//! they differ only in how executables are named.

use std::collections::HashMap;

/// Executable names (lower case, no directory) for one platform.
pub struct Rule {
    /// The Claude Code process.
    pub agent: &'static [&'static str],
    /// Shells claude runs its Bash / PowerShell tool in.
    pub shells: &'static [&'static str],
    /// Helpers that never count as something running (the console host).
    pub ignore: &'static [&'static str],
}

#[cfg(windows)]
pub const WINDOWS: Rule = Rule {
    agent: &["claude.exe"],
    shells: &["bash.exe", "sh.exe", "powershell.exe", "pwsh.exe"],
    ignore: &["conhost.exe"],
};

#[cfg(unix)]
pub const UNIX: Rule = Rule { agent: &["claude"], shells: &["bash", "sh", "zsh"], ignore: &[] };

/// The rule behind `Job::only_agent`: every process in `pids` is the shell, a console host,
/// or part of a Claude Code (`rule.agent`) the shell started, and that claude has no Bash / PowerShell / zsh tool
/// shell open (a background task). Anything else (a dev server, a GUI app from `start`, a
/// process whose parent is gone) means no; so does no claude at all.
pub fn only_agent_in(pids: &[u32], procs: &HashMap<u32, (u32, String)>, shell: u32, rule: &Rule) -> bool {
    let mut agent = false;
    for &pid in pids {
        if pid == shell {
            continue;
        }
        let Some((_, exe)) = procs.get(&pid) else { continue }; // already gone
        if rule.ignore.contains(&exe.as_str()) {
            continue;
        }
        // Walk up to the process the shell itself started; give up on a broken chain.
        let (mut cur, mut top) = (pid, None);
        for _ in 0..64 {
            let Some(&(parent, _)) = procs.get(&cur) else { break };
            if parent == shell {
                top = Some(cur);
                break;
            }
            if !pids.contains(&parent) {
                break;
            }
            cur = parent;
        }
        let Some(top) = top else { return false };
        if procs.get(&top).map(|(_, e)| e.as_str()) .is_none_or(|e| !rule.agent.contains(&e)) {
            return false;
        }
        // A tool shell with nothing running under it is a leftover of a finished command;
        // one with a child is a background task (`sleep`, a dev server) that would be lost.
        if pid != top && rule.shells.contains(&exe.as_str()) {
            let busy = pids
                .iter()
                .any(|c| procs.get(c).is_some_and(|(p, e)| *p == pid && !rule.ignore.contains(&e.as_str())));
            if busy {
                return false;
            }
        }
        agent |= pid == top;
    }
    agent
}

/// macOS's KERN_PROCARGS2 buffer: argc as an i32, the executable's path, NUL padding, then argv.
/// Here rather than in `job_unix.rs` so its tests run on every platform.
/// @returns the arguments, program name excluded; None if the buffer isn't that shape
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_procargs(buf: &[u8]) -> Option<Vec<String>> {
    let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?);
    let argc = usize::try_from(argc).ok()?;
    let rest = &buf[4..];
    let rest = &rest[rest.iter().position(|&b| b == 0)?..]; // past the path
    let rest = &rest[rest.iter().position(|&b| b != 0)?..]; // past the padding
    let argv: Vec<String> = rest.split(|&b| b == 0).take(argc).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
    if argv.len() < argc {
        return None;
    }
    Some(argv.into_iter().skip(1).collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_procargs() {
        let mut buf = 3i32.to_ne_bytes().to_vec();
        buf.extend_from_slice(b"/usr/local/bin/claude\0\0\0claude\0--settings\0a b.json\0HOME=/x\0");
        assert_eq!(super::parse_procargs(&buf), Some(vec!["--settings".to_string(), "a b.json".to_string()]));
        assert_eq!(super::parse_procargs(&[1, 0]), None);
        let mut short = 5i32.to_ne_bytes().to_vec();
        short.extend_from_slice(b"/p\0a\0b");
        assert_eq!(super::parse_procargs(&short), None);
    }

    use super::*;

    // Windows names, so the same cases cover both platforms' logic.
    const TEST: Rule = Rule {
        agent: &["claude.exe"],
        shells: &["bash.exe", "sh.exe", "powershell.exe", "pwsh.exe"],
        ignore: &["conhost.exe"],
    };

    /// (pid, parent, exe) rows; the shell is pid 1.
    fn check(rows: &[(u32, u32, &str)]) -> bool {
        let procs = rows.iter().map(|&(p, pp, e)| (p, (pp, e.to_string()))).collect();
        let pids: Vec<u32> = rows.iter().map(|r| r.0).collect();
        only_agent_in(&pids, &procs, 1, &TEST)
    }

    #[test]
    fn claude_with_mcp_servers_is_only_agent() {
        assert!(check(&[
            (1, 0, "cmd.exe"),
            (2, 1, "conhost.exe"),
            (10, 1, "claude.exe"),
            (11, 10, "cmd.exe"),
            (12, 11, "node.exe"),
            (13, 12, "conhost.exe"),
            (14, 10, "python.exe"),
        ]));
    }

    #[test]
    fn bare_shell_is_not() {
        assert!(!check(&[(1, 0, "cmd.exe"), (2, 1, "conhost.exe")]));
    }

    #[test]
    fn anything_else_under_the_shell_is_not() {
        assert!(!check(&[(1, 0, "cmd.exe"), (10, 1, "claude.exe"), (20, 1, "node.exe")]));
        assert!(!check(&[(1, 0, "cmd.exe"), (10, 1, "claude.exe"), (20, 1, "Code.exe")]));
    }

    #[test]
    fn a_tool_shell_with_a_running_child_is_not() {
        assert!(!check(&[(1, 0, "cmd.exe"), (10, 1, "claude.exe"), (11, 10, "bash.exe"), (12, 11, "sleep.exe")]));
        assert!(!check(&[
            (1, 0, "cmd.exe"),
            (10, 1, "claude.exe"),
            (11, 10, "cmd.exe"),
            (12, 11, "pwsh.exe"),
            (13, 12, "node.exe"),
        ]));
    }

    #[test]
    fn an_idle_tool_shell_inside_claude_is_fine() {
        assert!(check(&[(1, 0, "cmd.exe"), (10, 1, "claude.exe"), (11, 10, "bash.exe")]));
        assert!(check(&[
            (1, 0, "cmd.exe"),
            (10, 1, "claude.exe"),
            (11, 10, "bash.exe"),
            (12, 11, "conhost.exe"),
        ]));
    }

    #[test]
    fn an_orphan_is_not() {
        // 30's parent 29 has exited, so nothing says it belongs to claude.
        assert!(!check(&[(1, 0, "cmd.exe"), (10, 1, "claude.exe"), (30, 29, "node.exe")]));
    }

    #[test]
    fn a_process_gone_mid_check_is_ignored() {
        let procs = [(1, (0, "cmd.exe".into())), (10, (1, "claude.exe".into()))].into_iter().collect();
        assert!(only_agent_in(&[1, 10, 99], &procs, 1, &TEST));
    }
}
