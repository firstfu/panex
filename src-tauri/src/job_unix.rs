//! macOS counterpart of `job.rs`: a tab's "job" is the shell plus every process descended
//! from it. There is no kill-on-close here, so a crashed panex leaves a tab's programs running.
//! Walking parent links rather than signalling a process group is deliberate: zsh puts each
//! command in its own group, so claude is not in the shell's group.
//! Memory is resident size (`ps` rss), which counts shared pages, so it reads higher than
//! the private memory the Windows job reports.

use std::collections::{HashMap, HashSet};
use std::process::Command;

pub struct Job {
    root: u32,
}

struct Row {
    pid: u32,
    ppid: u32,
    rss_kb: u64,
}

impl Job {
    pub fn assign(shell: u32) -> Job {
        Job { root: shell }
    }

    /// Resident memory of the shell and everything under it, and how many processes that is.
    pub fn usage(&self) -> (u64, u32) {
        let rows = snapshot();
        let tree = descendants(self.root, &rows);
        let kb: u64 = rows.iter().filter(|r| tree.contains(&r.pid)).map(|r| r.rss_kb).sum();
        (kb * 1024, tree.len() as u32)
    }

    /// Kills the shell and all its descendants. A program can fork while we signal, so look
    /// again until nothing new turns up.
    pub fn terminate(&self) {
        for _ in 0..4 {
            let rows = snapshot();
            let tree = descendants(self.root, &rows);
            if tree.is_empty() {
                return;
            }
            for pid in tree {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
        }
    }
}

/// `root` and every process below it; empty if `root` is gone (its children were adopted by
/// launchd and can no longer be told apart).
fn descendants(root: u32, rows: &[Row]) -> HashSet<u32> {
    let mut tree = HashSet::new();
    if !rows.iter().any(|r| r.pid == root) {
        return tree;
    }
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in rows {
        kids.entry(r.ppid).or_default().push(r.pid);
    }
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if tree.insert(p) {
            stack.extend(kids.get(&p).into_iter().flatten().copied());
        }
    }
    tree
}

fn snapshot() -> Vec<Row> {
    let Ok(out) = Command::new("ps").args(["-axo", "pid=,ppid=,rss="]).output() else { return Vec::new() };
    parse(&String::from_utf8_lossy(&out.stdout))
}

/// `pid ppid rss` per line.
fn parse(text: &str) -> Vec<Row> {
    text.lines()
        .filter_map(|line| {
            let mut w = line.split_whitespace();
            Some(Row { pid: w.next()?.parse().ok()?, ppid: w.next()?.parse().ok()?, rss_kb: w.next()?.parse().ok()? })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ps_rows() {
        let rows = parse("  100     1  2048\n  101   100   512\n");
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].pid, rows[0].ppid, rows[0].rss_kb), (100, 1, 2048));
        assert_eq!((rows[1].pid, rows[1].ppid, rows[1].rss_kb), (101, 100, 512));
    }

    #[test]
    fn walks_down_from_the_shell_only() {
        let row = |pid, ppid| Row { pid, ppid, rss_kb: 1 };
        let rows = [row(1, 0), row(10, 1), row(11, 10), row(12, 11), row(20, 1)];
        let t = descendants(10, &rows);
        assert_eq!(t, [10, 11, 12].into_iter().collect());
        assert!(descendants(99, &rows).is_empty());
    }

    #[test]
    fn terminate_ends_the_whole_tree_even_across_process_groups() {
        // zsh-style: the grandchild sits in its own process group (perl setsid-less `setpgrp`).
        let mut sh = Command::new("sh")
            .args(["-c", "perl -e 'setpgrp(0,0); exec \"sleep\",\"300\"' & sleep 300 & wait"])
            .spawn()
            .unwrap();
        let job = Job::assign(sh.id());
        let mut n = 0;
        for _ in 0..50 {
            n = job.usage().1;
            if n >= 3 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(n >= 3, "tree had {n} processes");
        job.terminate();
        let _ = sh.wait();
        assert_eq!(job.usage().1, 0);
    }
}
