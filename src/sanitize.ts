// Pure checks and text fixes, kept free of DOM/Tauri imports so `npm test` can load them in Node.

/** Mirrors ssh.rs `valid_target`: the target lands on ssh's command line. */
export const validSshTarget = (t: string) => /^[A-Za-z0-9@._:\[\]%-]{1,255}$/.test(t) && !t.startsWith("-");

/**
 * The id ends up typed into a shell after `claude --resume`, so accept only what a Claude Code
 * session id looks like; a leading "-" would turn it into another option.
 */
export function validSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/.test(id);
}

/**
 * A TUI (Claude Code) pads its screen with blank rows to park the input box at the bottom. Those rows
 * only make sense while it runs; replayed as history they become a big gap, so cap blank runs at 2.
 */
export const squeezeBlankRuns = (snapshot: string) => snapshot.replace(/(?:[ \t]*\r?\n){4,}/g, "\n\n\n");
