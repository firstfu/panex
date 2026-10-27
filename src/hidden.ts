// Hidden workspaces: taken off the sidebar list (their terminals keep running) and listed under
// the "已隱藏" row at its bottom. Like collapsed groups, this is a per-machine view preference
// kept in localStorage, keyed by workspace id, so it never touches the session file format.

import { workspaces, wsOrder } from "./state";
import { scheduleRender } from "./render";

const HIDDEN_KEY = "panex.hiddenWorkspaces";
let hidden: Set<string> | undefined;
function hiddenSet() {
  if (!hidden) {
    try {
      hidden = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]"));
    } catch {
      hidden = new Set();
    }
  }
  return hidden;
}

export const isHidden = (id: string) => hiddenSet().has(id);

/** Workspaces shown in the sidebar, in order; what the 1–9 and next/prev shortcuts walk. */
export const visibleOrder = () => wsOrder.filter((id) => !isHidden(id));

/** Hidden workspaces still open, in sidebar order. */
export const hiddenOrder = () => wsOrder.filter(isHidden);

/** Hides or shows `ids` together. Ids of closed workspaces are dropped on the way. */
export function setHidden(ids: string[], on: boolean) {
  const set = hiddenSet();
  for (const id of ids) {
    if (on) set.add(id);
    else set.delete(id);
  }
  for (const id of set) if (!workspaces.has(id)) set.delete(id);
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set]));
  } catch { /* storage unavailable */ }
  scheduleRender();
}

/** Whether hiding `ids` would still leave a workspace in the list (the last one can't go). */
export const canHide = (ids: string[]) => visibleOrder().some((id) => !ids.includes(id));
