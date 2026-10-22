---
name: panex
description: Crew mode (小隊模式) - start other coding agents in new panex terminal tabs (each optionally in its own git worktree) and wait for them to finish. Use only inside panex (the PANEX_PANE_ID environment variable is set), when the user asks to split work across parallel agents, try several approaches side by side, or hand a task to an agent they can watch.
---

# panex crew mode: parallel agents in tabs the user can see

(panex installs this file and replaces it when it updates; edits here don't last.)

1. Check that `PANEX_PANE_ID` is set. If it isn't, you are not in a panex tab: say so and stop.
2. Run `panex-cli help` and follow it. The flags live in the binary, so don't use any that it doesn't list.

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
