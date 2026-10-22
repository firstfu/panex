// Entry point of the panex frontend. Wires window and backend events (focus, close, pty exit,
// agent hooks, config reload), restores the saved session and shows the first workspace.
// Everything else lives in the modules imported below.

import "@xterm/xterm/css/xterm.css";
import "./style.css";
// Keyboard and mouse wiring; nothing imports it, it only has to run.
import "./input";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { translateDom, t as tr } from "./i18n";
import { IS_MAC } from "./platform";
import { validSessionId } from "./sanitize";
import { type AgentNotify, type LoadedConfig, type Session, type ShellInfo, type Workspace } from "./types";
import { $ } from "./util";
import { S, activeTab, tabs, workspaces, wsOrder } from "./state";
import { applyConfig, configWritesPending, keyLabel } from "./config";
import { saveSessionSoon } from "./session";
import { createTab, detectWindowsBuild, flushForClose } from "./terminal";
import { clearStatus, endAgent, endRun, notify, workingTabs } from "./agent";
import { closeTab, newTab, newWorkspace, showTab, showWorkspace } from "./workspaces";
import { scheduleGit, setGitOpen } from "./git-panel";
import { refreshHooks, renderShellMenu, scheduleRender } from "./render";
import { openCloseAsk } from "./close-ask";
import { sweepGoneWorktrees, wireControl } from "./control";
import { tidyGroups } from "./groups";

async function main() {
  document.body.classList.toggle("mac", IS_MAC);
  if (IS_MAC) translateDom(); // swaps Ctrl wording for ⌘ even when the language stays Chinese
  const win = getCurrentWindow();
  win.onFocusChanged(({ payload }) => {
    S.focused = payload;
    const tab = activeTab();
    if (S.focused && tab) clearStatus(tab);
    // Files may have changed in another program meanwhile.
    if (S.focused) scheduleGit(tab);
    // A worktree may have been deleted outside panex meanwhile.
    if (S.focused) sweepGoneWorktrees();
  });
  win.onCloseRequested(async (e) => {
    // Closing kills the agents' processes; --resume brings the conversation back but not the turn in progress.
    const working = workingTabs();
    if (S.settings.confirmClose && working.length) {
      e.preventDefault();
      openCloseAsk(working, tr("現在關閉會中斷它們正在做的這一輪。下次打開 panex 時會自動接回對話，但要再叫它繼續。"), async () => {
        await flushForClose();
        await win.destroy();
      });
      return;
    }
    await flushForClose();
  });

  listen<{ id: string; code: number }>("pty-exit", ({ payload }) => {
    const tab = tabs.get(payload.id);
    if (!tab) return;
    tab.running = false;
    if (tab.agentLive || tab.agentSession) endAgent(tab);
    if (tab.status === "running") tab.status = "idle";
    if (payload.code === 0) {
      closeTab(tab.id);
    } else {
      tab.exited = true;
      const close = keyLabel("closeTab");
      const closeHint = close ? tr("，{key} 關閉分頁", { key: close }) : "";
      const msg = tab.ssh
        ? tr("[連線已中斷（代碼 {code}）。按 Enter 重新連線{close}]", { code: payload.code, close: closeHint })
        : tr("[程序已結束（代碼 {code}）。按 Enter 重新啟動{close}]", { code: payload.code, close: closeHint });
      tab.term.write(`\r\n\x1b[90m${msg}\x1b[0m\r\n`);
      scheduleRender();
    }
  });

  listen<AgentNotify>("agent-notify", ({ payload: p }) => {
    const tab = tabs.get(p.pane);
    if (!tab) return;
    // Claude Code exited (or /clear started a new session; the next hook brings its id).
    if (p.event === "SessionEnd") {
      if (tab.agentLive || tab.agentSession) endAgent(tab);
      endRun(tab);
      tab.asking = false;
      return;
    }
    if (validSessionId(p.sessionId)) {
      tab.agentLive = true;
      if (tab.agentSession !== p.sessionId) {
        tab.agentSession = p.sessionId;
        saveSessionSoon();
      }
      scheduleRender();
    }
    if (p.event !== "Notification") tab.asking = false;
    if (p.event === "UserPromptSubmit") notify(tab, "running", "");
    else if (p.event === "Stop") {
      notify(tab, "done", p.message || tr("已完成"));
      scheduleGit(tab); // the agent's turn may have edited files or committed
    }
    // An API error (rate limit, overload…) ends the turn instead of Stop; the user has to retry.
    else if (p.event === "StopFailure") {
      notify(tab, "attention", p.message || tr("API 錯誤，這一輪停下來了"));
      scheduleGit(tab);
    }
    else if (p.notificationType === "auth_success") return;
    else if (p.notificationType === "idle_prompt" && tab.status === "done") return;
    else {
      // A permission prompt or question inside the turn; idle_prompt just means Claude is waiting for a new prompt.
      if (p.notificationType !== "idle_prompt") tab.asking = true;
      notify(tab, "attention", p.message || tr("需要你的回應"));
    }
  });

  listen<LoadedConfig>("config-changed", ({ payload }) => {
    // While our own writes are queued the file lags behind the UI (e.g. dragging the
    // opacity slider); the reload after the last write brings them back in step.
    if (configWritesPending()) return;
    applyConfig(payload);
    renderShellMenu();
  });

  const [, loaded, shellList, session] = await Promise.all([
    detectWindowsBuild(),
    invoke<LoadedConfig>("config_load"),
    invoke<ShellInfo[]>("shells_list"),
    invoke<Session>("session_load"),
  ]);
  S.shells = shellList;
  applyConfig(loaded);
  renderShellMenu();
  // The backend already installed the hooks at launch; the line only shows a button if that failed.
  refreshHooks();
  getVersion().then((v) => ($("s-version").textContent = `panex v${v}`)).catch(() => {});

  const saved = (session.workspaces ?? []).filter((w) => w.tabs?.length);
  const restored = await Promise.all(
    saved.flatMap((w) => w.tabs).map((t) => invoke<string>("scrollback_load", { id: t.id }).catch(() => "")),
  );
  let k = 0;
  for (const sw of saved) {
    const ws: Workspace = { id: sw.id, customTitle: sw.title ?? undefined, color: sw.color ?? undefined, group: sw.group ?? undefined, tabs: [] };
    workspaces.set(ws.id, ws);
    wsOrder.push(ws.id);
    for (const st of sw.tabs) ws.tabs.push(createTab(st, ws.id, restored[k++]).id);
    ws.activeTab = sw.active && ws.tabs.includes(sw.active) ? sw.active : ws.tabs[0];
  }
  tidyGroups();

  try {
    if (localStorage.getItem("panex.gitOpen")) setGitOpen(true);
  } catch { /* storage unavailable */ }
  await document.fonts.ready;
  const first = session.active && workspaces.has(session.active) ? session.active : wsOrder[0];
  if (first) showWorkspace(first);
  else newWorkspace();
  // After the restore, so `panex-cli open` can place its workspace next to the caller's.
  wireControl();
  sweepGoneWorktrees();
}

if (import.meta.env.DEV) (window as any).__panex = { tabs, workspaces, wsOrder, showTab, newTab, newWorkspace, closeTab };

main();
