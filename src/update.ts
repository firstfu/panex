// App updates, frontend half: decides when to look for a newer panex and shows the result in the
// sidebar. The backend (updater.rs) does the checking, downloading and installing.
//
// There is no timer: a check runs at launch and when the window regains focus (at most every
// CHECK_EVERY_MS), so an idle panex costs nothing. Installing always waits for a click, because
// relaunching ends every shell and agent.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t as tr } from "./i18n";
import { S } from "./state";
import { $ } from "./util";
import { workingTabs } from "./agent";
import { flushForClose } from "./terminal";
import { openCloseAsk } from "./close-ask";

interface UpdateInfo {
  version: string;
  notes?: string | null;
}

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const rowEl = $("update-row");

let available: UpdateInfo | undefined;
let lastCheck = 0;
let checking = false;
let installing = false;
/** Download progress 0–100 while installing, undefined while the size is unknown. */
let percent: number | undefined;

/** One-line result of the last manual check, shown in the settings page. */
let manualResult = "";

/** Redraws the sidebar line from the current state. */
function render() {
  rowEl.classList.remove("err");
  rowEl.replaceChildren();
  if (installing) {
    rowEl.hidden = false;
    rowEl.textContent = percent === undefined ? tr("正在下載更新…") : tr("正在下載更新… {p}%", { p: percent });
    return;
  }
  if (!available) {
    rowEl.hidden = true;
    return;
  }
  rowEl.hidden = false;
  rowEl.append(tr("有新版本 {v}", { v: available.version }));
  const b = document.createElement("button");
  b.textContent = tr("更新並重新啟動");
  b.title = tr("下載新版、安裝並重新啟動 panex。重新啟動會結束所有分頁裡的程式；工作區與捲動歷史會還原");
  b.onclick = () => void installUpdate();
  rowEl.appendChild(b);
}

function setManual(text: string) {
  manualResult = text;
  $("s-update-status").textContent = text;
}

/** Looks for a newer version. A background check stays silent when it finds nothing or fails;
 *  a manual one reports either way in the settings page. */
export async function checkForUpdate(manual: boolean) {
  if (checking || installing) return;
  if (!manual && !S.settings.autoUpdate) return;
  checking = true;
  if (manual) setManual(tr("檢查中…"));
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    lastCheck = Date.now();
    available = info ?? undefined;
    render();
    if (manual) setManual(info ? tr("有新版本 {v}，側欄可以更新", { v: info.version }) : tr("已是最新版本"));
  } catch (e) {
    if (manual) setManual(tr("檢查失敗：{e}", { e: String(e) }));
  } finally {
    checking = false;
  }
}

/** Launch and focus hook: checks when auto-update is on and the last check is old enough. */
export function checkForUpdateSoon() {
  if (Date.now() - lastCheck < CHECK_EVERY_MS) return;
  void checkForUpdate(false);
}

/** Saves the session, then lets the backend download, install and relaunch. Asks first while
 *  agents are mid-turn, the same as closing the window would. */
export async function installUpdate() {
  if (installing || !available) return;
  const go = async () => {
    installing = true;
    percent = undefined;
    render();
    try {
      // The relaunch skips the window's close handler, so the session and scrollback go out now.
      await flushForClose();
      await invoke("update_install");
    } catch (e) {
      installing = false;
      render();
      rowEl.classList.add("err");
      rowEl.append(` ${tr("更新失敗：{e}", { e: String(e) })}`);
    }
  };
  const working = workingTabs();
  if (S.settings.confirmClose && working.length) {
    openCloseAsk(working, tr("更新會重新啟動 panex，中斷它們正在做的這一輪。重啟後會自動接回對話，但要再叫它繼續。"), go, tr("仍要更新"));
    return;
  }
  await go();
}

listen<{ downloaded: number; total?: number | null }>("update-progress", ({ payload }) => {
  percent = payload.total ? Math.min(100, Math.floor((payload.downloaded * 100) / payload.total)) : undefined;
  if (installing) render();
});

/** Settings page: shows what the last manual check said when the page opens. */
export function showManualResult() {
  $("s-update-status").textContent = manualResult;
}
