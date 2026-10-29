// Memory of every tab, shown next to its name in the tab bar and summed per workspace in the
// sidebar (Windows and macOS). Read from the tabs' process trees (`pty_usage`) only when
// something happens: switching tabs, the window coming back, an agent starting or finishing a
// turn, a tab hibernating, waking or ending, the pointer moving onto a tab. Bursts of events
// merge into one read. The optional live mode (`app.liveMemory`) also reads every 10 s, and
// only while the window has focus, so an idle panex in the background still runs no timer.

import { invoke } from "@tauri-apps/api/core";
import { S } from "./state";
import { scheduleRender } from "./render";
import { CAN_MANAGE } from "./platform";

export type Usage = { id: string; bytes: number; procs: number };

/** Last read of each running tab; a tab without a shell has no entry. */
export const memOf = new Map<string, Usage>();

export const readUsage = () => invoke<Usage[]>("pty_usage").catch(() => [] as Usage[]);

export function fmtBytes(n: number) {
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** 512 MB → "512M", 1.5 GB → "1.5G": short enough for a tab. */
export function fmtMemShort(bytes: number) {
  const mb = bytes / 1048576;
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)}G` : `${Math.max(1, Math.round(mb))}M`;
}

/** Takes a fresh read (the overview's) so the tabs show the same numbers. */
export function setUsage(list: Usage[]) {
  memOf.clear();
  for (const u of list) memOf.set(u.id, u);
  scheduleRender();
}

let soon: number | undefined;
let busy = false;
let again = false;

/** Reads every tab's memory shortly, merging the events that come in the meantime. */
export function refreshMem() {
  if (!CAN_MANAGE) return;
  soon ??= window.setTimeout(read, 300);
}

async function read() {
  soon = undefined;
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    setUsage(await readUsage());
  } finally {
    busy = false;
    if (again) {
      again = false;
      refreshMem();
    }
  }
}

let live: number | undefined;

/** Starts or stops the live 10 s reads to match the setting and the window's focus. */
export function syncLiveMem() {
  const on = CAN_MANAGE && S.settings.liveMemory && S.focused;
  if (on && live === undefined) {
    live = window.setInterval(refreshMem, 10_000);
    refreshMem();
  } else if (!on && live !== undefined) {
    clearInterval(live);
    live = undefined;
  }
}
