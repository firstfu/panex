// The settings panel: its pages, the shortcut editor (recording, conflicts, reset) and the
// controls that write panex.json.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { t as tr, type LangPref } from "./i18n";
import { ACTIONS, GROUPS, digitFamily, eventCombo, formatBinding, formatCombo, resolveBindings, type ActionDef, type Steps } from "./keys";
import { type LoadedConfig } from "./types";
import { DEFAULTS, FONT_CUSTOM, GENERIC_FONTS, cssFont, fontNames, termFontFamily, type Settings } from "./settings";
import { $, esc } from "./util";
import { S, activeTab } from "./state";
import { applyConfig, setBinding, setFontSize, showNotice, updateSettings, writeConfig, writeSettingNow } from "./config";
import { scheduleRender } from "./render";
import { hideCtx } from "./context-menu";
import { checkForUpdate, showManualResult } from "./update";
import { openLink } from "./links";
import { IS_MAC } from "./platform";
import appIcon from "../src-tauri/icons/128x128@2x.png";

export const settingsEl = $("settings");
let capturingId: string | undefined;
let capturingAlt = 0; // which alternative is being recorded; equal to the count means "adding one"
export const isCapturing = () => capturingId !== undefined;

// Gestures that aren't rebindable, shown under the editable shortcuts for reference.
const FIXED_KEYS: [string, string[]][] = [
  ["放大／縮小字型", ["Ctrl", "滾輪"]],
  ["顯示工作區與分頁編號", ["按住 Ctrl 或 Alt"]],
  ["重新命名", ["雙擊工作區或分頁"]],
  ["顏色、排序、關閉", ["右鍵工作區或分頁"]],
  ["關閉", ["中鍵點工作區或分頁"]],
  ["新分頁", ["雙擊分頁列空白處"]],
];

// Notes that are warnings (shown red) rather than confirmations.
const WARN_NOTES = [
  "請加上 Ctrl、Alt 或 Win 鍵（F1–F12 可單獨使用），一般按鍵要留給終端機輸入。",
  "這個動作要用「修飾鍵＋數字」，例如按 Ctrl+Alt+1 就代表 Ctrl+Alt+1–9。",
];
let keysNote = "";
let settingsPage = "general";

/** Each key of a binding as its own keycap; chord steps are separated by a small gap. */
function keycaps(steps: Steps, digits = false): string {
  return steps
    .map((step) => {
      const parts = step.split("+");
      const caps = parts.map((p, i) => {
        const label = digits && i === parts.length - 1 && p === "1" ? "1–9" : formatCombo(p);
        return `<kbd>${esc(label)}</kbd>`;
      });
      return `<span class="combo">${caps.join("")}</span>`;
    })
    .join(`<span class="then">${esc(tr("再按"))}</span>`);
}

function renderKeys() {
  const overrides = S.rawConfig.shortcuts?.bindings ?? {};
  const q = $<HTMLInputElement>("keys-filter").value.trim().toLowerCase();
  const matches = (label: string, alts: Steps[], digits?: boolean) =>
    !q || label.toLowerCase().includes(q) || formatBinding(alts, digits).toLowerCase().includes(q);

  const groups = GROUPS.map((g) => {
    const rows = ACTIONS.filter((a) => a.group === g && matches(tr(a.label), S.bindings.get(a.id) ?? [], a.digits)).map((a) => {
      const alts = S.bindings.get(a.id) ?? [];
      const changed = Object.prototype.hasOwnProperty.call(overrides, a.id);
      const capturing = capturingId === a.id;
      const prompt = `<span class="capture">${esc(tr(a.digits ? "按修飾鍵＋任一數字" : "按下新的組合鍵"))}</span>`;
      // One chip per alternative; the one being re-recorded shows the prompt instead.
      const chips = alts.map((steps, i) => {
        const live = capturing && capturingAlt === i;
        const label = esc(tr("變更「{name}」的第 {n} 組快捷鍵", { name: tr(a.label), n: i + 1 }));
        const x =
          alts.length > 1 && !live
            ? `<button class="chip-x" data-remove="${a.id}" data-alt="${i}" title="${esc(tr("移除這組"))}" aria-label="${esc(tr("移除這組"))}">×</button>`
            : "";
        return (
          `<span class="chip${live ? " live" : ""}">` +
          `<button class="bind" data-bind="${a.id}" data-alt="${i}" aria-label="${label}">${live ? prompt : keycaps(steps, a.digits)}</button>${x}</span>`
        );
      });
      if (capturing && capturingAlt >= alts.length) chips.push(`<span class="chip live"><span class="bind">${prompt}</span></span>`);
      if (!chips.length) chips.push(`<button class="bind" data-bind="${a.id}" data-alt="0"><span class="unbound">${esc(tr("未設定"))}</span></button>`);
      const add =
        capturing || !alts.length
          ? ""
          : `<button class="add" data-add="${a.id}" title="${esc(tr("再加一組快捷鍵"))}" aria-label="${esc(tr("為「{name}」再加一組快捷鍵", { name: tr(a.label) }))}">＋</button>`;
      return (
        `<div class="krow${changed ? " changed" : ""}${capturing ? " capturing" : ""}">` +
        `<span class="kname">${esc(tr(a.label))}</span>` +
        `<span class="binds">${chips.join("")}${add}</span>` +
        (changed ? `<button class="reset" data-reset="${a.id}" title="${esc(tr("恢復預設"))}" aria-label="${esc(tr("恢復預設"))}">↺</button>` : '<span class="reset-slot"></span>') +
        `</div>`
      );
    });
    return rows.length ? `<div class="kgroup"><h4>${esc(tr(g))}</h4>${rows.join("")}</div>` : "";
  }).join("");

  const fixed = FIXED_KEYS.map(([label, keys]) => [tr(label), keys.map((k) => tr(k))] as [string, string[]])
    .filter(([label, keys]) => !q || label.toLowerCase().includes(q) || keys.join(" ").toLowerCase().includes(q))
    .map(([label, keys]) => `<div class="krow fixed"><span class="kname">${label}</span><span class="bind">${keys.map((k) => `<kbd>${k}</kbd>`).join("")}</span><span class="reset-slot"></span></div>`)
    .join("");

  $("keys").innerHTML =
    groups + (fixed ? `<div class="kgroup"><h4>${esc(tr("滑鼠與固定操作"))}</h4>${fixed}</div>` : "") ||
    `<p class="empty">${esc(tr("找不到「{q}」。試試動作名稱，例如「分頁」，或按鍵，例如「ctrl+shift」。", { q }))}</p>`;
  const capHint = capturingId ? tr("Esc 取消，Backspace 移除這一組快捷鍵。") : "";
  $("keys-note").textContent = keysNote || capHint;
  $("keys-note").classList.toggle("warn", WARN_NOTES.some((k) => tr(k) === keysNote));
}

interface PermStatus {
  accessibility: boolean | null;
  screen_recording: boolean | null;
  full_disk: boolean | null;
}

/**
 * Reads the macOS permissions into the General page. Only while that page is on screen: when it
 * opens and when the window gets focus back (the user returning from System Settings), so there
 * is no timer.
 */
export async function refreshPerms() {
  if (!IS_MAC || settingsEl.hidden || settingsPage !== "general") return;
  const p = await invoke<PermStatus>("perms_status").catch(() => undefined);
  const state: Record<string, boolean | null | undefined> = { accessibility: p?.accessibility, screen: p?.screen_recording, disk: p?.full_disk };
  settingsEl.querySelectorAll<HTMLElement>(".perm").forEach((row) => {
    const v = state[row.dataset.perm ?? ""];
    const el = row.querySelector<HTMLElement>(".perm-state");
    if (!el) return;
    el.className = `perm-state${v === true ? " ok" : v === false ? " no" : ""}`;
    el.textContent = v === true ? tr("已授權") : v === false ? tr("未授權") : tr("無法判斷");
    row.querySelector<HTMLElement>("[data-perm-open]")!.textContent = tr(v === true ? "打開設定" : "授權…");
  });
}

function showSettingsPage(page: string) {
  settingsPage = page;
  if (page === "general") void refreshPerms();
  settingsEl.querySelectorAll<HTMLElement>(".s-tab").forEach((t) => t.classList.toggle("on", t.dataset.page === page));
  settingsEl.querySelectorAll<HTMLElement>(".s-page").forEach((p) => (p.hidden = p.dataset.page !== page));
  if (page !== "keys") capturingId = undefined;
}

function setSeg(id: string, value: string) {
  $(id).querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    const on = b.dataset.v === value;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
}

export function fillSettings() {
  const o = $<HTMLInputElement>("s-opacity");
  o.value = String(S.settings.opacity);
  o.style.setProperty("--p", `${((S.settings.opacity - 30) / 70) * 100}%`);
  $("s-opacity-v").textContent = `${S.settings.opacity}%`;
  setSeg("s-effect", S.settings.effect);
  setSeg("s-language", S.settings.language);
  setSeg("s-open-with", S.settings.openFilesWith);
  $<HTMLInputElement>("s-font-size").value = String(S.settings.fontSize);
  fillFontPicker();
  const sample = $("font-sample");
  sample.style.fontFamily = termFontFamily(S.settings.fontFamily);
  sample.style.fontSize = `${S.settings.fontSize}px`;
  $("s-shell").innerHTML = S.shells.map((s) => `<button data-v="${s.id}" role="radio">${esc(tr(s.name))}</button>`).join("");
  setSeg("s-shell", S.settings.defaultShell);
  $<HTMLInputElement>("s-blink").checked = S.settings.cursorBlink;
  $<HTMLInputElement>("s-smart").checked = S.settings.smartCopyPaste;
  $<HTMLInputElement>("s-hints").checked = S.settings.modifierHints;
  $<HTMLInputElement>("s-resume").checked = S.settings.resumeSession;
  $<HTMLInputElement>("s-update").checked = S.settings.autoUpdate;
  showManualResult();
  $<HTMLInputElement>("s-confirm-close").checked = S.settings.confirmClose;
  $<HTMLInputElement>("s-worktree-panex").checked = S.settings.worktreeViaPanex;
  $<HTMLInputElement>("s-scrollback").value = String(S.settings.scrollback);
  $<HTMLInputElement>("s-win-w").value = String(S.settings.windowWidth);
  $<HTMLInputElement>("s-win-h").value = String(S.settings.windowHeight);
  $("cfg-path").textContent = S.configPath;
  renderKeys();
}

let fontList: string[] | undefined; // installed monospaced families, fetched the first time settings open
let fontsReq: Promise<void> | undefined;
let fontCustom = false; // the free-text font field is showing

function fillFontPicker() {
  const pick = $<HTMLSelectElement>("s-font-pick");
  const ff = $<HTMLInputElement>("s-font-family");
  const names = fontNames(S.settings.fontFamily);
  const isDefault = S.settings.fontFamily === DEFAULTS.fontFamily;
  const single = names.length === 1 && !GENERIC_FONTS.includes(names[0].toLowerCase()) ? names[0] : undefined;
  // Before the list arrives, still offer the current font so the picker shows it.
  const list = fontList ?? (single ? [single] : []);
  if (!isDefault && !(single && list.includes(single))) fontCustom = true;
  const value = fontCustom ? FONT_CUSTOM : isDefault ? "" : single!;
  if (document.activeElement !== pick) {
    const opt = (v: string, label: string) =>
      `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(label)}</option>`;
    pick.innerHTML = [
      opt("", `${tr("預設")}（${fontNames(DEFAULTS.fontFamily)[0]}）`),
      ...list.map((n) => opt(n, n)),
      fontList ? "" : `<option disabled>${esc(tr("讀取字型清單…"))}</option>`,
      opt(FONT_CUSTOM, tr("自訂…")),
    ].join("");
  }
  ff.hidden = !fontCustom;
  ff.placeholder = tr("CSS font-family，可列多個字型，前面的找不到就用下一個");
  if (document.activeElement !== ff) ff.value = S.settings.fontFamily;
}

export function openSettings() {
  hideCtx();
  fontsReq ??= invoke<string[]>("fonts_list")
    .then((l) => void (fontList = l))
    .catch(() => void (fontList = []))
    .then(() => {
      if (!settingsEl.hidden) fillSettings();
    });
  fillSettings();
  showSettingsPage(settingsPage);
  const wasHidden = settingsEl.hidden;
  settingsEl.hidden = false;
  void refreshPerms(); // after unhiding: it reads nothing while the panel is hidden
  if (wasHidden) settingsEl.querySelector<HTMLElement>(".s-tab.on")?.focus();
}

export function closeSettings() {
  capturingId = undefined;
  keysNote = "";
  settingsEl.hidden = true;
  activeTab()?.term.focus();
}

/** Handles a key press while a shortcut row is waiting for its new combo. */
export function captureKey(e: KeyboardEvent) {
  const id = capturingId!;
  const def = ACTIONS.find((a) => a.id === id)!;
  const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  if (e.key === "Escape" && plain) {
    capturingId = undefined;
    keysNote = "";
    return renderKeys();
  }
  const alts = S.bindings.get(id) ?? [];
  if ((e.key === "Backspace" || e.key === "Delete") && plain) {
    capturingId = undefined;
    if (capturingAlt < alts.length) {
      setBinding(id, alts.filter((_, i) => i !== capturingAlt));
      keysNote = tr("已移除「{name}」的一組快捷鍵。", { name: tr(def.label) });
    }
    return renderKeys();
  }
  let combo = eventCombo(e);
  if (!combo) return; // lone modifier: keep waiting
  // Shift+Enter types nothing of its own (xterm sends a bare \r), so it may be bound like a modifier combo.
  if (!/^(ctrl|alt|meta)\+/.test(combo) && !/^(shift\+)?f\d+$/.test(combo) && combo !== "shift+enter") {
    keysNote = tr(WARN_NOTES[0]);
    return renderKeys();
  }
  if (def.digits) {
    const fam = digitFamily(combo);
    if (!fam) {
      keysNote = tr(WARN_NOTES[1]);
      return renderKeys();
    }
    combo = fam.family;
  }
  // Whoever had this combo loses that one alternative, so one key press never means two things.
  const c = combo;
  const clashes = (other: ActionDef, steps: Steps) => {
    if (steps.length !== 1) return false;
    if (steps[0] === c) return true;
    const sameFamily = (fam: string, x: string) => digitFamily(x)?.family === fam;
    return (!!other.digits && sameFamily(steps[0], c)) || (!!def.digits && sameFamily(c, steps[0]));
  };
  const taken: ActionDef[] = [];
  for (const a of ACTIONS) {
    if (a.id === id) continue;
    const theirs = S.bindings.get(a.id) ?? [];
    const kept = theirs.filter((s) => !clashes(a, s));
    if (kept.length !== theirs.length) {
      taken.push(a);
      setBinding(a.id, kept);
    }
  }
  const own = alts.filter((s, i) => i !== capturingAlt && !(s.length === 1 && s[0] === c));
  own.splice(Math.min(capturingAlt, own.length), 0, [c]);
  capturingId = undefined;
  setBinding(id, own);
  keysNote = taken.length
    ? tr("已設定。「{names}」原本用這組按鍵，現在改為未設定。", { names: taken.map((a) => tr(a.label)).join(tr("、")) })
    : "";
  renderKeys();
}

settingsEl.querySelector(".s-nav")!.addEventListener("click", (e) => {
  const page = (e.target as HTMLElement).closest<HTMLElement>(".s-tab")?.dataset.page;
  if (page) {
    keysNote = "";
    showSettingsPage(page);
    renderKeys();
  }
});

$("keys").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const bindEl = t.closest<HTMLElement>("button[data-bind]");
  const removeEl = t.closest<HTMLElement>("[data-remove]");
  const add = t.closest<HTMLElement>("[data-add]")?.dataset.add;
  const reset = t.closest<HTMLElement>("[data-reset]")?.dataset.reset;
  if (removeEl) {
    const id = removeEl.dataset.remove!;
    setBinding(id, (S.bindings.get(id) ?? []).filter((_, i) => i !== +removeEl.dataset.alt!));
    keysNote = tr("已移除一組快捷鍵。");
    renderKeys();
  } else if (bindEl) {
    const id = bindEl.dataset.bind!;
    const alt = +bindEl.dataset.alt!;
    const same = capturingId === id && capturingAlt === alt;
    capturingId = same ? undefined : id;
    capturingAlt = alt;
    keysNote = "";
    renderKeys();
  } else if (add) {
    capturingId = add;
    capturingAlt = (S.bindings.get(add) ?? []).length;
    keysNote = "";
    renderKeys();
  } else if (reset) {
    setBinding(reset, undefined);
    keysNote = tr("已恢復預設。");
    renderKeys();
  }
});
$<HTMLInputElement>("keys-filter").oninput = () => renderKeys();
$("keys-reset-all").onclick = () => {
  writeConfig(["shortcuts", "bindings"], null);
  S.rawConfig = { ...S.rawConfig, shortcuts: { ...(S.rawConfig.shortcuts ?? {}), bindings: {} } };
  S.bindings = resolveBindings({});
  capturingId = undefined;
  keysNote = tr("已將所有快捷鍵恢復預設。");
  renderKeys();
  scheduleRender();
};
$("cfg-open").onclick = () => invoke("config_open").catch((e) => showNotice(String(e)));
$("cfg-reload").onclick = () => invoke<LoadedConfig>("config_load").then(applyConfig);

$<HTMLInputElement>("s-opacity").oninput = (e) => {
  const el = e.target as HTMLInputElement;
  const v = +el.value;
  el.style.setProperty("--p", `${((v - 30) / 70) * 100}%`);
  $("s-opacity-v").textContent = `${v}%`;
  updateSettings({ opacity: v });
};
$("s-effect").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>("[data-v]")?.dataset.v as Settings["effect"] | undefined;
  if (!v) return;
  // An effect behind a fully opaque window is invisible; pick a sensible see-through level.
  updateSettings({ effect: v, opacity: v !== "none" && S.settings.opacity === 100 ? 80 : S.settings.opacity });
  fillSettings();
});
$("s-open-with").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>("[data-v]")?.dataset.v as Settings["openFilesWith"] | undefined;
  if (!v) return;
  updateSettings({ openFilesWith: v });
  setSeg("s-open-with", v);
});
$("s-language").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>("[data-v]")?.dataset.v as LangPref | undefined;
  if (!v) return;
  updateSettings({ language: v });
  setSeg("s-language", v);
});
$("s-shell").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>("[data-v]")?.dataset.v;
  if (!v) return;
  updateSettings({ defaultShell: v });
  setSeg("s-shell", v);
});
settingsEl.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((b) => {
  b.onclick = () => {
    setFontSize(S.settings.fontSize + +b.dataset.step!);
    fillSettings();
  };
});
$<HTMLInputElement>("s-font-size").onchange = (e) => {
  setFontSize(+(e.target as HTMLInputElement).value || DEFAULTS.fontSize);
  fillSettings();
};
$<HTMLSelectElement>("s-font-pick").onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value;
  fontCustom = v === FONT_CUSTOM;
  if (fontCustom) {
    fillSettings();
    $("s-font-family").focus();
    return;
  }
  updateSettings({ fontFamily: v ? cssFont(v) : DEFAULTS.fontFamily });
  fillSettings();
};
$<HTMLInputElement>("s-font-family").oninput = (e) => {
  // Live preview while typing; saved when the field loses focus.
  $("font-sample").style.fontFamily = termFontFamily((e.target as HTMLInputElement).value || DEFAULTS.fontFamily);
};
$<HTMLInputElement>("s-font-family").onchange = (e) =>
  updateSettings({ fontFamily: (e.target as HTMLInputElement).value.trim() || DEFAULTS.fontFamily });
$<HTMLInputElement>("s-blink").onchange = (e) => updateSettings({ cursorBlink: (e.target as HTMLInputElement).checked });
$<HTMLInputElement>("s-resume").onchange = (e) => {
  updateSettings({ resumeSession: (e.target as HTMLInputElement).checked });
  scheduleRender();
};
$<HTMLInputElement>("s-update").onchange = (e) => updateSettings({ autoUpdate: (e.target as HTMLInputElement).checked });
$("s-update-check").onclick = () => void checkForUpdate(true);
$<HTMLImageElement>("s-app-icon").src = appIcon;
$("s-github").onclick = () => void openLink("open_url", { url: "https://github.com/firstfu/panex" });
$("s-report").onclick = () => void openLink("open_url", { url: "https://github.com/firstfu/panex/issues/new" });
settingsEl.addEventListener("click", (e) => {
  const kind = (e.target as HTMLElement).closest<HTMLElement>("[data-perm-open]")?.dataset.permOpen;
  if (kind) invoke("perms_open", { kind }).catch((err) => showNotice(String(err)));
});
$<HTMLInputElement>("s-confirm-close").onchange = (e) =>
  updateSettings({ confirmClose: (e.target as HTMLInputElement).checked });
// The WorktreeCreate hook in ~/.claude/settings.json follows this switch, and the backend reads
// it from panex.json, so the value is written before the hooks are brought in line.
$<HTMLInputElement>("s-worktree-panex").onchange = async (e) => {
  try {
    await writeSettingNow("worktreeViaPanex", (e.target as HTMLInputElement).checked);
    await invoke("hooks_sync");
  } catch (err) {
    showNotice(String(err));
  }
};
$<HTMLInputElement>("s-smart").onchange = (e) => updateSettings({ smartCopyPaste: (e.target as HTMLInputElement).checked });
$<HTMLInputElement>("s-hints").onchange = (e) => updateSettings({ modifierHints: (e.target as HTMLInputElement).checked });
$<HTMLInputElement>("s-scrollback").onchange = (e) => {
  const v = Math.min(100000, Math.max(500, Math.round(+(e.target as HTMLInputElement).value || DEFAULTS.scrollback)));
  updateSettings({ scrollback: v });
};
/** Saves the opening size and resizes the window to it right away. */
function setWindowSize(width: number, height: number) {
  const clamp = (v: number, min: number) => Math.min(10000, Math.max(min, Math.round(v)));
  updateSettings({ windowWidth: clamp(width, 480), windowHeight: clamp(height, 300) });
  fillSettings();
  getCurrentWindow().setSize(new LogicalSize(S.settings.windowWidth, S.settings.windowHeight)).catch(() => {});
}
$<HTMLInputElement>("s-win-w").onchange = (e) => setWindowSize(+(e.target as HTMLInputElement).value || DEFAULTS.windowWidth, S.settings.windowHeight);
$<HTMLInputElement>("s-win-h").onchange = (e) => setWindowSize(S.settings.windowWidth, +(e.target as HTMLInputElement).value || DEFAULTS.windowHeight);
$("s-win-current").onclick = async () => {
  const win = getCurrentWindow();
  const size = (await win.innerSize()).toLogical(await win.scaleFactor());
  updateSettings({ windowWidth: Math.round(size.width), windowHeight: Math.round(size.height) });
  fillSettings();
};
settingsEl.addEventListener("mousedown", (e) => {
  if (e.target === settingsEl) closeSettings();
});

// 拖左側欄或「一般」頁頂端的 App 卡片空白處可移動面板。位移只存在記憶體（這次開著 App 期間沿用），
// 用 CSS `translate` 而非 `transform`，才不會跟開啟動畫的 transform 互相覆蓋。
const settingsPanel = settingsEl.querySelector<HTMLElement>(".panel")!;
let panelDx = 0;
let panelDy = 0;

/**
 * 套用面板位移，並夾在視窗內：面板至少留 80px 在畫面裡，避免拖出去後抓不回來。
 * @param dx 相對置中位置的水平位移（px）
 * @param dy 相對置中位置的垂直位移（px）
 */
function movePanel(dx: number, dy: number) {
  const w = settingsPanel.offsetWidth;
  const h = settingsPanel.offsetHeight;
  const maxX = Math.max(0, (innerWidth + w) / 2 - 80);
  const maxY = Math.max(0, (innerHeight + h) / 2 - 80);
  panelDx = Math.min(maxX, Math.max(-maxX, dx));
  panelDy = Math.min(maxY, Math.max(-maxY, dy));
  settingsPanel.style.translate = panelDx || panelDy ? `${panelDx}px ${panelDy}px` : "";
}

settingsPanel.addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  if (e.button !== 0 || !t.closest(".s-nav, .about") || t.closest("button, a, input, select, textarea, .about-text span")) return;
  e.preventDefault();
  const startX = e.clientX - panelDx;
  const startY = e.clientY - panelDy;
  settingsPanel.setPointerCapture(e.pointerId);
  settingsPanel.classList.add("moving");
  const onMove = (m: PointerEvent) => movePanel(m.clientX - startX, m.clientY - startY);
  const onUp = () => {
    settingsPanel.classList.remove("moving");
    settingsPanel.removeEventListener("pointermove", onMove);
    settingsPanel.removeEventListener("pointerup", onUp);
    settingsPanel.removeEventListener("pointercancel", onUp);
  };
  settingsPanel.addEventListener("pointermove", onMove);
  settingsPanel.addEventListener("pointerup", onUp);
  settingsPanel.addEventListener("pointercancel", onUp);
});
// 視窗縮小後重新夾一次，免得面板留在看不到的地方。
addEventListener("resize", () => {
  if (panelDx || panelDy) movePanel(panelDx, panelDy);
});
settingsEl.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("[data-close]")) closeSettings();
});
