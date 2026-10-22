// Shapes shared across the frontend: what session.json and the backend send, plus the
// in-memory Tab and Workspace. Types only, so any module can import it without side effects.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { type SearchAddon } from "@xterm/addon-search";

export type Status = "idle" | "running" | "attention" | "done";

export interface SavedTab {
  id: string;
  shell: string;
  ssh?: string | null;
  cwd?: string | null;
  title?: string | null;
  agentSession?: string | null;
}

interface SavedWorkspace {
  id: string;
  title?: string | null;
  color?: string | null;
  group?: string | null;
  tabs: SavedTab[];
  active?: string | null;
}

export interface Session {
  workspaces: SavedWorkspace[];
  active?: string | null;
}

export interface ShellInfo {
  id: string;
  name: string;
}

export interface AgentNotify {
  pane: string;
  event: string;
  message?: string;
  notificationType?: string | null;
  sessionId?: string | null;
}

// Mirrors git.rs. x/y are the staged/worktree letters of `git status --short` ('.' = unchanged).
export interface GitFile {
  path: string;
  orig?: string | null;
  x: string;
  y: string;
}

export interface GitStatus {
  root: string;
  branch?: string | null;
  oid?: string | null;
  upstream?: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  total: number;
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  when: string;
  unpushed: boolean;
}

export interface GitText {
  text: string;
  truncated: boolean;
  binary: boolean;
}

export interface LoadedConfig {
  config: any;
  error?: string | null;
  path: string;
}

/** One terminal: a horizontal tab inside a workspace. */
export interface Tab {
  id: string;
  wsId: string;
  shell: string;
  ssh?: string; // [user@]host[:port] when shell is "ssh"
  cwd?: string;
  branch?: string; // git branch of cwd (not persisted; re-read from .git/HEAD)
  repo?: string; // main checkout of cwd's repo, the same for all its worktrees (not persisted)
  worktree?: boolean; // cwd is in a linked worktree, not the main checkout (not persisted)
  branchAt?: number; // last refresh time, throttles the per-prompt lookup
  git?: GitStatus; // last `git status` of cwd's repo (not persisted)
  gitErr?: string; // why that status could not be read
  gitTimer?: number; // debounce of the next status read, armed only by events
  gitBusy?: boolean; // a status read is in flight
  gitAgain?: boolean; // another refresh was asked for while one was in flight
  gitStale?: boolean; // a refresh was skipped while the tab was out of sight
  customTitle?: string;
  progTitle?: string;
  term: Terminal;
  fit: FitAddon;
  serializer: SerializeAddon;
  webgl?: WebglAddon;
  search?: SearchAddon; // loaded the first time this tab is searched
  el: HTMLDivElement;
  opened: boolean; // xterm attached to the DOM (done lazily on first view)
  running: boolean; // a shell process is attached
  exited: boolean; // shell ended with an error; Enter restarts it
  dirty: boolean; // output since the last scrollback snapshot
  status: Status;
  note?: string;
  runStart?: number; // when the current agent turn started; kept through "attention" so the turn's total time is right
  runMs?: number; // how long the last finished turn took, shown next to "done"
  asking?: boolean; // the agent is waiting on a permission prompt or question inside its turn (whatever the badge shows)
  initialInput?: string; // typed into the shell once, right after it starts (worktree setup command)
  agentSession?: string; // id of the Claude Code session running here (persisted; dropped once Claude exits)
  agentLive?: boolean; // Claude Code is running in this tab right now (cleared at the next shell prompt)
  skipPrompt?: boolean; // an auto-resume was queued: the shell's first prompt is its startup one, not Claude exiting
  promptAt?: number; // time of the last prompt report, to merge duplicates
}

/** A sidebar entry (cmux's workspace) holding one or more tabs. */
export interface Workspace {
  id: string;
  customTitle?: string;
  color?: string;
  group?: string; // main checkout of the repo whose sidebar group this is in (see groups.ts)
  tabs: string[];
  activeTab?: string;
}
