---
name: panex
description: Crew mode (小隊模式) - start other coding agents in new panex terminal tabs (each optionally in its own git worktree) and wait for them to finish. Use only inside panex (the PANEX_PANE_ID environment variable is set), when the user asks to split work across parallel agents, try several approaches side by side, or hand a task to an agent they can watch. Also use it whenever the user wants work done in a worktree or on a separate branch ("use worktree", "do it on a new branch", "isolate this"): that is a hand-off, see below. Also use it when the user (often from their phone) asks about or drives the other panex tabs: which tabs are open or asleep (hibernated), wake a tab, or pass a tab's Claude Code a message and report its answer ("叫醒 X", "哪些分頁在休眠", "叫 X 去跑測試再告訴我結果").
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
- Wait with `panex-cli wait <tab>...`. `needs-input` means that agent is asking the user
  something: tell the user which tab, don't try to answer for them.
- Collect results from git (`git diff <base>...<branch>`, `git log`), not from the screen.

Driving tabs that are already open (`panex-cli list`, `wake`, `send`; the help has the details):
start with `list` and use the tab ids it prints. To pass a message on, `send` it and then `wait`
for that tab, and tell the user its answer. Never send what the user didn't ask for, and if a tab's
Claude is asking the user something, tell them which tab instead of answering for them.
