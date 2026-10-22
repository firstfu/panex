// The "agents are still working" confirmation shown before closing tabs or the window.

import { t as tr } from "./i18n";
import { type Tab } from "./types";
import { $ } from "./util";
import { activeTab, tabTitle, workspaces, wsTitle } from "./state";

export const closeAskEl = $("close-ask");

let closeAskConfirm: (() => void) | undefined;

export function openCloseAsk(working: Tab[], text: string, confirm: () => void, okLabel = tr("仍要關閉")) {
  closeAskConfirm = confirm;
  $("close-ask-ok").textContent = okLabel;
  $("close-ask-title").textContent = tr("還有 {n} 個 agent 在工作", { n: working.length });
  $("close-ask-text").textContent = text;
  $("close-ask-list").replaceChildren(
    ...working.map((t) => {
      const ws = workspaces.get(t.wsId);
      const li = document.createElement("li");
      li.textContent = ws && ws.tabs.length > 1 ? `${wsTitle(ws)} › ${tabTitle(t)}` : tabTitle(t);
      return li;
    }),
  );
  closeAskEl.hidden = false;
  // Cancel holds the focus, so an Enter meant for the terminal doesn't close the window.
  $("close-ask-cancel").focus();
}

function closeCloseAsk() {
  closeAskEl.hidden = true;
  closeAskConfirm = undefined;
  activeTab()?.term.focus();
}
$("close-ask-cancel").onclick = closeCloseAsk;
$("close-ask-ok").onclick = () => {
  const confirm = closeAskConfirm;
  closeAskEl.hidden = true;
  confirm?.();
  activeTab()?.term.focus();
};
closeAskEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCloseAsk();
});
