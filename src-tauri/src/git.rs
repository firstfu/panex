use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

/// Branch name for the repo containing `cwd`, or a short hash when HEAD is detached.
/// Reads `.git/HEAD` directly (no git process); `.git` may be a file in worktrees/submodules.
#[tauri::command]
pub fn git_branch(cwd: String) -> Option<String> {
    let mut dir = Path::new(&cwd);
    loop {
        let dot_git = dir.join(".git");
        if dot_git.exists() {
            return read_head(&resolve_git_dir(&dot_git)?);
        }
        dir = dir.parent()?;
    }
}

fn resolve_git_dir(dot_git: &Path) -> Option<std::path::PathBuf> {
    if dot_git.is_dir() {
        return Some(dot_git.to_path_buf());
    }
    // "gitdir: <path>" pointer file.
    let text = fs::read_to_string(dot_git).ok()?;
    let target = text.trim().strip_prefix("gitdir:")?.trim();
    let p = Path::new(target);
    Some(if p.is_absolute() {
        p.to_path_buf()
    } else {
        dot_git.parent()?.join(p)
    })
}

fn read_head(git_dir: &Path) -> Option<String> {
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    match head.strip_prefix("ref: ") {
        Some(r) => Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_string()),
        None => Some(head.chars().take(7).collect()),
    }
}

#[derive(Serialize)]
pub struct Worktree {
    path: String,
    /// `copy_files` entries that were actually copied (missing or already-present ones are skipped).
    copied: Vec<String>,
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("cannot run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        // Drop git's progress chatter ("Preparing worktree ...") so only the actual error is shown.
        let err = String::from_utf8_lossy(&out.stderr)
            .lines()
            .filter(|l| !l.starts_with("Preparing worktree"))
            .collect::<Vec<_>>()
            .join("
")
            .trim()
            .to_string();
        Err(if err.is_empty() { format!("git {} failed", args.join(" ")) } else { err })
    }
}

/// Folder name for a branch: path separators and other awkward characters become `-`.
fn dir_name(branch: &str) -> String {
    branch
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect()
}

/// Creates a worktree for `branch` next to the repo (`<repo>-worktrees/<branch>`), then copies
/// `copy_files` (paths relative to the current worktree root, typically `.env`) into it.
/// Uses an existing branch as is; otherwise creates it from `base` (default HEAD).
#[tauri::command]
pub fn git_worktree_add(cwd: String, branch: String, base: Option<String>, copy_files: Vec<String>) -> Result<Worktree, String> {
    let cwd = Path::new(&cwd);
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch name is empty".into());
    }
    git(cwd, &["check-ref-format", "--branch", branch]).map_err(|_| format!("\"{branch}\" is not a valid branch name"))?;

    let top = PathBuf::from(git(cwd, &["rev-parse", "--show-toplevel"]).map_err(|_| "not inside a git repository".to_string())?);
    // The main checkout, even when `cwd` is itself a worktree: parent of the shared `.git` dir.
    let common = PathBuf::from(git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?);
    let root = match common.file_name() {
        Some(n) if n == ".git" => common.parent().map(Path::to_path_buf).unwrap_or_else(|| top.clone()),
        _ => top.clone(),
    };
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    let path = root
        .parent()
        .ok_or("repository has no parent folder")?
        .join(format!("{name}-worktrees"))
        .join(dir_name(branch));
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;

    let path_str = path.to_string_lossy().into_owned();
    let exists = git(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    if exists {
        git(cwd, &["worktree", "add", &path_str, branch])?;
    } else {
        let base = base.as_deref().map(str::trim).filter(|b| !b.is_empty()).unwrap_or("HEAD");
        git(cwd, &["worktree", "add", "-b", branch, &path_str, base])?;
    }

    let mut copied = Vec::new();
    for rel in copy_files {
        // Only plain relative paths inside the repo; anything else is ignored.
        let r = Path::new(&rel);
        if rel.is_empty() || !r.components().all(|c| matches!(c, Component::Normal(_))) {
            continue;
        }
        let (from, to) = (top.join(r), path.join(r));
        if !from.is_file() || to.exists() {
            continue;
        }
        if let Some(parent) = to.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::copy(&from, &to).is_ok() {
            copied.push(rel);
        }
    }
    Ok(Worktree { path: path_str, copied })
}

/// Local branch names of the repo containing `cwd`, most recently committed first.
#[tauri::command]
pub fn git_branches(cwd: String) -> Vec<String> {
    git(Path::new(&cwd), &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"])
        .map(|out| out.lines().map(str::to_string).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}
