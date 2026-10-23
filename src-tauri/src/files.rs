//! The Files panel's access to the project, read only: the list of files that make up the
//! project (what git tracks plus untracked files it doesn't ignore, or a capped folder walk
//! outside git) and reading one file. Nothing outside the project folder is ever read.

use crate::git::git_capped;
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_FILES: usize = 20_000;
const MAX_LIST_BYTES: usize = 4 << 20;
const MAX_DEPTH: usize = 8;
/// Directory entries looked at by the walk outside git, so a huge folder can't stall it.
const MAX_ENTRIES: usize = 50_000;
const MAX_FILE_BYTES: u64 = 1 << 20;
/// Skipped by the walk outside git (inside git, .gitignore decides).
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "__pycache__"];

#[derive(Serialize, Debug)]
pub struct Tree {
    /// Relative to the root, always with `/`, files only (folders follow from the paths).
    files: Vec<String>,
    /// More than MAX_FILES; the rest is left out.
    truncated: bool,
}

#[derive(Serialize)]
pub struct FileText {
    text: String,
    truncated: bool,
    /// Has a NUL byte near the start; `text` is empty.
    binary: bool,
}

/// The project's files. In a repo root: `git ls-files` (tracked, plus untracked that aren't
/// ignored), minus files deleted from the working tree. Elsewhere: a folder walk that skips
/// hidden and build folders and does not follow symlinked folders.
pub fn tree_at(root: &Path) -> Result<Tree, String> {
    if !root.is_dir() {
        return Err(format!("not a folder: {}", root.display()));
    }
    let mut files = Vec::new();
    let mut truncated = false;
    if root.join(".git").exists() {
        let (out, cut) = git_capped(root, &["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate"], MAX_LIST_BYTES)?;
        truncated = cut;
        for line in out.lines() {
            // core.quotepath=off leaves only names with control characters or quotes quoted; skip those.
            if line.is_empty() || line.starts_with('"') {
                continue;
            }
            if files.len() >= MAX_FILES {
                truncated = true;
                break;
            }
            // --cached still lists files deleted but not staged; they aren't there to open.
            if fs::symlink_metadata(root.join(line)).is_ok() {
                files.push(line.to_string());
            }
        }
    } else {
        let mut seen = 0usize;
        walk(root, "", 0, &mut files, &mut seen, &mut truncated);
    }
    Ok(Tree { files, truncated })
}

/// `rel` is `dir` relative to the root ("" for the root itself).
fn walk(dir: &Path, rel: &str, depth: usize, out: &mut Vec<String>, seen: &mut usize, truncated: &mut bool) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        *seen += 1;
        if out.len() >= MAX_FILES || *seen > MAX_ENTRIES {
            *truncated = true;
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        // DirEntry::file_type does not follow symlinks.
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if depth < MAX_DEPTH && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                subdirs.push((entry.path(), path));
            }
        } else if name != ".DS_Store" {
            out.push(path);
        }
    }
    for (p, r) in subdirs {
        walk(&p, &r, depth + 1, out, seen, truncated);
    }
}

/// Reads one file of the project, at most MAX_FILE_BYTES. Refuses a path that resolves
/// (through `..` or a symlink) to outside `root`.
pub fn read_at(root: &Path, path: &str) -> Result<FileText, String> {
    let rel = Path::new(path);
    if path.is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("invalid path: {path}"));
    }
    let base = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let full: PathBuf = fs::canonicalize(base.join(rel)).map_err(|e| e.to_string())?;
    if !full.starts_with(&base) || !full.is_file() {
        return Err(format!("invalid path: {path}"));
    }
    let mut buf = Vec::new();
    fs::File::open(&full)
        .map_err(|e| e.to_string())?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    // Same test git uses for "binary": a NUL in the first 8000 bytes.
    if buf.iter().take(8000).any(|&b| b == 0) {
        return Ok(FileText { text: String::new(), truncated: false, binary: true });
    }
    let truncated = buf.len() as u64 > MAX_FILE_BYTES;
    buf.truncate(MAX_FILE_BYTES as usize);
    Ok(FileText { text: String::from_utf8_lossy(&buf).into_owned(), truncated, binary: false })
}

/// The project's files; `root` is the repo root (or the tab's folder outside git).
#[tauri::command]
pub async fn project_tree(root: String) -> Result<Tree, String> {
    tauri::async_runtime::spawn_blocking(move || tree_at(Path::new(&root))).await.map_err(|e| e.to_string())?
}

/// One file, `path` relative to `root` as `project_tree` gave it.
#[tauri::command]
pub async fn file_read(root: String, path: String) -> Result<FileText, String> {
    tauri::async_runtime::spawn_blocking(move || read_at(Path::new(&root), &path)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("panex-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn sorted(t: Tree) -> Vec<String> {
        let mut f = t.files;
        f.sort();
        f
    }

    #[test]
    fn repo_tree_follows_gitignore() {
        let root = scratch("repo");
        let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&root).output().unwrap().status.success());
        git(&["init", "-q"]);
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("gone.txt"), "x").unwrap();
        fs::write(root.join("target/out.bin"), "x").unwrap();
        git(&["add", "."]);
        fs::remove_file(root.join("gone.txt")).unwrap();
        fs::write(root.join("new.md"), "untracked").unwrap();
        assert_eq!(sorted(tree_at(&root).unwrap()), [".gitignore", "new.md", "src/main.rs"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_outside_git_skips_build_folders() {
        let root = scratch("walk");
        fs::create_dir_all(root.join("a/node_modules")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("a/x.ts"), "x").unwrap();
        fs::write(root.join("a/node_modules/y.js"), "y").unwrap();
        fs::write(root.join(".hidden/z"), "z").unwrap();
        fs::write(root.join(".env"), "e").unwrap();
        assert_eq!(sorted(tree_at(&root).unwrap()), [".env", "a/x.ts"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_stays_inside_root() {
        let root = scratch("read");
        let outside = scratch("outside");
        fs::write(root.join("a.rs"), "hello").unwrap();
        fs::write(root.join("b.bin"), [1u8, 0, 2]).unwrap();
        fs::write(outside.join("secret"), "no").unwrap();
        assert_eq!(read_at(&root, "a.rs").unwrap().text, "hello");
        assert!(read_at(&root, "b.bin").unwrap().binary);
        assert!(read_at(&root, "../panex-files-outside-0/secret").is_err());
        assert!(read_at(&root, "/etc/passwd").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("secret"), root.join("link")).unwrap();
            assert!(read_at(&root, "link").is_err());
        }
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}
