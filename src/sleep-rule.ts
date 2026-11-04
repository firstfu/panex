// Pure rules of memory-pressure hibernation (no DOM, no Tauri, so tests can load them): when
// memory counts as short, and which tab goes first.

/** A tab must have been left alone this long: a turn that only just ended may continue. */
export const IDLE_MS = 5 * 60_000;
/** After the backend refuses a tab (phone connected, background work), leave it alone this long. */
export const REFUSED_MS = 60_000;

/**
 * Memory is short when panex's tabs use half the machine's physical memory, or when less than a
 * tenth of it is left for anyone. These decide when to look for a tab that can go; they never cap
 * what the user can run.
 */
export function underPressure(tabsBytes: number, mem: { total: number; available: number }) {
  if (!(mem.total > 0)) return false;
  return tabsBytes >= mem.total * 0.5 || mem.available < mem.total * 0.1;
}

/** What the rule needs to know about a tab. */
export interface SleepInfo {
  visible: boolean;
  running: boolean;
  hibernated?: boolean;
  ssh?: boolean;
  waking?: boolean;
  agentLive?: boolean;
  agentSession?: string;
  agentRemote?: boolean; // the last hook said Remote Control is connected
  agentBackground?: boolean; // the last Stop hook listed background tasks or scheduled prompts
  status: string;
  asking?: boolean;
  typedAt?: number; // the user's last keystroke in this tab
  outAt?: number; // the shell's last output
  seenAt?: number; // when the user last looked at this tab
  refusedAt?: number; // when the backend last refused it
}

/**
 * Whether the tab is worth asking the backend about. Only a hidden, quiet tab whose Claude Code
 * has finished its turn: not working, not asking, nothing typed since. The backend then checks
 * what only it can see.
 */
export function sleepable(t: SleepInfo, now: number) {
  return (
    !t.visible &&
    t.running &&
    !t.hibernated &&
    !t.waking &&
    !t.ssh &&
    !!t.agentLive &&
    !!t.agentSession &&
    !t.agentRemote &&
    !t.agentBackground &&
    t.status !== "running" &&
    !t.asking &&
    now - (t.outAt ?? 0) >= IDLE_MS &&
    now - (t.typedAt ?? 0) >= IDLE_MS &&
    now - (t.refusedAt ?? -Infinity) >= REFUSED_MS
  );
}

/** Tabs that may go, longest unused first. */
export function sleepOrder<T extends SleepInfo>(list: T[], now: number): T[] {
  const lastUsed = (t: T) => Math.max(t.seenAt ?? 0, t.typedAt ?? 0);
  return list.filter((t) => sleepable(t, now)).sort((a, b) => lastUsed(a) - lastUsed(b));
}

/**
 * Whether what xterm is sending is its answer to the program rather than the user typing: cursor
 * position and device reports, focus and mouse reports, OSC and DCS answers. While a tab wakes
 * these must get through (ConPTY waits for the cursor answer), and keys must wait for Claude Code.
 */
export function isTerminalReply(data: string) {
  return /^\x1b\[(\??[\d;]*[Rnc]|[IO]|<[\d;]*[Mm]|M[\s\S]{3})$|^\x1b[\]P_][\s\S]*(\x07|\x1b\\)$/.test(data);
}
