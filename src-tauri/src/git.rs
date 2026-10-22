//! Git for the UI, read only (plus `git worktree add` / `remove`). The branch is read straight from
//! `.git/HEAD`; status, diffs and the log run git with `--no-optional-locks` so they never take
//! the index lock an agent may need, with capped output, off the main thread.

use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Serialize, Debug)]
pub struct GitHead {
    /// Branch name, or a short hash when HEAD is detached.
    branch: String,
    /// The main checkout this folder belongs to: itself, or for a linked worktree the repo it
    /// was added from. The sidebar groups workspaces by it.
    repo: String,
    /// A linked worktree (`git worktree add`) rather than the main checkout.
    worktree: bool,
}

/// Branch of the repo containing `cwd`, and which repo that is. Reads `.git/HEAD` directly (no
/// git process); `.git` may be a file in worktrees/submodules.
#[tauri::command]
pub fn git_branch(cwd: String) -> Option<GitHead> {
    let root = repo_root(Path::new(&cwd))?;
    let git_dir = resolve_git_dir(&root.join(".git"))?;
    let branch = read_head(&git_dir)?;
    // A linked worktree's git dir is `<main>/.git/worktrees/<name>`, whose `commondir` file
    // points back at `<main>/.git`. Submodules have a pointer file too, but no commondir.
    let common = fs::read_to_string(git_dir.join("commondir")).ok().map(|c| normalize(&git_dir.join(c.trim())));
    let (repo, worktree) = match common {
        Some(c) => (main_checkout(&c).unwrap_or(c), true),
        None => (root, false),
    };
    Some(GitHead { branch, repo: normalize(&repo).to_string_lossy().into_owned(), worktree })
}

/// `<main>` for a shared git dir `<main>/.git`; None for a bare repo.
fn main_checkout(common: &Path) -> Option<PathBuf> {
    (common.file_name()? == ".git").then(|| common.parent().map(Path::to_path_buf)).flatten()
}

/// Resolves `.` and `..` without touching the disk (canonicalize would add `\\?\` on Windows)
/// and uses the platform's separators, so the same folder always gives the same string.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

/// Nearest folder at or above `cwd` that has a `.git` (directory or worktree pointer file).
fn repo_root(cwd: &Path) -> Option<PathBuf> {
    let mut dir = cwd;
    loop {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
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
    /// The main checkout, as `git_branch` reports it.
    repo: String,
    /// `copy_files` entries that were actually copied (missing or already-present ones are skipped).
    copied: Vec<String>,
}

fn git_cmd(cwd: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = git_cmd(cwd, args);
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
/// With `reuse`, a worktree already at that path is returned as is instead of being an error
/// (Claude Code asks for the same name again when it resumes a session in that worktree).
#[tauri::command]
pub fn git_worktree_add(cwd: String, branch: String, base: Option<String>, copy_files: Vec<String>, reuse: Option<bool>) -> Result<Worktree, String> {
    let cwd = Path::new(&cwd);
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch name is empty".into());
    }
    git(cwd, &["check-ref-format", "--branch", branch]).map_err(|_| format!("\"{branch}\" is not a valid branch name"))?;

    let top = PathBuf::from(git(cwd, &["rev-parse", "--show-toplevel"]).map_err(|_| "not inside a git repository".to_string())?);
    // The main checkout, even when `cwd` is itself a worktree: parent of the shared `.git` dir.
    let common = PathBuf::from(git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?);
    let root = main_checkout(&normalize(&common)).unwrap_or_else(|| top.clone());
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    let path = root
        .parent()
        .ok_or("repository has no parent folder")?
        .join(format!("{name}-worktrees"))
        .join(dir_name(branch));
    if path.exists() {
        if reuse == Some(true) && path.join(".git").exists() {
            let path = path.to_string_lossy().into_owned();
            return Ok(Worktree { path, repo: normalize(&root).to_string_lossy().into_owned(), copied: vec![] });
        }
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
    Ok(Worktree { path: path_str, repo: normalize(&root).to_string_lossy().into_owned(), copied })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// `cwd` 所在 linked worktree 的最上層資料夾。
    path: String,
    /// 它的主 checkout。
    repo: String,
    /// 簽出的分支；HEAD 是 detached 時為 None。
    branch: Option<String>,
    /// 已修改、已暫存與未追蹤的檔案數（`git status --porcelain` 的行數）。
    changes: usize,
    /// 從 HEAD 走得到、但其他分支與遠端分支都走不到的 commit 數：連分支一起刪就找不回來。
    unique: u32,
}

/// 刪掉 `cwd` 所在的 worktree 會失去什麼，給確認對話框用。
/// 錯誤：`cwd` 不存在（固定回 `"missing"`）、在主 checkout 裡（主 checkout 永遠不刪）或不在 repo 裡。
#[tauri::command]
pub async fn git_worktree_info(cwd: String) -> Result<WorktreeInfo, String> {
    blocking(move || worktree_info(Path::new(&cwd))).await?
}

fn worktree_info(cwd: &Path) -> Result<WorktreeInfo, String> {
    // 固定字串，前端靠它分辨「資料夾已經被刪了」，改成只提供關閉工作區。
    if !cwd.exists() {
        return Err("missing".into());
    }
    let top = PathBuf::from(git(cwd, &["rev-parse", "--show-toplevel"]).map_err(|_| "not inside a git repository".to_string())?);
    let common = PathBuf::from(git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?);
    let repo = main_checkout(&normalize(&common)).ok_or("the repository has no main checkout")?;
    if normalize(&top) == normalize(&repo) {
        return Err("this is the main checkout, not a worktree".into());
    }
    let branch = git(&top, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|b| !b.is_empty());
    let (status, _) = git_capped(&top, &["status", "--porcelain"], MAX_STATUS_BYTES)?;
    // `--exclude` 只作用在緊接的 `--branches`，而且要寫不含 refs/heads/ 的名字：除了這個分支以外的所有分支
    // （分支名不能含 glob 字元，不必跳脫）。
    let exclude = branch.as_ref().map(|b| format!("--exclude={b}"));
    let mut args = vec!["rev-list", "--count", "HEAD", "--not"];
    args.extend(exclude.as_deref());
    args.extend(["--branches", "--remotes"]);
    let unique = git(&top, &args)?.parse().unwrap_or(0);
    Ok(WorktreeInfo {
        path: top.to_string_lossy().into_owned(),
        repo: normalize(&repo).to_string_lossy().into_owned(),
        branch,
        changes: status.lines().filter(|l| !l.is_empty()).count(),
        unique,
    })
}

/// 用 `git worktree remove` 刪掉 `path` 的 linked worktree（`force` 連未 commit 的變更一起丟掉），
/// 有給 `branch` 就接著刪分支，`<repo>-worktrees` 空了也一併刪。
/// 錯誤：主 checkout、不是 worktree、有變更卻沒 `force`；刪分支失敗時 worktree 已經刪掉，訊息會說明。
#[tauri::command]
pub async fn git_worktree_remove(path: String, force: bool, branch: Option<String>) -> Result<(), String> {
    blocking(move || worktree_remove(Path::new(&path), force, branch.as_deref())).await?
}

fn worktree_remove(path: &Path, force: bool, branch: Option<&str>) -> Result<(), String> {
    let info = worktree_info(path)?;
    let (top, repo) = (PathBuf::from(&info.path), PathBuf::from(&info.repo));
    let top_str = info.path.as_str();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(top_str);
    // 從主 checkout 執行：git 不刪自己正在裡面的 worktree。剛關掉的 shell 可能還沒結束
    // （Windows 會鎖住程序的 cwd），所以失敗時重試幾次。
    let mut last = Ok(String::new());
    for attempt in 0..4 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        last = git(&repo, &args);
        if last.is_ok() || !top.exists() {
            break;
        }
        // git 先刪了 `.git` 檔才卡在被鎖的檔案：對 git 來說已經不是 worktree，改成自己刪完
        // （只在使用者已同意丟掉裡面東西時）。
        if force && !top.join(".git").exists() {
            last = fs::remove_dir_all(&top).map(|_| String::new()).map_err(|e| e.to_string());
            let _ = git(&repo, &["worktree", "prune"]);
            if last.is_ok() {
                break;
            }
        }
    }
    last?;
    if let Some(b) = branch.filter(|b| !b.is_empty()) {
        git(&repo, &["branch", "-D", b]).map_err(|e| format!("the worktree is removed, but not the branch {b}: {e}"))?;
    }
    // 只有空資料夾刪得掉，裡面其他 worktree 不受影響。
    if let Some(parent) = top.parent().filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().ends_with("-worktrees"))) {
        let _ = fs::remove_dir(parent);
    }
    Ok(())
}

/// 從 `paths`（側欄裡 worktree 分頁的 cwd）挑出「所在的 worktree 已經被刪掉」的那些，讓前端收掉側欄的工作區。
/// panex 外刪的（`git worktree remove`、`rm -rf`）收不到任何通知，只能在焦點回來或提示字元出現時問一次。
/// 只讀檔案系統、不開 git 程序，所以頻繁呼叫也便宜。
/// @param paths 要檢查的資料夾
/// @returns 其中已不在任何 linked worktree 裡的資料夾
#[tauri::command]
pub fn worktrees_gone(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| worktree_gone(Path::new(p))).collect()
}

fn worktree_gone(path: &Path) -> bool {
    if path.exists() {
        return false;
    }
    // 資料夾不在了，但最近一層還在的上層仍屬於某個 linked worktree：只是刪了子資料夾，worktree 還在。
    // `.claude/worktrees/<name>` 在主 checkout 底下，上層會落到主 checkout（不是 worktree），照樣算刪掉。
    let Some(alive) = path.ancestors().find(|d| d.is_dir()) else { return true };
    !git_branch(alive.to_string_lossy().into()).is_some_and(|h| h.worktree)
}

/// Local branch names of the repo containing `cwd`, most recently committed first.
#[tauri::command]
pub fn git_branches(cwd: String) -> Vec<String> {
    git(Path::new(&cwd), &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"])
        .map(|out| out.lines().map(str::to_string).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

// ── Git panel (read only) ────────────────────────────────────────────────────
// Every call is one short git process on a blocking thread, run only when the frontend asks
// (prompt, agent Stop, panel open); nothing watches the repo. `--no-optional-locks` keeps
// `status` from taking index.lock, so it never collides with an agent's own git commands.

// core.safecrlf=false: no "LF will be replaced by CRLF" warning per file under core.autocrlf.
const READ_ONLY: [&str; 7] = ["--no-optional-locks", "-c", "core.quotepath=off", "-c", "color.ui=never", "-c", "core.safecrlf=false"];
const MAX_FILES: usize = 500;
const MAX_STATUS_BYTES: usize = 4 << 20;
const MAX_DIFF_BYTES: usize = 1 << 20;

/// Runs a read-only git command and keeps at most `limit` bytes of its output (cut at a line
/// end); a longer output kills git instead of buffering all of it. Returns (text, truncated).
fn git_capped(root: &Path, args: &[&str], limit: usize) -> Result<(String, bool), String> {
    let all: Vec<&str> = READ_ONLY.iter().chain(args).copied().collect();
    let mut child = git_cmd(root, &all)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run git: {e}"))?;
    // Drain stderr alongside: a git blocked on a full stderr pipe would never close stdout.
    let mut stderr = child.stderr.take().ok_or("no git error output")?;
    let err_reader = std::thread::spawn(move || {
        let mut e = Vec::new();
        let _ = stderr.read_to_end(&mut e);
        e
    });
    let mut buf = Vec::new();
    child
        .stdout
        .take()
        .ok_or("no git output")?
        .take(limit as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() > limit {
        let _ = child.kill();
        let _ = child.wait();
        buf.truncate(limit);
        if let Some(nl) = buf.iter().rposition(|&b| b == b'\n') {
            buf.truncate(nl + 1);
        }
        return Ok((String::from_utf8_lossy(&buf).into_owned(), true));
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let err = err_reader.join().unwrap_or_default();
    if !status.success() {
        let err = String::from_utf8_lossy(&err).trim().to_string();
        return Err(if err.is_empty() { format!("git {} failed", args.join(" ")) } else { err });
    }
    Ok((String::from_utf8_lossy(&buf).into_owned(), false))
}

/// The panel's commands get the root back from `git_status`; accept only an actual repo root.
fn checked_root(root: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(root);
    if p.join(".git").exists() {
        Ok(p)
    } else {
        Err("not a git repository".into())
    }
}

/// A repo-relative path as git prints it; anything absolute or with `..` is refused.
fn checked_rel(path: &str) -> Result<&str, String> {
    let p = path.trim_end_matches('/');
    if !p.is_empty() && Path::new(p).components().all(|c| matches!(c, Component::Normal(_))) {
        Ok(p)
    } else {
        Err(format!("invalid path: {path}"))
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct GitFile {
    path: String,
    /// Old path of a rename or copy.
    orig: Option<String>,
    /// Staged (index) and worktree state, as in `git status --short`: '.', M, A, D, R, C, U, '?'.
    x: char,
    y: char,
}

#[derive(Serialize)]
pub struct GitStatus {
    root: String,
    branch: Option<String>,
    /// HEAD commit; the panel reloads its commit list only when this changes.
    oid: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    /// At most MAX_FILES entries; `total` is the real count.
    files: Vec<GitFile>,
    total: usize,
}

/// Branch, ahead/behind (as of the last fetch; panex never fetches) and changed files of the
/// repo containing `cwd`. None when `cwd` is not in a repo, decided without starting git.
#[tauri::command]
pub async fn git_status(cwd: String) -> Result<Option<GitStatus>, String> {
    let Some(root) = repo_root(Path::new(&cwd)) else { return Ok(None) };
    blocking(move || status_of(root)).await?.map(Some)
}

fn status_of(root: PathBuf) -> Result<GitStatus, String> {
    let (out, _) = git_capped(&root, &["status", "--porcelain=v2", "--branch", "-z"], MAX_STATUS_BYTES)?;
    let mut st = GitStatus {
        root: root.to_string_lossy().into_owned(),
        branch: None,
        oid: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
        total: 0,
    };
    let push = |st: &mut GitStatus, xy: &str, path: &str, orig: Option<&str>| {
        st.total += 1;
        if st.files.len() < MAX_FILES {
            let mut c = xy.chars();
            st.files.push(GitFile {
                path: path.to_string(),
                orig: orig.map(str::to_string),
                x: c.next().unwrap_or('.'),
                y: c.next().unwrap_or('.'),
            });
        }
    };
    // -z: records end with NUL; a rename/copy record is followed by one more field, its old path.
    let mut recs = out.split('\0');
    while let Some(rec) = recs.next() {
        if let Some(h) = rec.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.oid ") {
                st.oid = (v != "(initial)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.head ") {
                st.branch = (v != "(detached)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                let mut it = v.split(' ').map(|n| n.trim_start_matches(['+', '-']).parse().unwrap_or(0));
                st.ahead = it.next().unwrap_or(0);
                st.behind = it.next().unwrap_or(0);
            }
            continue;
        }
        let f: Vec<&str> = match rec.as_bytes().first() {
            Some(b'1') => rec.splitn(9, ' ').collect(),
            Some(b'2') => rec.splitn(10, ' ').collect(),
            Some(b'u') => rec.splitn(11, ' ').collect(),
            Some(b'?') => {
                push(&mut st, "??", &rec[2..], None);
                continue;
            }
            _ => continue,
        };
        let (Some(xy), Some(path)) = (f.get(1), f.last()) else { continue };
        let orig = if rec.starts_with('2') { recs.next() } else { None };
        push(&mut st, xy, path, orig);
    }
    if st.branch.is_none() {
        st.branch = st.oid.as_ref().map(|o| o.chars().take(7).collect());
    }
    Ok(st)
}

#[derive(Serialize)]
pub struct GitText {
    text: String,
    truncated: bool,
    binary: bool,
}

/// One file's diff: staged (index vs HEAD) or unstaged (worktree vs index). An untracked file
/// has no diff, so its content comes back as is and the panel shows it all as added.
#[tauri::command]
pub async fn git_diff(root: String, path: String, orig: Option<String>, staged: bool, untracked: bool) -> Result<GitText, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let path = checked_rel(&path)?.to_string();
        if untracked {
            return read_untracked(&root.join(&path));
        }
        let orig = orig.as_deref().map(checked_rel).transpose()?.map(str::to_string);
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "-M"];
        if staged {
            args.push("--cached");
        }
        args.push("--");
        if let Some(o) = &orig {
            args.push(o);
        }
        args.push(&path);
        let (text, truncated) = git_capped(&root, &args, MAX_DIFF_BYTES)?;
        let binary = text.lines().any(|l| l.starts_with("Binary files "));
        Ok(GitText { text, truncated, binary })
    })
    .await?
}

fn read_untracked(file: &Path) -> Result<GitText, String> {
    if file.is_dir() {
        return Ok(GitText { text: String::new(), truncated: false, binary: false });
    }
    let mut buf = Vec::new();
    fs::File::open(file)
        .and_then(|f| f.take(MAX_DIFF_BYTES as u64 + 1).read_to_end(&mut buf))
        .map_err(|e| e.to_string())?;
    // git's own test: a NUL in the first 8000 bytes means binary.
    if buf.iter().take(8000).any(|&b| b == 0) {
        return Ok(GitText { text: String::new(), truncated: false, binary: true });
    }
    let truncated = buf.len() > MAX_DIFF_BYTES;
    buf.truncate(MAX_DIFF_BYTES);
    Ok(GitText { text: String::from_utf8_lossy(&buf).into_owned(), truncated, binary: false })
}

#[derive(Serialize)]
pub struct GitCommit {
    hash: String,
    subject: String,
    author: String,
    /// "3 hours ago", in git's words.
    when: String,
    /// Not on the upstream yet.
    unpushed: bool,
}

/// The latest commits on HEAD, marking those the upstream doesn't have.
#[tauri::command]
pub async fn git_log(root: String, count: u32) -> Result<Vec<GitCommit>, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let n = format!("-n{}", count.clamp(1, 200));
        let (out, _) = git_capped(&root, &["log", &n, "--format=%H%x1f%s%x1f%an%x1f%ar%x1e"], MAX_STATUS_BYTES)?;
        // No upstream (or nothing ahead) fails or prints nothing: then no commit is marked.
        let ahead: HashSet<String> = git_capped(&root, &["rev-list", "-n200", "@{upstream}..HEAD"], 64 << 10)
            .map(|(o, _)| o.lines().map(str::to_string).collect())
            .unwrap_or_default();
        Ok(out
            .split('\x1e')
            .filter_map(|rec| {
                let mut f = rec.trim_start_matches('\n').split('\x1f');
                let hash = f.next().filter(|h| !h.is_empty())?.to_string();
                Some(GitCommit {
                    unpushed: ahead.contains(&hash),
                    hash,
                    subject: f.next()?.to_string(),
                    author: f.next()?.to_string(),
                    when: f.next()?.to_string(),
                })
            })
            .collect())
    })
    .await?
}

/// One commit: header, file stats and patch.
#[tauri::command]
pub async fn git_show(root: String, hash: String) -> Result<GitText, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        if !(4..=64).contains(&hash.len()) || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("invalid commit: {hash}"));
        }
        let (text, truncated) = git_capped(
            &root,
            &["show", "--no-ext-diff", "--no-textconv", "--stat", "--patch", "--format=fuller", &hash],
            MAX_DIFF_BYTES,
        )?;
        Ok(GitText { text, truncated, binary: false })
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_resolves_dots() {
        let p = normalize(Path::new("a/b/./../c"));
        assert_eq!(p, Path::new("a").join("c"));
    }

    #[test]
    fn worktree_reports_its_main_checkout() {
        // Real path: on macOS the temp dir is under /var, a link to /private/var that git resolves.
        let base = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("panex-git-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let main = base.join("repo");
        fs::create_dir_all(&main).unwrap();
        let run = |args: &[&str]| git(&main, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
        let wt = git_worktree_add(main.to_string_lossy().into(), "feat/a".into(), None, vec![], None).unwrap();
        fs::create_dir_all(Path::new(&wt.path).join("sub")).unwrap();

        let m = git_branch(main.to_string_lossy().into()).unwrap();
        assert_eq!((m.branch.as_str(), m.worktree), ("main", false));
        let w = git_branch(Path::new(&wt.path).join("sub").to_string_lossy().into()).unwrap();
        assert_eq!((w.branch.as_str(), w.worktree), ("feat/a", true));
        assert_eq!(w.repo, m.repo);
        assert_eq!(wt.repo, m.repo);
        // Asked again for the same name: an error, unless reusing (Claude resuming in that worktree).
        assert!(git_worktree_add(main.to_string_lossy().into(), "feat/a".into(), None, vec![], None).is_err());
        let again = git_worktree_add(main.to_string_lossy().into(), "feat/a".into(), None, vec![], Some(true)).unwrap();
        assert_eq!(again.path, wt.path);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn worktree_gone_only_when_the_worktree_is() {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("panex-git-gone-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let main = base.join("repo");
        fs::create_dir_all(&main).unwrap();
        let run = |args: &[&str]| git(&main, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
        let wt = PathBuf::from(git_worktree_add(main.to_string_lossy().into(), "g".into(), None, vec![], None).unwrap().path);
        let s = |p: &Path| p.to_string_lossy().into_owned();
        // 還在、或只是 worktree 裡的子資料夾被刪：不算。
        assert!(worktrees_gone(vec![s(&wt), s(&wt.join("deleted-sub"))]).is_empty());
        run(&["worktree", "remove", &s(&wt)]);
        assert_eq!(worktrees_gone(vec![s(&wt), s(&wt.join("sub"))]), vec![s(&wt), s(&wt.join("sub"))]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn worktree_info_and_remove() {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("panex-git-rm-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let main = base.join("repo");
        fs::create_dir_all(&main).unwrap();
        let run = |dir: &Path, args: &[&str]| git(dir, args).unwrap();
        run(&main, &["init", "-q", "-b", "main"]);
        run(&main, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
        assert!(worktree_info(&main).is_err(), "the main checkout is never offered for removal");

        let wt = PathBuf::from(git_worktree_add(main.to_string_lossy().into(), "feat/b".into(), None, vec![], None).unwrap().path);
        let i = worktree_info(&wt).unwrap();
        assert_eq!((i.branch.as_deref(), i.changes, i.unique), (Some("feat/b"), 0, 0));
        assert_eq!(i.repo, main.to_string_lossy());

        fs::write(wt.join("new.txt"), "x").unwrap();
        run(&wt, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "only here"]);
        let i = worktree_info(&wt).unwrap();
        assert_eq!((i.changes, i.unique), (1, 1), "an untracked file, a commit on no other branch");

        assert!(worktree_remove(&wt, false, None).is_err(), "uncommitted work: refused without force");
        assert!(wt.exists());
        worktree_remove(&wt, true, Some("feat/b")).unwrap();
        assert!(!wt.exists());
        assert!(!base.join("repo-worktrees").exists(), "the empty -worktrees folder goes too");
        assert!(git(&main, &["rev-parse", "--verify", "--quiet", "refs/heads/feat/b"]).is_err(), "branch deleted");
        assert_eq!(git(&main, &["worktree", "list", "--porcelain"]).unwrap().matches("worktree ").count(), 1);
        let _ = fs::remove_dir_all(&base);
    }
}
