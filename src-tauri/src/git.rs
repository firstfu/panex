use std::{fs, path::Path};

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
