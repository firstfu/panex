// Saving the workspace/tab layout to session.json through the backend. Structural changes
// save at once; cwd updates are batched.

import { invoke } from "@tauri-apps/api/core";
import { type Session } from "./types";
import { S, tabs, workspaces, wsOrder } from "./state";

let sessionTimer: number | undefined;

function sessionData(): Session {
  return {
    active: S.activeWsId ?? null,
    workspaces: wsOrder.map((wid) => {
      const ws = workspaces.get(wid)!;
      return {
        id: ws.id,
        title: ws.customTitle ?? null,
        color: ws.color ?? null,
        group: ws.group ?? null,
        active: ws.activeTab ?? null,
        tabs: ws.tabs.map((tid) => {
          const t = tabs.get(tid)!;
          return { id: t.id, shell: t.shell, ssh: t.ssh ?? null, cwd: t.cwd ?? null, title: t.customTitle ?? null, agentSession: t.agentSession ?? null, noSleep: t.noSleep || undefined };
        }),
      };
    }),
  };
}

/** Saves the layout now (structural changes); cwd updates go through saveSessionSoon. */
export function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = undefined;
  return invoke("session_save", { session: sessionData() }).catch(() => {});
}

export function saveSessionSoon() {
  sessionTimer ??= window.setTimeout(saveSession, 500);
}

/** Saves now if a batched save is still waiting (window close). */
export function saveSessionIfPending() {
  return sessionTimer !== undefined ? saveSession() : undefined;
}
