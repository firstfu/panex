// panex.json at runtime: applying a loaded config (startup and live reload), writing single
// keys back (debounced), shortcut overrides, and the error banner when the file is broken.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, Effect } from "@tauri-apps/api/window";
import { resolveLang, setLang, getLang, translateDom, t as tr } from "./i18n";
import { ACTIONS, formatBinding, formatCombo, isDefault, resolveBindings, toConfigValue, type Steps } from "./keys";
import { type LoadedConfig } from "./types";
import { CONFIG_PATHS, DEFAULTS, settingsFrom, termFontFamily, type Settings } from "./settings";
import { esc } from "./util";
import { remeasureTab } from "./terminal";
import { S, activeTab, tabs } from "./state";
import { renderGitPanel } from "./git-panel";
import { refreshHooks, renderShellMenu, scheduleRender } from "./render";
import { fillSettings, isCapturing, openSettings, settingsEl } from "./settings-panel";
import { syncLiveMem } from "./mem";

let configError: string | undefined;
let emojiFontReq: Promise<void> | undefined;
const writeTimers = new Map<string, number>();
let writesInFlight = 0;

/** Our own writes are still queued or in flight, so the file on disk lags behind the UI. */
export const configWritesPending = () => writeTimers.size > 0 || writesInFlight > 0;

let appliedEffect: Settings["effect"] | undefined;
/** Switches the UI language; static markup is retranslated, dynamic parts re-render. */
function applyLanguage() {
  const next = resolveLang(S.settings.language);
  if (next === getLang()) return;
  setLang(next);
  translateDom();
  renderShellMenu();
  refreshHooks();
  renderConfigNotice();
  scheduleRender();
  renderGitPanel();
  if (!settingsEl.hidden) fillSettings();
}

function applySettings() {
  applyLanguage();
  // Effects need some transparency to show; Mica/Acrylic look best around 70–85%.
  document.documentElement.style.setProperty("--alpha", String(S.settings.opacity / 100));
  document.body.classList.toggle("no-sidebar", S.settings.sidebarHidden);
  document.body.classList.toggle("no-hints", !S.settings.modifierHints);
  if (appliedEffect !== S.settings.effect) {
    appliedEffect = S.settings.effect;
    const win = getCurrentWindow();
    if (S.settings.effect === "none") win.clearEffects().catch(() => {});
    else win.setEffects({ effects: [S.settings.effect === "mica" ? Effect.Mica : Effect.Acrylic] }).catch(() => {});
  }
  for (const tab of tabs.values()) {
    tab.term.options.fontSize = S.settings.fontSize;
    tab.term.options.fontFamily = termFontFamily(S.settings.fontFamily);
    tab.term.options.cursorBlink = S.settings.cursorBlink;
  }
  const tab = activeTab();
  if (tab?.opened) tab.fit.fit();
}

/** Applies a freshly loaded panex.json (startup, live reload). A broken file keeps the last good settings. */
export function applyConfig(loaded: LoadedConfig) {
  S.configPath = loaded.path;
  configError = loaded.error ?? undefined;
  if (!configError) {
    S.rawConfig = loaded.config ?? {};
    S.settings = settingsFrom(S.rawConfig);
    if (S.shells.length && !S.shells.some((s) => s.id === S.settings.defaultShell)) S.settings.defaultShell = S.shells[0].id;
    S.bindings = resolveBindings(S.rawConfig.shortcuts?.bindings);
    applySettings();
    syncLiveMem();
    scheduleRender();
  }
  renderConfigNotice();
  // The emoji face loads on first use, and xterm caches whatever glyph it drew before that.
  emojiFontReq ??= document.fonts
    .load(`16px "panex emoji"`, "⚠")
    .then(() => {
      tabs.forEach((t) => t.opened && t.term.clearTextureAtlas());
      const vis = activeTab();
      if (vis) remeasureTab(vis);
    })
    .catch(() => {});
  if (!settingsEl.hidden && !isCapturing()) openSettings();
}

/** Writes one key to panex.json (debounced per key); the watcher then reloads it. */
export function writeConfig(path: string[], value: unknown) {
  const key = path.join(".");
  clearTimeout(writeTimers.get(key));
  writeTimers.set(
    key,
    window.setTimeout(() => {
      writeTimers.delete(key);
      writesInFlight++;
      invoke("config_set", { path, value: value ?? null })
        .catch((e) => showNotice(String(e)))
        .finally(() => writesInFlight--);
    }, 250),
  );
}

/**
 * 不等 debounce、立刻把一個設定寫進 panex.json，寫完才 resolve。
 * 給接著要開分頁跑 panex-cli 讀這個設定的流程用：debounce 的 250ms 比 shell 啟動還慢，
 * 不等的話 panex-cli 會讀到舊值。
 * @param field 要寫的設定欄位
 * @param value 新值（等於預設值時會從 panex.json 移除，跟 updateSettings 一致）
 * @returns 寫檔完成的 Promise；寫入失敗時 reject（錯誤訊息同時顯示在橫幅上）
 */
export async function writeSettingNow<K extends keyof Settings>(field: K, value: Settings[K]) {
  S.settings = { ...S.settings, [field]: value };
  const path = CONFIG_PATHS[field];
  const key = path.join(".");
  // 取消同一個 key 還在排隊的 debounce 寫入，免得它晚一步用舊值蓋掉
  clearTimeout(writeTimers.get(key));
  writeTimers.delete(key);
  writesInFlight++;
  try {
    await invoke("config_set", { path, value: value === DEFAULTS[field] ? null : value });
  } catch (e) {
    showNotice(String(e));
    throw e;
  } finally {
    writesInFlight--;
  }
}

export function updateSettings(patch: Partial<Settings>) {
  S.settings = { ...S.settings, ...patch };
  applySettings();
  for (const [field, value] of Object.entries(patch) as [keyof Settings, unknown][]) {
    // Writing the default removes the key, keeping panex.json down to what the user changed.
    writeConfig(CONFIG_PATHS[field], value === DEFAULTS[field] ? null : value);
  }
}

/** Replaces all of an action's alternatives; undefined = back to the default (remove the override). */
export function setBinding(id: string, alts: Steps[] | undefined) {
  const overrides = { ...(S.rawConfig.shortcuts?.bindings ?? {}) };
  const toDefault = alts === undefined || isDefault(id, alts);
  if (toDefault) delete overrides[id];
  else overrides[id] = toConfigValue(alts);
  S.rawConfig = { ...S.rawConfig, shortcuts: { ...(S.rawConfig.shortcuts ?? {}), bindings: overrides } };
  S.bindings = resolveBindings(overrides);
  writeConfig(["shortcuts", "bindings", id], toDefault ? null : toConfigValue(alts));
  scheduleRender();
}

/** "Ctrl+3" for digit-family actions, from their first single-combo alternative. */
export function digitHint(id: string, n: number): string {
  const one = (S.bindings.get(id) ?? []).find((s) => s.length === 1 && s[0].endsWith("1"));
  return one ? formatCombo(one[0].slice(0, -1) + n) : "";
}

export const keyLabel = (id: string) => formatBinding(S.bindings.get(id) ?? [], ACTIONS.find((a) => a.id === id)?.digits);
export const withKey = (text: string, id: string) => (keyLabel(id) ? `${tr(text)}（${keyLabel(id)}）` : tr(text));

export function showNotice(text: string, withOpen = false) {
  let el = document.getElementById("notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "notice";
    document.body.appendChild(el);
  }
  el.innerHTML = `<span></span>${withOpen ? `<button data-open>${esc(tr("開啟 panex.json"))}</button>` : ""}<button data-dismiss>×</button>`;
  el.querySelector("span")!.textContent = text;
  el.hidden = false;
  el.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-open]")) invoke("config_open").catch(() => {});
    if (t.closest("[data-dismiss]")) el!.hidden = true;
  };
}

function renderConfigNotice() {
  if (configError) showNotice(tr("panex.json 有錯誤，沿用上次的設定：{e}", { e: configError }), true);
  else document.getElementById("notice")?.setAttribute("hidden", "");
}

export function setFontSize(n: number) {
  updateSettings({ fontSize: Math.min(32, Math.max(8, n)) });
}
