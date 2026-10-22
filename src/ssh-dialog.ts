// The "SSH connection" dialog: pick a host from ~/.ssh/config or type user@host:port, and
// open it as its own workspace running the system ssh.

import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "./i18n";
import { validSshTarget } from "./sanitize";
import { type Workspace } from "./types";
import { $, newId, newWsId } from "./util";
import { activeTab, workspaces, wsOrder } from "./state";
import { createTab } from "./terminal";
import { showTab } from "./workspaces";
import { hideCtx } from "./context-menu";

const sshEl = $("ssh");
const sshTargetEl = $<HTMLInputElement>("ssh-target");
const sshErrEl = $("ssh-err");
let sshHostsLoaded = false;

export function openSshDialog() {
  hideCtx();
  sshTargetEl.value = "";
  sshErrEl.textContent = "";
  sshEl.hidden = false;
  sshTargetEl.focus();
  // ~/.ssh/config is read once, the first time the dialog opens.
  if (sshHostsLoaded) return;
  sshHostsLoaded = true;
  invoke<string[]>("ssh_hosts")
    .then((list) => $("ssh-hosts").replaceChildren(...list.map((h) => Object.assign(document.createElement("option"), { value: h }))))
    .catch(() => (sshHostsLoaded = false));
}

function closeSshDialog() {
  sshEl.hidden = true;
  activeTab()?.term.focus();
}

/** Each connection gets its own workspace, like picking a shell from the ⌄ menu. */
function newSshWorkspace(target: string) {
  const ws: Workspace = { id: newWsId(), tabs: [] };
  workspaces.set(ws.id, ws);
  wsOrder.push(ws.id);
  const tab = createTab({ id: newId(), shell: "ssh", ssh: target }, ws.id);
  ws.tabs.push(tab.id);
  showTab(tab.id);
}

$("ssh-cancel").onclick = closeSshDialog;
sshEl.addEventListener("mousedown", (e) => e.target === sshEl && closeSshDialog());
sshEl.querySelector("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  const target = sshTargetEl.value.trim();
  if (!validSshTarget(target)) {
    sshErrEl.textContent = tr("格式是 主機、帳號@主機 或 帳號@主機:埠號");
    return;
  }
  sshEl.hidden = true;
  newSshWorkspace(target);
});
sshEl.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") closeSshDialog();
});
