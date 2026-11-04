// The command that brings a Claude Code session back with the flags it was started with. Pure (no
// DOM, no Tauri) so tests can load it. Only known flags survive: anything else on the original
// command line may be a prompt, and typing that again would send it to Claude a second time.

type Arity = 0 | 1 | "optional" | "many";

// `--model` is left out on purpose: `--resume` restores the session's model, including a later
// /model, which the original flag would override. So are flags that pick or create a session
// (--continue, --session-id, --fork-session, --worktree, --from-pr, --teleport).
const KEEP: Record<string, Arity> = {
  "--allow-dangerously-skip-permissions": 0,
  "--ax-screen-reader": 0,
  "--bare": 0,
  "--brief": 0,
  "--chrome": 0,
  "--dangerously-skip-permissions": 0,
  "--disable-slash-commands": 0,
  "--exclude-dynamic-system-prompt-sections": 0,
  "--ide": 0,
  "--no-chrome": 0,
  "--restricted": 0,
  "--safe-mode": 0,
  "--strict-mcp-config": 0,
  "--verbose": 0,
  "--agent": 1,
  "--agents": 1,
  "--append-system-prompt": 1,
  "--append-system-prompt-file": 1,
  "--autocompact": 1,
  "--debug-file": 1,
  "--effort": 1,
  "--fallback-model": 1,
  "--permission-mode": 1,
  "--plugin-dir": 1,
  "--plugin-url": 1,
  "--remote-control-session-name-prefix": 1,
  "--setting-sources": 1,
  "--settings": 1,
  "--system-prompt": 1,
  "--system-prompt-file": 1,
  "--system-prompt-snapshot": 1,
  "--debug": "optional",
  "--prompt-suggestions": "optional",
  "--remote-control": "optional",
  "--add-dir": "many",
  "--allowed-tools": "many",
  "--allowedTools": "many",
  "--betas": "many",
  "--disallowed-tools": "many",
  "--disallowedTools": "many",
  "--mcp-config": "many",
  "--tools": "many",
};

/** A control character would end or corrupt the command when it is typed into the shell. */
const typeable = (s: string) => !/[\x00-\x1f\x7f]/.test(s);

/**
 * The flags worth keeping from a Claude Code command line, with `--flag=value` split in two.
 * @param argv the arguments after the program name
 */
export function keepResumeArgs(argv: unknown): string[] {
  if (!Array.isArray(argv)) return [];
  const list = argv.filter((a): a is string => typeof a === "string");
  const kept: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "--") break; // everything after it is positional
    const eq = list[i].indexOf("=");
    const flag = eq > 0 ? list[i].slice(0, eq) : list[i];
    const arity = Object.hasOwn(KEEP, flag) ? KEEP[flag] : undefined;
    if (arity === undefined) continue;
    const values: string[] = [];
    if (eq > 0) values.push(list[i].slice(eq + 1));
    else if (arity === 1 && i + 1 < list.length) values.push(list[++i]);
    else if (arity === "optional" || arity === "many") {
      while (i + 1 < list.length && !list[i + 1].startsWith("-")) {
        values.push(list[++i]);
        if (arity === "optional") break;
      }
    }
    const fine = values.filter(typeable);
    if (arity === 1 && !fine.length) continue; // its only value can't be typed, so the flag can't stand
    kept.push(flag, ...fine);
  }
  return kept;
}

const plain = (s: string) => /^[\w./:=@,+-]+$/.test(s);

/** One argument as Windows programs parse a command line (CommandLineToArgvW's rules). */
function winArg(s: string) {
  if (plain(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** At cmd's prompt every special character, the quotes included, is escaped with a caret. */
const cmdArg = (s: string) => winArg(s).replace(/[()%!^"<>&|]/g, "^$&");

/** A single-quoted PowerShell string holding what the legacy native argument passing needs. */
function psArg(s: string) {
  if (plain(s)) return s;
  let v = s.replace(/(\\*)"/g, '$1$1\\"');
  if (/\s/.test(s)) v = v.replace(/(\\+)$/, "$1$1");
  return `'${v.replace(/['‘’‚‛]/g, "$&$&")}'`;
}

const shArg = (s: string) => (plain(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The line to type into a tab's shell to resume a session.
 * @param shell the tab's shell id; one we can't quote for resumes without the flags
 */
export function resumeCommand(session: string, args: string[] | undefined, shell: string) {
  const base = `claude --resume ${session}`;
  if (!args?.length) return base;
  if (shell === "cmd") return `${base} ${args.map(cmdArg).join(" ")}`;
  if (shell === "default") return `${base} ${args.map(shArg).join(" ")}`;
  if (shell === "powershell" || shell === "pwsh") {
    // PowerShell 7.3+ would pass the backslash in \" along; this asks every version for the old way.
    const legacy = args.some((a) => a.includes('"')) ? "$PSNativeCommandArgumentPassing='Legacy'; " : "";
    return `${legacy}${base} ${args.map(psArg).join(" ")}`;
  }
  return base;
}
