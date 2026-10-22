//! SSH tabs run the system's own `ssh` inside the tab's pty, so keys, `~/.ssh/config`,
//! known_hosts, the agent and password prompts all behave exactly as in any terminal.
//! panex never sees a credential.

use portable_pty::CommandBuilder;
use std::path::PathBuf;

/// `Host` aliases from `~/.ssh/config` (and files it `Include`s), for the host picker.
/// Patterns (`*`, `?`, `!`) are skipped: they aren't something you connect to.
#[tauri::command]
pub fn ssh_hosts() -> Vec<String> {
    let Some(dir) = ssh_dir() else { return Vec::new() };
    let mut hosts = Vec::new();
    read_config(&dir.join("config"), &dir, &mut hosts, 0);
    hosts
}

fn read_config(path: &std::path::Path, dir: &std::path::Path, hosts: &mut Vec<String>, depth: u8) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    for line in text.lines() {
        // `#` starts a comment at line start or after whitespace (trailing notes after aliases are common).
        let line = match line.char_indices().find(|&(i, c)| c == '#' && (i == 0 || line[..i].ends_with(char::is_whitespace))) {
            Some((i, _)) => &line[..i],
            None => line,
        };
        let line = line.trim();
        let (key, rest) = line.split_once(|c: char| c.is_whitespace() || c == '=').unwrap_or((line, ""));
        let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
        if key.eq_ignore_ascii_case("host") {
            for h in rest.split_whitespace().map(|h| h.trim_matches('"')) {
                if !h.contains(['*', '?', '!']) && valid_target(h) && !hosts.iter().any(|x| x == h) {
                    hosts.push(h.to_string());
                }
            }
        } else if key.eq_ignore_ascii_case("include") && depth < 4 {
            for pat in rest.split_whitespace().map(|p| p.trim_matches('"')) {
                for inc in expand_include(pat, dir) {
                    read_config(&inc, dir, hosts, depth + 1);
                }
            }
        }
    }
}

/// `Include` paths are relative to `~/.ssh`; only a `*` in the last segment is expanded.
fn expand_include(pat: &str, dir: &std::path::Path) -> Vec<PathBuf> {
    let p = match pat.strip_prefix("~/") {
        Some(r) => home_dir().map(|h| h.join(r)),
        None if std::path::Path::new(pat).is_absolute() => Some(PathBuf::from(pat)),
        None => Some(dir.join(pat)),
    };
    let Some(p) = p else { return Vec::new() };
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !name.contains('*') {
        return vec![p];
    }
    let (pre, suf) = name.split_once('*').unwrap_or((name, ""));
    let Some(parent) = p.parent() else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(parent) else { return Vec::new() };
    let mut v: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|f| f.is_file())
        .filter(|f| f.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(pre) && n.ends_with(suf)))
        .collect();
    v.sort();
    v
}

/// `[user@]host[:port]`. The target ends up on ssh's command line, so it must not look
/// like an option and may only hold characters a host, user or port can have.
pub fn valid_target(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 255
        && !t.starts_with('-')
        && t.chars().all(|c| c.is_ascii_alphanumeric() || "@._-:[]%".contains(c))
}

/// Splits a trailing `:port` (not part of a bare IPv6 address) into ssh's `-p`.
fn split_port(t: &str) -> (&str, Option<&str>) {
    if let Some(rest) = t.strip_prefix('[').or_else(|| t.split_once("@[").map(|(_, r)| r)) {
        // [v6]:port or user@[v6]:port
        if let Some((_, port)) = rest.split_once("]:") {
            if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() {
                return (&t[..t.len() - port.len() - 1], Some(port));
            }
        }
        return (t, None);
    }
    match t.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') && !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => (host, Some(port)),
        _ => (t, None),
    }
}

pub fn command(target: &str) -> Result<CommandBuilder, String> {
    if !valid_target(target) {
        return Err("invalid ssh target".into());
    }
    let (dest, port) = split_port(target);
    let dest = dest.replace(['[', ']'], "");
    let mut cmd = CommandBuilder::new(if cfg!(windows) { "ssh.exe" } else { "ssh" });
    if let Some(p) = port {
        cmd.args(["-p", p]);
    }
    cmd.arg("--");
    cmd.arg(dest);
    Ok(cmd)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn ssh_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".ssh"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets() {
        assert!(valid_target("user@example.com"));
        assert!(valid_target("host:2222"));
        assert!(!valid_target("-oProxyCommand=calc"));
        assert!(!valid_target("a b"));
        assert!(!valid_target("a;b"));
        assert_eq!(split_port("u@h:2222"), ("u@h", Some("2222")));
        assert_eq!(split_port("u@h"), ("u@h", None));
        assert_eq!(split_port("::1"), ("::1", None));
        assert_eq!(split_port("[::1]:22"), ("[::1]", Some("22")));
        assert_eq!(split_port("u@[fe80::1]:22"), ("u@[fe80::1]", Some("22")));
    }
}
