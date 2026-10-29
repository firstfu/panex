// Pure helpers for `panex-cli list` / `wake` / `send` and the tab overview (no DOM, no Tauri, so
// tests can load them): finding the tabs a name means, making text safe to type into Claude Code,
// and which overview group a tab is in.

/** Overview groups, in the order they are shown: what needs the user first. */
export const GROUPS = ["needs", "running", "done", "idle", "asleep", "stopped"] as const;
export type Group = (typeof GROUPS)[number];

/**
 * The overview group of a tab: asleep (hibernated) and stopped (no shell: never opened since
 * launch, or ended) come before the agent's state, since a tab without a shell has none.
 */
export function groupOf(t: { status: string; asking?: boolean; hibernated?: boolean; running: boolean }): Group {
  if (t.hibernated) return "asleep";
  if (!t.running) return "stopped";
  if (t.asking || t.status === "attention") return "needs";
  if (t.status === "running") return "running";
  return t.status === "done" ? "done" : "idle";
}

/** What the matcher needs to know about a tab. */
export interface TargetInfo {
  id: string;
  workspace: string; // workspace title as the sidebar shows it
  title: string; // tab title as the tab bar shows it
  folder: string; // last part of the tab's cwd, "" without one
}

/**
 * The tabs `target` names. An exact tab id wins; then, ignoring case, tabs whose workspace,
 * tab title or folder equals it; only when nothing equals it, tabs where one of them contains it.
 * A workspace name brings all of that workspace's tabs.
 */
export function matchTargets<T extends TargetInfo>(list: T[], target: string): T[] {
  const byId = list.filter((t) => t.id === target);
  if (byId.length) return byId;
  const q = target.trim().toLowerCase();
  if (!q) return [];
  const names = (t: T) => [t.workspace, t.title, t.folder].map((s) => s.toLowerCase());
  const exact = list.filter((t) => names(t).includes(q));
  if (exact.length) return exact;
  return list.filter((t) => names(t).some((n) => n.includes(q)));
}

/**
 * Text for Claude Code's prompt: line breaks become \n and tabs stay; every other control
 * character goes, ESC above all. One would end a bracketed paste early and type the rest as
 * keys, and Ctrl+C could stop Claude and drop the rest of the text into the shell.
 */
export function cleanText(text: string) {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
}
