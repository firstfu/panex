// Inline renaming of a workspace or tab in the sidebar / tab bar.

import { type Tab, type Workspace } from "./types";
import { S, activeTab, autoTabTitle, tabTitle, tabs, workspaces, wsTitle } from "./state";
import { saveSession } from "./session";
import { showTab, showWorkspace } from "./workspaces";
import { render } from "./render";
import { hideCtx } from "./context-menu";

export function startRename(kind: "ws" | "tab", id: string) {
  const target = kind === "ws" ? workspaces.get(id) : tabs.get(id);
  if (!target) return;
  hideCtx();
  if (kind === "tab") showTab(id);
  else if (S.activeWsId !== id) showWorkspace(id);
  S.renaming = { kind, id };
  render();
  const input = document.querySelector<HTMLInputElement>(".rename-input");
  if (!input) return;
  input.value = kind === "ws" ? wsTitle(target as Workspace) : tabTitle(target as Tab);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    S.renaming = undefined;
    if (commit) {
      const v = input.value.trim();
      // Clearing the name (or leaving the automatic one) goes back to automatic titles.
      if (kind === "ws") {
        const ws = target as Workspace;
        ws.customTitle = v && v !== wsTitle({ ...ws, customTitle: undefined }) ? v : undefined;
      } else {
        const tab = target as Tab;
        tab.customTitle = v && v !== autoTabTitle(tab) ? v : undefined;
      }
      saveSession();
    }
    render();
    activeTab()?.term.focus();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}
