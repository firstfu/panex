---
name: panex
description: Crew mode (小隊模式) - start other coding agents in new panex terminal tabs (each optionally in its own git worktree) and wait for them to finish. Use only inside panex (the PANEX_PANE_ID environment variable is set), when the user asks to split work across parallel agents, try several approaches side by side, or hand a task to an agent they can watch. Also use it whenever the user wants work done in a worktree or on a separate branch ("use worktree", "do it on a new branch", "isolate this"): that is a hand-off, see below.
---

# panex crew mode: parallel agents in tabs the user can see

(panex installs this file and replaces it when it updates; edits here don't last.)

1. Check that `PANEX_PANE_ID` is set. If it isn't, you are not in a panex tab: say so and stop.
2. Run `panex-cli help` and follow it. The flags live in the binary, so don't use any that it doesn't list.

Worktree requests are hand-offs: when the user wants work done in a worktree (however they word it),
do not use the built-in EnterWorktree tool (panex blocks it). It would switch this conversation into
the worktree while panex opens a second, empty shell there. Instead start a new agent with
`panex-cli open --worktree <branch> -- claude "<task>"`, where the branch is a short name taken from
the task, then `panex-cli wait <tab>`. Tell the user which tab you opened and don't do the work yourself.
Skip the "tell the user and wait for an OK" step below when there is just this one agent.

How to use it well:

- Before opening more than one tab, tell the user what each agent will do and wait for an OK.
- Give every agent its own worktree (`--worktree <branch>`), so they never edit the same files.
- Write each agent's instructions into a file in its worktree, and start it with a short
  command such as `-- claude "Do what TASK.md says, then commit"`.
- If an agent's work changes anything shown in a web page, its TASK.md must include checking
  that page in a browser the way `panex-cli help` describes (open, click through, screenshot),
  and committing only once those checks pass. If help names no browser tool, ask the user
  how they want the pages checked before you start the agents.
- Wait with `panex-cli wait <tab>...`. `needs-input` means that agent is asking the user
  something: tell the user which tab, don't try to answer for them.
- Collect results from git (`git diff <base>...<branch>`, `git log`), not from the screen.
