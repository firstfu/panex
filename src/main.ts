import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resolveLang, setLang, getLang, t as tr, translateDom, type LangPref } from "./i18n";
import { getCurrentWindow, Effect, LogicalSize } from "@tauri-apps/api/window";
import { IS_MAC } from "./platform";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ACTIONS,
  GROUPS,
  digitFamily,
  eventCombo,
  formatBinding,
  formatCombo,
  isDefault,
  resolveBindings,
  toConfigValue,
  type ActionDef,
  type Steps,
} from "./keys";

type Status = "idle" | "running" | "attention" | "done";

interface SavedTab {
  id: string;
  shell: string;
  cwd?: string | null;
  title?: string | null;
  agentSession?: string | null;
}

interface SavedWorkspace {
  id: string;
  title?: string | null;
  color?: string | null;
  tabs: SavedTab[];
  active?: string | null;
}

interface Session {
  workspaces: SavedWorkspace[];
  active?: string | null;
}

interface ShellInfo {
  id: string;
  name: string;
}

interface AgentNotify {
  pane: string;
  event: string;
  message?: string;
  notificationType?: string | null;
  sessionId?: string | null;
}

// Flat view of panex.json (~/.config/panex/panex.json); CONFIG_PATHS maps each field to its key.
interface Settings {
  opacity: number; // 30–100 (%)
  effect: "none" | "mica" | "acrylic";
  fontSize: number;
  fontFamily: string;
  defaultShell: string;
  cursorBlink: boolean;
  scrollback: number;
  smartCopyPaste: boolean;
  sidebarHidden: boolean;
  modifierHints: boolean;
  language: LangPref;
  resumeSession: boolean;
  askEnableHooks: boolean; // offer to enable the Claude Code hooks at startup while they're off
  windowWidth: number; // size the window opens at (logical px)
  windowHeight: number;
}

const CONFIG_PATHS: Record<keyof Settings, string[]> = {
  opacity: ["app", "opacity"],
  effect: ["app", "windowEffect"],
  fontSize: ["terminal", "fontSize"],
  fontFamily: ["terminal", "fontFamily"],
  defaultShell: ["terminal", "defaultShell"],
  cursorBlink: ["terminal", "cursorBlink"],
  scrollback: ["terminal", "scrollback"],
  smartCopyPaste: ["terminal", "smartCopyPaste"],
  sidebarHidden: ["sidebar", "hidden"],
  modifierHints: ["shortcuts", "showModifierHoldHints"],
  language: ["app", "language"],
  resumeSession: ["agent", "resumeSession"],
  askEnableHooks: ["agent", "askToEnableHooks"],
  windowWidth: ["app", "windowWidth"],
  windowHeight: ["app", "windowHeight"],
};

interface LoadedConfig {
  config: any;
  error?: string | null;
  path: string;
}

/** One terminal: a horizontal tab inside a workspace. */
interface Tab {
  id: string;
  wsId: string;
  shell: string;
  cwd?: string;
  branch?: string; // git branch of cwd (not persisted; re-read from .git/HEAD)
  branchAt?: number; // last refresh time, throttles the per-prompt lookup
  customTitle?: string;
  progTitle?: string;
  term: Terminal;
  fit: FitAddon;
  serializer: SerializeAddon;
  webgl?: WebglAddon;
  el: HTMLDivElement;
  opened: boolean; // xterm attached to the DOM (done lazily on first view)
  running: boolean; // a shell process is attached
  exited: boolean; // shell ended with an error; Enter restarts it
  dirty: boolean; // output since the last scrollback snapshot
  status: Status;
  note?: string;
  initialInput?: string; // typed into the shell once, right after it starts (worktree setup command)
  agentSession?: string; // last Claude Code session id seen here (persisted); offered for resume
  agentLive?: boolean; // Claude Code is running in this tab right now (cleared at the next shell prompt)
}

/** A sidebar entry (cmux's workspace) holding one or more tabs. */
interface Workspace {
  id: string;
  customTitle?: string;
  color?: string;
  tabs: string[];
  activeTab?: string;
}

const DEFAULTS: Settings = {
  opacity: 100,
  effect: "none",
  fontSize: 14,
  // Per platform: a missing font makes xterm measure cells wider than the glyphs it draws.
  fontFamily: IS_MAC ? "ui-monospace, Menlo, 'PingFang TC', monospace" : "'Cascadia Mono', Consolas, 'Microsoft JhengHei', monospace",
  defaultShell: "cmd",
  cursorBlink: false,
  scrollback: 3000,
  smartCopyPaste: true,
  sidebarHidden: false,
  modifierHints: false,
  language: "auto",
  resumeSession: true,
  askEnableHooks: true,
  // Keep in sync with config.rs DEFAULT_WINDOW and tauri.conf.json.
  windowWidth: 1400,
  windowHeight: 820,
};

// Same palette names as cmux's workspace colors.
const COLORS: Record<string, string> = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  green: "#22c55e",
  teal: "#14b8a6",
  blue: "#3b82f6",
  purple: "#a855f7",
  pink: "#ec4899",
};

// Loudest first: a workspace shows the most urgent state among its tabs.
const STATUS_RANK: Record<Status, number> = { attention: 3, done: 2, running: 1, idle: 0 };

const SNAPSHOT_DELAY_MS = 4000;
const SNAPSHOT_LINES = 1000;
const isWindows = navigator.userAgent.includes("Windows");

const tabs = new Map<string, Tab>();
const workspaces = new Map<string, Workspace>();
const wsOrder: string[] = [];
let activeWsId: string | undefined;
let visibleTabId: string | undefined;
let settings: Settings = { ...DEFAULTS };
let rawConfig: any = {};
let configPath = "";
let configError: string | undefined;
let bindings = resolveBindings(undefined);
let chord: { steps: string[]; timer: number } | undefined;
let capturingId: string | undefined;
let capturingAlt = 0; // which alternative is being recorded; equal to the count means "adding one"
let focused = document.hasFocus();
let shells: ShellInfo[] = [];
let winBuild = 0;
let snapshotTimer: number | undefined;
let sessionTimer: number | undefined;
const writeTimers = new Map<string, number>();
let writesInFlight = 0;
let renderQueued = false;
let renaming: { kind: "ws" | "tab"; id: string } | undefined;
let drag: { kind: "ws" | "tab"; id: string } | undefined;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const termsEl = $("terms");
const wsListEl = $("tabs");
const tabbarEl = $("tabbar");
const shellMenuEl = $("shell-menu");
const hooksEl = $("hooks-row");
const resumeBarEl = $("resume-bar");
const ctxEl = $("ctx");
const settingsEl = $("settings");
const wtEl = $("wt");
const askEl = $("hooks-ask");

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const newWsId = () => `w${newId().slice(0, 11)}`;
const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const shellName = (id: string) => tr(shells.find((s) => s.id === id)?.name ?? id);
const shellTag = (id: string) => (id === "cmd" ? "cmd" : id === "default" ? "sh" : "PS");
const activeTab = () => (visibleTabId ? tabs.get(visibleTabId) : undefined);
const activeWs = () => (activeWsId ? workspaces.get(activeWsId) : undefined);
const wsActiveTab = (ws: Workspace) => tabs.get(ws.activeTab ?? "") ?? tabs.get(ws.tabs[0] ?? "");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/**
 * A TUI (Claude Code) pads its screen with blank rows to park the input box at the bottom. Those rows
 * only make sense while it runs; replayed as history they become a big gap, so cap blank runs at 2.
 */
const squeezeBlankRuns = (snapshot: string) => snapshot.replace(/(?:[ \t]*\r?\n){4,}/g, "\n\n\n");

function autoTabTitle(tab: Tab): string {
  const t = tab.progTitle?.trim();
  // Shells set their title to an exe path or their own name; a cwd is more useful there.
  if (t && !/^[A-Za-z]:\\/.test(t) && !/\.exe$/i.test(t) && !/^(Windows PowerShell|PowerShell|系統管理員|Administrator)/.test(t)) {
    return t;
  }
  return tab.cwd ? basename(tab.cwd) : shellName(tab.shell);
}

const tabTitle = (tab: Tab) => tab.customTitle || autoTabTitle(tab);

function wsTitle(ws: Workspace): string {
  if (ws.customTitle) return ws.customTitle;
  const t = wsActiveTab(ws);
  return t ? tabTitle(t) : tr("工作區");
}

/** The loudest status among a workspace's tabs, with that tab's note. */
function wsStatus(ws: Workspace): { status: Status; note?: string } {
  let best: Tab | undefined;
  for (const id of ws.tabs) {
    const t = tabs.get(id);
    if (t && (!best || STATUS_RANK[t.status] > STATUS_RANK[best.status])) best = t;
  }
  return { status: best?.status ?? "idle", note: best?.note };
}

// ── Settings ────────────────────────────────────────────────────────────────

function termTheme() {
  // Fully transparent: #terms paints the background so opacity applies once.
  return { background: "#00000000", foreground: "#e4e4e7", cursor: "#e4e4e7", selectionBackground: "#3f3f4699" };
}

let appliedEffect: Settings["effect"] | undefined;
/** Switches the UI language; static markup is retranslated, dynamic parts re-render. */
function applyLanguage() {
  const next = resolveLang(settings.language);
  if (next === getLang()) return;
  setLang(next);
  translateDom();
  renderShellMenu();
  refreshHooks();
  renderConfigNotice();
  scheduleRender();
  if (!settingsEl.hidden) fillSettings();
}

function applySettings() {
  applyLanguage();
  // Effects need some transparency to show; Mica/Acrylic look best around 70–85%.
  document.documentElement.style.setProperty("--alpha", String(settings.opacity / 100));
  document.body.classList.toggle("no-sidebar", settings.sidebarHidden);
  document.body.classList.toggle("no-hints", !settings.modifierHints);
  if (appliedEffect !== settings.effect) {
    appliedEffect = settings.effect;
    const win = getCurrentWindow();
    if (settings.effect === "none") win.clearEffects().catch(() => {});
    else win.setEffects({ effects: [settings.effect === "mica" ? Effect.Mica : Effect.Acrylic] }).catch(() => {});
  }
  for (const tab of tabs.values()) {
    tab.term.options.fontSize = settings.fontSize;
    tab.term.options.fontFamily = settings.fontFamily;
    tab.term.options.cursorBlink = settings.cursorBlink;
  }
  const tab = activeTab();
  if (tab?.opened) tab.fit.fit();
}

const getPath = (obj: any, path: string[]) => path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

function settingsFrom(cfg: any): Settings {
  const s = { ...DEFAULTS } as any;
  for (const [field, path] of Object.entries(CONFIG_PATHS)) {
    const v = getPath(cfg, path);
    if (v !== undefined && typeof v === typeof (DEFAULTS as any)[field]) s[field] = v;
  }
  s.opacity = Math.min(100, Math.max(30, s.opacity));
  s.fontSize = Math.min(32, Math.max(8, s.fontSize));
  s.windowWidth = Math.min(10000, Math.max(480, Math.round(s.windowWidth)));
  s.windowHeight = Math.min(10000, Math.max(300, Math.round(s.windowHeight)));
  if (!["none", "mica", "acrylic"].includes(s.effect)) s.effect = "none";
  if (!["auto", "en", "zh-Hant"].includes(s.language)) s.language = "auto";
  return s;
}

/** Applies a freshly loaded panex.json (startup, live reload). A broken file keeps the last good settings. */
function applyConfig(loaded: LoadedConfig) {
  configPath = loaded.path;
  configError = loaded.error ?? undefined;
  if (!configError) {
    rawConfig = loaded.config ?? {};
    settings = settingsFrom(rawConfig);
    if (shells.length && !shells.some((s) => s.id === settings.defaultShell)) settings.defaultShell = shells[0].id;
    bindings = resolveBindings(rawConfig.shortcuts?.bindings);
    applySettings();
    scheduleRender();
  }
  renderConfigNotice();
  if (!settingsEl.hidden && !capturingId) openSettings();
}

/** Writes one key to panex.json (debounced per key); the watcher then reloads it. */
function writeConfig(path: string[], value: unknown) {
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

function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  applySettings();
  for (const [field, value] of Object.entries(patch) as [keyof Settings, unknown][]) {
    // Writing the default removes the key, keeping panex.json down to what the user changed.
    writeConfig(CONFIG_PATHS[field], value === DEFAULTS[field] ? null : value);
  }
}

/** Replaces all of an action's alternatives; undefined = back to the default (remove the override). */
function setBinding(id: string, alts: Steps[] | undefined) {
  const overrides = { ...(rawConfig.shortcuts?.bindings ?? {}) };
  const toDefault = alts === undefined || isDefault(id, alts);
  if (toDefault) delete overrides[id];
  else overrides[id] = toConfigValue(alts);
  rawConfig = { ...rawConfig, shortcuts: { ...(rawConfig.shortcuts ?? {}), bindings: overrides } };
  bindings = resolveBindings(overrides);
  writeConfig(["shortcuts", "bindings", id], toDefault ? null : toConfigValue(alts));
  scheduleRender();
}

/** "Ctrl+3" for digit-family actions, from their first single-combo alternative. */
function digitHint(id: string, n: number): string {
  const one = (bindings.get(id) ?? []).find((s) => s.length === 1 && s[0].endsWith("1"));
  return one ? formatCombo(one[0].slice(0, -1) + n) : "";
}

const keyLabel = (id: string) => formatBinding(bindings.get(id) ?? [], ACTIONS.find((a) => a.id === id)?.digits);
const withKey = (text: string, id: string) => (keyLabel(id) ? `${tr(text)}（${keyLabel(id)}）` : tr(text));

function showNotice(text: string, withOpen = false) {
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

function setFontSize(n: number) {
  updateSettings({ fontSize: Math.min(32, Math.max(8, n)) });
}

// ── Session ─────────────────────────────────────────────────────────────────

function sessionData(): Session {
  return {
    active: activeWsId ?? null,
    workspaces: wsOrder.map((wid) => {
      const ws = workspaces.get(wid)!;
      return {
        id: ws.id,
        title: ws.customTitle ?? null,
        color: ws.color ?? null,
        active: ws.activeTab ?? null,
        tabs: ws.tabs.map((tid) => {
          const t = tabs.get(tid)!;
          return { id: t.id, shell: t.shell, cwd: t.cwd ?? null, title: t.customTitle ?? null, agentSession: t.agentSession ?? null };
        }),
      };
    }),
  };
}

/** Saves the layout now (structural changes); cwd updates go through saveSessionSoon. */
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = undefined;
  return invoke("session_save", { session: sessionData() }).catch(() => {});
}

function saveSessionSoon() {
  sessionTimer ??= window.setTimeout(saveSession, 500);
}

// ── Terminals ───────────────────────────────────────────────────────────────

function createTab(meta: SavedTab, wsId: string, restored?: string): Tab {
  const term = new Terminal({
    allowProposedApi: true,
    allowTransparency: true,
    scrollback: settings.scrollback,
    cursorBlink: settings.cursorBlink,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    theme: termTheme(),
    windowsPty: isWindows ? { backend: "conpty", buildNumber: winBuild } : undefined,
  });
  const fit = new FitAddon();
  const serializer = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(serializer);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  const el = document.createElement("div");
  el.className = "term";
  el.hidden = true;
  termsEl.appendChild(el);

  const tab: Tab = {
    id: meta.id,
    wsId,
    shell: meta.shell,
    cwd: meta.cwd ?? undefined,
    customTitle: meta.title ?? undefined,
    agentSession: validSessionId(meta.agentSession) ? meta.agentSession : undefined,
    term,
    fit,
    serializer,
    el,
    opened: false,
    running: false,
    exited: false,
    dirty: false,
    status: "idle",
  };

  refreshBranch(tab);

  if (restored) {
    term.write(squeezeBlankRuns(restored), () => {
      // The snapshot leaves the cursor wherever the program had it (TUIs park it mid-screen),
      // so move below the last non-empty line before printing the marker.
      const b = term.buffer.active;
      let last = b.length - 1;
      while (last > 0 && !b.getLine(last)?.translateToString(true).trim()) last--;
      const row = Math.max(1, last - b.baseY + 1);
      const time = new Date().toLocaleString("zh-TW", { hour12: false });
      term.write(`\x1b[0m\x1b[?25h\x1b[${row};1H\r\n\x1b[90m${tr("── 已還原工作階段（{time}）──", { time })}\x1b[0m\r\n`);
    });
  }

  term.onData((d) => onInput(tab, d));
  term.onResize(({ cols, rows }) => {
    if (tab.running) invoke("pty_resize", { id: tab.id, cols, rows }).catch(() => {});
  });
  term.onTitleChange((t) => {
    tab.progTitle = t;
    scheduleRender();
  });
  term.onBell(() => notify(tab, "attention", tr("🔔 響鈴")));
  // OSC 9;9;<path> = cwd report (our cmd/PowerShell prompts emit it).
  // Other OSC 9 payloads are iTerm2-style notifications; "N;..." forms are ConEmu extras we ignore.
  term.parser.registerOscHandler(9, (data) => {
    if (data.startsWith("9;")) setCwd(tab, data.slice(2).replace(/^"|"$/g, ""));
    else if (!/^\d+;/.test(data)) notify(tab, "attention", data);
    return true;
  });
  // OSC 7 = file://host/path cwd report (Unix shells).
  term.parser.registerOscHandler(7, (data) => {
    try {
      let p = decodeURIComponent(new URL(data).pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      setCwd(tab, p);
    } catch {}
    return true;
  });
  // OSC 777;notify;title;body (urxvt / Ghostty style).
  term.parser.registerOscHandler(777, (data) => {
    const [kind, title, body] = data.split(";");
    if (kind === "notify") notify(tab, "attention", body || title || "");
    return true;
  });

  tabs.set(tab.id, tab);
  return tab;
}

// ── Resume Claude Code ──────────────────────────────────────────────────────

/** The id ends up typed into a shell, so accept only what a Claude Code session id looks like. */
function validSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9A-Za-z-]{8,64}$/.test(id);
}

function canResume(tab: Tab) {
  return settings.resumeSession && !!tab.agentSession && !tab.agentLive;
}

function resumeAgent(tab: Tab) {
  if (!tab.agentSession || tab.agentLive) return;
  const cmd = `claude --resume ${tab.agentSession}`;
  tab.agentLive = true;
  showTab(tab.id);
  if (tab.running) {
    invoke("pty_write", { id: tab.id, data: `${cmd}\r` }).catch(() => {});
  } else {
    tab.exited = false;
    tab.initialInput = cmd;
    spawn(tab);
  }
  scheduleRender();
}

function dismissResume(tab: Tab) {
  tab.agentSession = undefined;
  saveSession();
  scheduleRender();
  tab.term.focus();
}

function onInput(tab: Tab, data: string) {
  if (tab.running) {
    invoke("pty_write", { id: tab.id, data }).catch(() => {});
  } else if (tab.exited && data === "\r") {
    tab.exited = false;
    spawn(tab);
  }
}

async function spawn(tab: Tab) {
  const onData = new Channel<ArrayBuffer>();
  onData.onmessage = (buf) => {
    tab.term.write(new Uint8Array(buf));
    markDirty(tab);
  };
  // Set before the call: ConPTY asks for the cursor position right away and
  // xterm's answer must reach the shell, or the console waits forever.
  tab.running = true;
  try {
    await invoke("pty_spawn", {
      id: tab.id,
      shell: tab.shell,
      cwd: tab.cwd ?? null,
      cols: tab.term.cols,
      rows: tab.term.rows,
      onData,
    });
    if (tab.initialInput) {
      // The pty queues input until the shell starts reading, so no need to wait for the prompt.
      invoke("pty_write", { id: tab.id, data: `${tab.initialInput}\r` }).catch(() => {});
      tab.initialInput = undefined;
    }
  } catch (e) {
    tab.running = false;
    tab.exited = true;
    tab.term.write(`\r\n\x1b[31m${tr("無法啟動 {shell}：{e}", { shell: shellName(tab.shell), e: String(e) })}\x1b[0m\r\n`);
  }
}

function markDirty(tab: Tab) {
  tab.dirty = true;
  // Only armed while output is flowing; an idle app runs no timers.
  snapshotTimer ??= window.setTimeout(() => {
    snapshotTimer = undefined;
    flushSnapshots();
  }, SNAPSHOT_DELAY_MS);
}

function flushSnapshots() {
  const jobs: Promise<unknown>[] = [];
  for (const tab of tabs.values()) {
    if (!tab.dirty) continue;
    tab.dirty = false;
    const data = tab.serializer.serialize({ scrollback: SNAPSHOT_LINES, excludeAltBuffer: true, excludeModes: true });
    jobs.push(invoke("scrollback_save", { id: tab.id, data }).catch(() => {}));
  }
  return Promise.all(jobs);
}

function attachWebgl(tab: Tab) {
  if (tab.webgl) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      tab.webgl = undefined;
    });
    tab.term.loadAddon(webgl);
    tab.webgl = webgl;
  } catch {
    // No WebGL: xterm falls back to its DOM renderer.
  }
}

function disposeTab(tab: Tab) {
  tab.webgl?.dispose();
  tab.term.dispose();
  tab.el.remove();
  tabs.delete(tab.id);
  if (visibleTabId === tab.id) visibleTabId = undefined;
  if (renaming?.id === tab.id) renaming = undefined;
}

// ── Navigation ──────────────────────────────────────────────────────────────

/** Shows a tab (switching workspace if needed). Only the visible tab keeps a WebGL context. */
function showTab(id: string) {
  const tab = tabs.get(id);
  const ws = tab && workspaces.get(tab.wsId);
  if (!tab || !ws) return;
  if (visibleTabId && visibleTabId !== id) {
    const prev = tabs.get(visibleTabId);
    if (prev) {
      prev.el.hidden = true;
      // Browsers cap live WebGL contexts (~16); only the visible tab keeps one.
      prev.webgl?.dispose();
      prev.webgl = undefined;
    }
  }
  visibleTabId = id;
  activeWsId = ws.id;
  ws.activeTab = id;
  tab.el.hidden = false;
  if (!tab.opened) {
    tab.term.open(tab.el);
    tab.opened = true;
  }
  attachWebgl(tab);
  tab.fit.fit();
  // Restored tabs start their shell only when first viewed.
  if (!tab.running && !tab.exited) spawn(tab);
  if (!renaming) tab.term.focus();
  if (focused) clearStatus(tab);
  saveSession();
  scheduleRender();
}

function showWorkspace(wsId: string) {
  const ws = workspaces.get(wsId);
  const tab = ws && wsActiveTab(ws);
  if (tab) showTab(tab.id);
}

function newWorkspace(shell = settings.defaultShell) {
  const ws: Workspace = { id: newWsId(), tabs: [] };
  workspaces.set(ws.id, ws);
  wsOrder.push(ws.id);
  const tab = createTab({ id: newId(), shell, cwd: activeTab()?.cwd }, ws.id);
  ws.tabs.push(tab.id);
  showTab(tab.id);
}

// ── New worktree ────────────────────────────────────────────────────────────

const wtBranchEl = $<HTMLInputElement>("wt-branch");
const wtBaseEl = $<HTMLInputElement>("wt-base");
const wtErrEl = $("wt-err");
const wtOkEl = $<HTMLButtonElement>("wt-ok");
let wtCwd: string | undefined;

function openWorktreeDialog() {
  const tab = activeTab();
  wtCwd = tab?.cwd;
  hideCtx();
  wtBranchEl.value = "";
  wtBaseEl.value = tab?.branch ?? "";
  wtErrEl.textContent = wtCwd && tab?.branch ? "" : tr("目前的工作目錄不在 git repo 裡");
  wtOkEl.disabled = false;
  wtEl.hidden = false;
  wtBranchEl.focus();
  // Existing branches as suggestions for both fields; typing a new name still works.
  $("wt-branches").replaceChildren();
  if (wtCwd) {
    invoke<string[]>("git_branches", { cwd: wtCwd })
      .then((list) => $("wt-branches").replaceChildren(...list.map((b) => Object.assign(document.createElement("option"), { value: b }))))
      .catch(() => {});
  }
}

function closeWorktreeDialog() {
  wtEl.hidden = true;
  activeTab()?.term.focus();
}

async function createWorktree() {
  const branch = wtBranchEl.value.trim();
  if (!wtCwd || !branch) return;
  wtOkEl.disabled = true;
  wtErrEl.textContent = "";
  const copyFiles = Array.isArray(rawConfig.worktree?.copyFiles) ? rawConfig.worktree.copyFiles : [".env", ".env.local"];
  try {
    const wt = await invoke<{ path: string; copied: string[] }>("git_worktree_add", {
      cwd: wtCwd,
      branch,
      base: wtBaseEl.value.trim() || null,
      copyFiles,
    });
    wtEl.hidden = true;
    const ws: Workspace = { id: newWsId(), tabs: [], customTitle: branch };
    workspaces.set(ws.id, ws);
    wsOrder.push(ws.id);
    const tab = createTab({ id: newId(), shell: settings.defaultShell, cwd: wt.path }, ws.id);
    const setup = rawConfig.worktree?.setupCommand;
    if (typeof setup === "string" && setup.trim()) tab.initialInput = setup.trim();
    if (wt.copied.length) tab.term.write(`\x1b[90m${tr("已複製：{files}", { files: wt.copied.join(", ") })}\x1b[0m\r\n`);
    ws.tabs.push(tab.id);
    showTab(tab.id);
  } catch (e) {
    wtErrEl.textContent = String(e);
    wtOkEl.disabled = false;
  }
}

$("wt-cancel").onclick = closeWorktreeDialog;
wtEl.addEventListener("mousedown", (e) => e.target === wtEl && closeWorktreeDialog());
wtEl.querySelector("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  createWorktree();
});
wtEl.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") closeWorktreeDialog();
});

/** New tab in the current workspace, right after the visible one, in the same folder. */
function newTab(shell = settings.defaultShell) {
  const ws = activeWs();
  if (!ws) return newWorkspace(shell);
  const cur = activeTab();
  const tab = createTab({ id: newId(), shell, cwd: cur?.cwd }, ws.id);
  const at = cur ? ws.tabs.indexOf(cur.id) + 1 : ws.tabs.length;
  ws.tabs.splice(at, 0, tab.id);
  showTab(tab.id);
}

/** Closes tabs; a workspace left empty goes too, and the last workspace is replaced by a fresh one. */
function closeTabs(ids: string[]) {
  const gone = ids.map((id) => tabs.get(id)).filter((t): t is Tab => !!t);
  if (!gone.length) return;
  const wasVisible = visibleTabId;
  const visibleWs = activeWsId;
  const visibleWsIndex = visibleWs ? wsOrder.indexOf(visibleWs) : 0;
  let visibleTabIndex = 0;
  for (const tab of gone) {
    const ws = workspaces.get(tab.wsId)!;
    const i = ws.tabs.indexOf(tab.id);
    if (tab.id === wasVisible) visibleTabIndex = i;
    ws.tabs.splice(i, 1);
    if (ws.activeTab === tab.id) ws.activeTab = ws.tabs[Math.min(i, ws.tabs.length - 1)];
    disposeTab(tab);
    if (!ws.tabs.length) {
      workspaces.delete(ws.id);
      wsOrder.splice(wsOrder.indexOf(ws.id), 1);
      if (renaming?.id === ws.id) renaming = undefined;
    }
  }
  // Save the layout without these tabs before the backend deletes their scrollback,
  // so a snapshot that is still in flight can't write the file back.
  if (!visibleTabId) {
    const ws = visibleWs && workspaces.get(visibleWs);
    if (ws) showTab(ws.tabs[Math.min(visibleTabIndex, ws.tabs.length - 1)]);
    else if (wsOrder.length) showWorkspace(wsOrder[Math.min(visibleWsIndex, wsOrder.length - 1)]);
    else {
      activeWsId = undefined;
      newWorkspace();
    }
  } else {
    saveSession();
  }
  for (const tab of gone) invoke("tab_close", { id: tab.id }).catch(() => {});
  scheduleRender();
}

const closeTab = (id: string) => closeTabs([id]);
const closeWorkspaces = (ids: string[]) => closeTabs(ids.flatMap((id) => workspaces.get(id)?.tabs ?? []));

function cycleWorkspace(dir: number) {
  if (!activeWsId || wsOrder.length < 2) return;
  const i = wsOrder.indexOf(activeWsId);
  showWorkspace(wsOrder[(i + dir + wsOrder.length) % wsOrder.length]);
}

function cycleTab(dir: number) {
  const ws = activeWs();
  if (!ws || !visibleTabId || ws.tabs.length < 2) return;
  const i = ws.tabs.indexOf(visibleTabId);
  showTab(ws.tabs[(i + dir + ws.tabs.length) % ws.tabs.length]);
}

/** 1–8 pick that item, 9 always the last one (cmux / browser convention). */
const nth = <T,>(list: T[], n: number) => (n === 9 ? list[list.length - 1] : list[n - 1]);

function moveIn(list: string[], id: string, to: number) {
  const from = list.indexOf(id);
  to = Math.max(0, Math.min(list.length - 1, to));
  if (from < 0 || from === to) return false;
  list.splice(from, 1);
  list.splice(to, 0, id);
  saveSession();
  scheduleRender();
  return true;
}

const moveWorkspace = (id: string, to: number) => moveIn(wsOrder, id, to);
function moveTab(id: string, to: number) {
  const ws = workspaces.get(tabs.get(id)?.wsId ?? "");
  if (ws) moveIn(ws.tabs, id, to);
}

function jumpToUnread() {
  const all = wsOrder.flatMap((w) => workspaces.get(w)!.tabs.map((t) => tabs.get(t)!));
  const t = all.find((t) => t.status === "attention") ?? all.find((t) => t.status === "done");
  if (t) showTab(t.id);
}

function setColor(ws: Workspace, color?: string) {
  ws.color = color;
  saveSession();
  scheduleRender();
}

function setCwd(tab: Tab, cwd: string) {
  if (!cwd) return;
  // A shell prompt means Claude Code has exited; its session can be offered for resume.
  if (tab.agentLive) {
    tab.agentLive = false;
    scheduleRender();
  }
  // Every prompt reports the cwd, so this also catches `git checkout` in place.
  refreshBranch(tab, cwd);
  if (cwd === tab.cwd) return;
  tab.cwd = cwd;
  saveSessionSoon();
  scheduleRender();
}

function refreshBranch(tab: Tab, cwd = tab.cwd) {
  if (!cwd) return;
  const now = Date.now();
  if (cwd === tab.cwd && tab.branchAt && now - tab.branchAt < 1000) return;
  tab.branchAt = now;
  invoke<string | null>("git_branch", { cwd })
    .then((b) => {
      const branch = b ?? undefined;
      if (branch === tab.branch) return;
      tab.branch = branch;
      scheduleRender();
    })
    .catch(() => {});
}

function clearStatus(tab: Tab) {
  if (tab.status === "attention" || tab.status === "done") {
    tab.status = "idle";
    tab.note = undefined;
    scheduleRender();
  }
}

function notify(tab: Tab, status: Status, note: string) {
  if (status === "running") {
    tab.status = "running";
    tab.note = undefined;
    scheduleRender();
    return;
  }
  // The user is already looking at this tab: no badge, no toast.
  if (focused && tab.id === visibleTabId) {
    if (status === "done") {
      tab.status = "idle";
      tab.note = undefined;
      scheduleRender();
    }
    return;
  }
  tab.status = status;
  tab.note = note;
  scheduleRender();
  const ws = workspaces.get(tab.wsId);
  const where = ws && ws.tabs.length > 1 ? `${wsTitle(ws)} › ${tabTitle(tab)}` : tabTitle(tab);
  if (!focused) invoke("alert", { title: `panex · ${where}`, body: note }).catch(() => {});
}

// ── Rename ──────────────────────────────────────────────────────────────────

function startRename(kind: "ws" | "tab", id: string) {
  const target = kind === "ws" ? workspaces.get(id) : tabs.get(id);
  if (!target) return;
  hideCtx();
  if (kind === "tab") showTab(id);
  else if (activeWsId !== id) showWorkspace(id);
  renaming = { kind, id };
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
    renaming = undefined;
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

// ── Rendering ───────────────────────────────────────────────────────────────

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

const renameInput = '<input class="rename-input" maxlength="80" spellcheck="false" />';

function render() {
  // Re-rendering would destroy the rename field; render again when it closes.
  if (renaming && document.querySelector(".rename-input")) return;
  renderSidebar();
  renderTabbar();
  const cur = activeTab();
  resumeBarEl.hidden = !(cur && cur.id === visibleTabId && canResume(cur));
}

function renderSidebar() {
  wsListEl.replaceChildren(
    ...wsOrder.map((wid, i) => {
      const ws = workspaces.get(wid)!;
      const cur = wsActiveTab(ws);
      const { status, note } = wsStatus(ws);
      const d = document.createElement("div");
      d.className = `tab ws st-${status}${wid === activeWsId ? " active" : ""}`;
      d.dataset.ws = wid;
      const num = i < 8 ? i + 1 : i === wsOrder.length - 1 ? 9 : 0;
      const hint = num ? digitHint("selectWorkspaceByNumber", num) : "";
      const dot = ws.color ? `<span class="t-dot" style="background:${COLORS[ws.color] ?? ws.color}"></span>` : "";
      const resumable = ws.tabs.find((tid) => {
        const t = tabs.get(tid);
        return t && canResume(t);
      });
      const resume = resumable ? `<span class="t-resume" data-resume="${resumable}" title="${esc(tr("恢復上次的 Claude Code session"))}">↻</span>` : "";
      const count = ws.tabs.length > 1 ? `<span class="t-count" title="${esc(tr("{n} 個分頁", { n: ws.tabs.length }))}">${ws.tabs.length}</span>` : "";
      const title =
        renaming?.kind === "ws" && renaming.id === wid
          ? renameInput
          : `${dot}<span class="name">${esc(wsTitle(ws))}</span>${resume}${count}${hint ? `<span class="t-num">${hint}</span>` : ""}`;
      d.innerHTML =
        `<div class="t-title">${title}</div>` +
        (cur ? `<div class="t-meta"><span class="t-shell">${shellTag(cur.shell)}</span>${esc(cur.cwd ?? "")}</div>` : "") +
        (cur?.branch ? `<div class="t-branch" title="git branch">⎇ ${esc(cur.branch)}</div>` : "") +
        (note ? `<div class="t-note">${esc(note)}</div>` : "") +
        `<button class="t-close" title="${esc(withKey("關閉工作區", "closeWorkspace"))}">×</button>`;
      return d;
    }),
  );
}

function renderTabbar() {
  const ws = activeWs();
  if (!ws) return tabbarEl.replaceChildren();
  const items = ws.tabs.map((tid, i) => {
    const t = tabs.get(tid)!;
    const d = document.createElement("div");
    d.className = `htab st-${t.status}${tid === visibleTabId ? " active" : ""}`;
    d.dataset.tab = tid;
    if (t.note) d.title = t.note;
    const num = i < 8 ? i + 1 : i === ws.tabs.length - 1 ? 9 : 0;
    const hint = num ? digitHint("selectTabByNumber", num) : "";
    d.innerHTML =
      renaming?.kind === "tab" && renaming.id === tid
        ? renameInput
        : `<span class="h-dot"></span><span class="h-name">${esc(tabTitle(t))}</span>` +
          (hint ? `<span class="t-num">${hint}</span>` : "") +
          `<button class="h-close" title="${esc(withKey("關閉分頁", "closeTab"))}">×</button>`;
    return d;
  });
  const add = document.createElement("button");
  add.className = "h-add";
  add.textContent = "＋";
  add.title = withKey("新分頁", "newTab");
  tabbarEl.replaceChildren(...items, add);
}

function renderShellMenu() {
  shellMenuEl.replaceChildren(
    ...shells.map((s, i) => {
      const b = document.createElement("button");
      const hint = i < 9 ? digitHint("newWorkspaceWithShell", i + 1) : "";
      b.textContent = `${tr(s.name)}${hint ? `　${hint}` : ""}`;
      b.onclick = () => {
        shellMenuEl.hidden = true;
        newWorkspace(s.id);
      };
      return b;
    }),
  );
  $("new-tab").title = withKey("新工作區", "newWorkspace");
  $("sidebar-toggle").title = withKey("顯示 / 隱藏側欄", "toggleSidebar");
}

/** Updates the sidebar's hook status line; resolves to whether the hooks are installed. */
async function refreshHooks(): Promise<boolean> {
  const ok = await invoke<boolean>("hooks_status").catch(() => false);
  hooksEl.textContent = ok ? tr("Claude Code 通知：已啟用") : tr("Claude Code 通知：未啟用");
  if (!ok) {
    const b = document.createElement("button");
    b.textContent = tr("啟用");
    b.title = tr("在 ~/.claude/settings.json 加入 panex 的 hooks（會先備份）");
    b.onclick = async () => {
      try {
        await invoke("hooks_install");
      } catch (e) {
        hooksEl.textContent = tr("啟用失敗：{e}", { e: String(e) });
        return;
      }
      refreshHooks();
    };
    hooksEl.appendChild(b);
  }
  return ok;
}

// Startup prompt for the hooks (without them there are no badges and no resume). Writing
// ~/.claude/settings.json still only happens on the user's click.
function closeHooksAsk() {
  askEl.hidden = true;
  activeTab()?.term.focus();
}
$("hooks-ask-ok").onclick = async () => {
  try {
    await invoke("hooks_install");
  } catch (e) {
    $("hooks-ask-err").textContent = tr("啟用失敗：{e}", { e: String(e) });
    return;
  }
  closeHooksAsk();
  refreshHooks();
};
$("hooks-ask-later").onclick = closeHooksAsk;
$("hooks-ask-never").onclick = () => {
  updateSettings({ askEnableHooks: false });
  closeHooksAsk();
};
askEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHooksAsk();
});

// ── Context menus ───────────────────────────────────────────────────────────

type MenuItem = { label: string; keys?: string; run: () => void; disabled?: boolean } | "-" | { colors: Workspace };

function wsMenu(ws: Workspace): MenuItem[] {
  const i = wsOrder.indexOf(ws.id);
  const others = wsOrder.filter((id) => id !== ws.id);
  return [
    { label: tr("重新命名工作區…"), keys: keyLabel("renameWorkspace"), run: () => startRename("ws", ws.id) },
    { colors: ws },
    "-",
    { label: tr("新分頁"), keys: keyLabel("newTab"), run: () => (showWorkspace(ws.id), newTab()) },
    { label: tr("用新 worktree 開新工作區…"), keys: keyLabel("newWorktree"), run: () => (showWorkspace(ws.id), openWorktreeDialog()) },
    "-",
    { label: tr("上移"), keys: keyLabel("moveWorkspaceUp"), run: () => moveWorkspace(ws.id, i - 1), disabled: i === 0 },
    { label: tr("下移"), keys: keyLabel("moveWorkspaceDown"), run: () => moveWorkspace(ws.id, i + 1), disabled: i === wsOrder.length - 1 },
    { label: tr("移到最上面"), run: () => moveWorkspace(ws.id, 0), disabled: i === 0 },
    "-",
    { label: tr("關閉工作區"), keys: keyLabel("closeWorkspace"), run: () => closeWorkspaces([ws.id]) },
    { label: tr("關閉其他工作區"), run: () => closeWorkspaces(others), disabled: !others.length },
    { label: tr("關閉下方工作區"), run: () => closeWorkspaces(wsOrder.slice(i + 1)), disabled: i === wsOrder.length - 1 },
    { label: tr("關閉上方工作區"), run: () => closeWorkspaces(wsOrder.slice(0, i)), disabled: i === 0 },
  ];
}

function tabMenu(tab: Tab): MenuItem[] {
  const ws = workspaces.get(tab.wsId)!;
  const i = ws.tabs.indexOf(tab.id);
  const others = ws.tabs.filter((id) => id !== tab.id);
  return [
    { label: tr("重新命名分頁…"), keys: keyLabel("renameTab"), run: () => startRename("tab", tab.id) },
    "-",
    { label: tr("左移"), keys: keyLabel("moveTabLeft"), run: () => moveTab(tab.id, i - 1), disabled: i === 0 },
    { label: tr("右移"), keys: keyLabel("moveTabRight"), run: () => moveTab(tab.id, i + 1), disabled: i === ws.tabs.length - 1 },
    "-",
    { label: tr("關閉分頁"), keys: keyLabel("closeTab"), run: () => closeTab(tab.id) },
    { label: tr("關閉其他分頁"), run: () => closeTabs(others), disabled: !others.length },
    { label: tr("關閉右側分頁"), run: () => closeTabs(ws.tabs.slice(i + 1)), disabled: i === ws.tabs.length - 1 },
  ];
}

function showCtx(x: number, y: number, items: MenuItem[]) {
  ctxEl.replaceChildren(
    ...items.map((it) => {
      if (it === "-") return document.createElement("hr");
      if ("colors" in it) {
        const ws = it.colors;
        const row = document.createElement("div");
        row.className = "colors";
        const none = document.createElement("span");
        none.className = `none${ws.color ? "" : " sel"}`;
        none.title = tr("無顏色");
        none.onclick = () => (setColor(ws, undefined), hideCtx());
        row.append(
          none,
          ...Object.entries(COLORS).map(([name, hex]) => {
            const s = document.createElement("span");
            s.style.background = hex;
            s.title = name;
            if (ws.color === name) s.className = "sel";
            s.onclick = () => (setColor(ws, name), hideCtx());
            return s;
          }),
        );
        return row;
      }
      const d = document.createElement("div");
      d.className = `item${it.disabled ? " disabled" : ""}`;
      d.innerHTML = `<span>${esc(it.label)}</span>${it.keys ? `<kbd>${esc(it.keys)}</kbd>` : ""}`;
      d.onclick = () => {
        hideCtx();
        it.run();
      };
      return d;
    }),
  );
  ctxEl.hidden = false;
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  ctxEl.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
}

function hideCtx() {
  ctxEl.hidden = true;
}

// ── Settings panel ──────────────────────────────────────────────────────────

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
let settingsPage = "look";

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
  const overrides = rawConfig.shortcuts?.bindings ?? {};
  const q = $<HTMLInputElement>("keys-filter").value.trim().toLowerCase();
  const matches = (label: string, alts: Steps[], digits?: boolean) =>
    !q || label.toLowerCase().includes(q) || formatBinding(alts, digits).toLowerCase().includes(q);

  const groups = GROUPS.map((g) => {
    const rows = ACTIONS.filter((a) => a.group === g && matches(tr(a.label), bindings.get(a.id) ?? [], a.digits)).map((a) => {
      const alts = bindings.get(a.id) ?? [];
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

function showSettingsPage(page: string) {
  settingsPage = page;
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

function fillSettings() {
  const o = $<HTMLInputElement>("s-opacity");
  o.value = String(settings.opacity);
  o.style.setProperty("--p", `${((settings.opacity - 30) / 70) * 100}%`);
  $("s-opacity-v").textContent = `${settings.opacity}%`;
  setSeg("s-effect", settings.effect);
  setSeg("s-language", settings.language);
  $<HTMLInputElement>("s-font-size").value = String(settings.fontSize);
  const ff = $<HTMLInputElement>("s-font-family");
  if (document.activeElement !== ff) ff.value = settings.fontFamily;
  const sample = $("font-sample");
  sample.style.fontFamily = settings.fontFamily;
  sample.style.fontSize = `${settings.fontSize}px`;
  $("s-shell").innerHTML = shells.map((s) => `<button data-v="${s.id}" role="radio">${esc(tr(s.name))}</button>`).join("");
  setSeg("s-shell", settings.defaultShell);
  $<HTMLInputElement>("s-blink").checked = settings.cursorBlink;
  $<HTMLInputElement>("s-smart").checked = settings.smartCopyPaste;
  $<HTMLInputElement>("s-hints").checked = settings.modifierHints;
  $<HTMLInputElement>("s-resume").checked = settings.resumeSession;
  $<HTMLInputElement>("s-scrollback").value = String(settings.scrollback);
  $<HTMLInputElement>("s-win-w").value = String(settings.windowWidth);
  $<HTMLInputElement>("s-win-h").value = String(settings.windowHeight);
  $("cfg-path").textContent = configPath;
  renderKeys();
}

function openSettings() {
  hideCtx();
  fillSettings();
  showSettingsPage(settingsPage);
  const wasHidden = settingsEl.hidden;
  settingsEl.hidden = false;
  if (wasHidden) settingsEl.querySelector<HTMLElement>(".s-tab.on")?.focus();
}

function closeSettings() {
  capturingId = undefined;
  keysNote = "";
  settingsEl.hidden = true;
  activeTab()?.term.focus();
}

/** Handles a key press while a shortcut row is waiting for its new combo. */
function captureKey(e: KeyboardEvent) {
  const id = capturingId!;
  const def = ACTIONS.find((a) => a.id === id)!;
  const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  if (e.key === "Escape" && plain) {
    capturingId = undefined;
    keysNote = "";
    return renderKeys();
  }
  const alts = bindings.get(id) ?? [];
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
  if (!/^(ctrl|alt|meta)\+/.test(combo) && !/^(shift\+)?f\d+$/.test(combo)) {
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
    const theirs = bindings.get(a.id) ?? [];
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
    setBinding(id, (bindings.get(id) ?? []).filter((_, i) => i !== +removeEl.dataset.alt!));
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
    capturingAlt = (bindings.get(add) ?? []).length;
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
  rawConfig = { ...rawConfig, shortcuts: { ...(rawConfig.shortcuts ?? {}), bindings: {} } };
  bindings = resolveBindings({});
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
  updateSettings({ effect: v, opacity: v !== "none" && settings.opacity === 100 ? 80 : settings.opacity });
  fillSettings();
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
    setFontSize(settings.fontSize + +b.dataset.step!);
    fillSettings();
  };
});
$<HTMLInputElement>("s-font-size").onchange = (e) => {
  setFontSize(+(e.target as HTMLInputElement).value || DEFAULTS.fontSize);
  fillSettings();
};
$<HTMLInputElement>("s-font-family").oninput = (e) => {
  // Live preview while typing; saved when the field loses focus.
  $("font-sample").style.fontFamily = (e.target as HTMLInputElement).value || DEFAULTS.fontFamily;
};
$<HTMLInputElement>("s-font-family").onchange = (e) =>
  updateSettings({ fontFamily: (e.target as HTMLInputElement).value.trim() || DEFAULTS.fontFamily });
$<HTMLInputElement>("s-blink").onchange = (e) => updateSettings({ cursorBlink: (e.target as HTMLInputElement).checked });
$<HTMLInputElement>("s-resume").onchange = (e) => {
  updateSettings({ resumeSession: (e.target as HTMLInputElement).checked });
  scheduleRender();
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
  getCurrentWindow().setSize(new LogicalSize(settings.windowWidth, settings.windowHeight)).catch(() => {});
}
$<HTMLInputElement>("s-win-w").onchange = (e) => setWindowSize(+(e.target as HTMLInputElement).value || DEFAULTS.windowWidth, settings.windowHeight);
$<HTMLInputElement>("s-win-h").onchange = (e) => setWindowSize(settings.windowWidth, +(e.target as HTMLInputElement).value || DEFAULTS.windowHeight);
$("s-win-current").onclick = async () => {
  const win = getCurrentWindow();
  const size = (await win.innerSize()).toLogical(await win.scaleFactor());
  updateSettings({ windowWidth: Math.round(size.width), windowHeight: Math.round(size.height) });
  fillSettings();
};
settingsEl.addEventListener("mousedown", (e) => {
  if (e.target === settingsEl) closeSettings();
});
settingsEl.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("[data-close]")) closeSettings();
});

// ── Keyboard & mouse ────────────────────────────────────────────────────────

function stop(e: KeyboardEvent, fn: () => void) {
  e.preventDefault();
  e.stopPropagation();
  fn();
}

function copySelection(tab?: Tab) {
  if (!tab?.term.hasSelection()) return;
  navigator.clipboard.writeText(tab.term.getSelection()).catch(() => {});
  tab.term.clearSelection();
}

async function paste(tab?: Tab) {
  const text = await navigator.clipboard.readText().catch(() => "");
  if (text && tab) tab.term.paste(text);
}

/** Runs an action by id; `digit` is the 1–9 pressed for digit-family actions. */
function runAction(id: string, digit = 0) {
  const tab = activeTab();
  const ws = activeWs();
  const wi = activeWsId ? wsOrder.indexOf(activeWsId) : -1;
  const ti = ws && visibleTabId ? ws.tabs.indexOf(visibleTabId) : -1;
  switch (id) {
    case "newWorkspace": return newWorkspace();
    case "newWorkspaceWithShell": return shells[digit - 1] && newWorkspace(shells[digit - 1].id);
    case "newWorktree": return openWorktreeDialog();
    case "closeWorkspace": return activeWsId && closeWorkspaces([activeWsId]);
    case "renameWorkspace": return activeWsId && startRename("ws", activeWsId);
    case "selectWorkspaceByNumber": { const w = nth(wsOrder, digit); return w && showWorkspace(w); }
    case "nextWorkspace": return cycleWorkspace(1);
    case "prevWorkspace": return cycleWorkspace(-1);
    case "moveWorkspaceUp": return activeWsId && moveWorkspace(activeWsId, wi - 1);
    case "moveWorkspaceDown": return activeWsId && moveWorkspace(activeWsId, wi + 1);
    case "jumpToUnread": return jumpToUnread();
    case "newTab": return newTab();
    case "closeTab": return visibleTabId && closeTab(visibleTabId);
    case "renameTab": return visibleTabId && startRename("tab", visibleTabId);
    case "selectTabByNumber": { const t = ws && nth(ws.tabs, digit); return t && showTab(t); }
    case "nextTab": return cycleTab(1);
    case "prevTab": return cycleTab(-1);
    case "moveTabLeft": return visibleTabId && moveTab(visibleTabId, ti - 1);
    case "moveTabRight": return visibleTabId && moveTab(visibleTabId, ti + 1);
    case "toggleSidebar": return updateSettings({ sidebarHidden: !settings.sidebarHidden });
    case "clearScrollback": return tab?.term.clear();
    case "copy": return copySelection(tab);
    case "paste": return paste(tab);
    case "increaseFontSize": return setFontSize(settings.fontSize + 1);
    case "decreaseFontSize": return setFontSize(settings.fontSize - 1);
    case "resetFontSize": return updateSettings({ fontSize: DEFAULTS.fontSize });
    case "openSettings": return settingsEl.hidden ? openSettings() : closeSettings();
    case "openConfigFile": return invoke("config_open").catch((e) => showNotice(String(e)));
    case "reloadConfiguration": return invoke<LoadedConfig>("config_load").then(applyConfig);
  }
}

/** Finds the action for a combo: exact single-combo bindings, digit families, then chord starts. */
function matchCombo(combo: string, step: number, prefix: string[]): { id: string; digit: number; partial: boolean } | undefined {
  const fam = digitFamily(combo);
  for (const a of ACTIONS) {
    for (const steps of bindings.get(a.id) ?? []) {
      if (steps.length <= step || prefix.some((p, k) => steps[k] !== p)) continue;
      const want = steps[step];
      const hit = want === combo ? 0 : a.digits && fam && want === fam.family ? fam.digit : -1;
      if (hit < 0) continue;
      return { id: a.id, digit: hit, partial: steps.length > step + 1 };
    }
  }
}

// The modifiers of the default digit shortcuts (workspaces Ctrl/⌘+1–9, tabs Alt/⌥+1–9).
const HINT_KEY = IS_MAC ? "Meta" : "Control";

// Capture phase, so app shortcuts win over xterm.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === HINT_KEY || e.key === "Alt") document.body.classList.add("show-nums");
    if (renaming || !wtEl.hidden || !askEl.hidden) return;
    if (capturingId) return stop(e, () => captureKey(e));
    const combo = eventCombo(e);
    if (!settingsEl.hidden || !ctxEl.hidden) {
      if (e.key === "Escape") return stop(e, () => (hideCtx(), closeSettings()));
      // Inside the settings panel only its own toggle works; typing goes to the form fields.
      if (combo && bindings.get("openSettings")?.some((s) => s.length === 1 && s[0] === combo)) stop(e, closeSettings);
      return;
    }
    if (!combo) return;

    const prefix = chord?.steps ?? [];
    const m = matchCombo(combo, prefix.length, prefix);
    if (chord) {
      clearTimeout(chord.timer);
      chord = undefined;
    }
    if (m?.partial) {
      // First key(s) of a chord: wait up to 1.5 s for the next one.
      return stop(e, () => (chord = { steps: [...prefix, combo], timer: window.setTimeout(() => (chord = undefined), 1500) }));
    }
    if (m) return stop(e, () => runAction(m.id, m.digit));
    if (prefix.length) return stop(e, () => {}); // wrong second key: swallow it, like VS Code

    // macOS copies and pastes with ⌘, so Ctrl+C / Ctrl+V always belong to the terminal there.
    if (IS_MAC) return;
    const tab = activeTab();
    if (settings.smartCopyPaste && combo === "ctrl+c" && tab?.term.hasSelection()) return stop(e, () => copySelection(tab));
    // Keep xterm from sending ^V; the browser then fires a paste event that xterm handles.
    if (settings.smartCopyPaste && combo === "ctrl+v") return e.stopPropagation();
  },
  true,
);
document.addEventListener("keyup", (e) => {
  if (e.key === HINT_KEY || e.key === "Alt") document.body.classList.remove("show-nums");
});
window.addEventListener("blur", () => document.body.classList.remove("show-nums"));

// Ctrl+wheel (⌘+wheel on macOS) zooms like a browser / Windows Terminal.
termsEl.addEventListener(
  "wheel",
  (e) => {
    if (!(IS_MAC ? e.metaKey : e.ctrlKey)) return;
    e.preventDefault();
    e.stopPropagation();
    setFontSize(settings.fontSize + (e.deltaY < 0 ? 1 : -1));
  },
  { capture: true, passive: false },
);

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const t = e.target as HTMLElement;
  const ws = workspaces.get(t.closest<HTMLElement>("[data-ws]")?.dataset.ws ?? "");
  const tab = tabs.get(t.closest<HTMLElement>("[data-tab]")?.dataset.tab ?? "");
  if (ws) showCtx(e.clientX, e.clientY, wsMenu(ws));
  else if (tab) showCtx(e.clientX, e.clientY, tabMenu(tab));
  else hideCtx();
});
document.addEventListener("mousedown", (e) => {
  if (!ctxEl.hidden && !ctxEl.contains(e.target as Node)) hideCtx();
});

// Double-click is detected by hand: the first click re-renders the list, and a native
// dblclick doesn't fire when its target was replaced between the two clicks.
let lastClick = { id: "", at: 0 };
function isDoubleClick(id: string) {
  const now = performance.now();
  const dbl = lastClick.id === id && now - lastClick.at < 450;
  lastClick = dbl ? { id: "", at: 0 } : { id, at: now };
  return dbl;
}

wsListEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest(".rename-input")) return;
  const id = target.closest<HTMLElement>("[data-ws]")?.dataset.ws;
  if (!id) return;
  if (target.closest(".t-close")) return closeWorkspaces([id]);
  const resumeId = target.closest<HTMLElement>(".t-resume")?.dataset.resume;
  const resumeTab = resumeId ? tabs.get(resumeId) : undefined;
  if (resumeTab) return resumeAgent(resumeTab);
  if (isDoubleClick(id)) return startRename("ws", id);
  showWorkspace(id);
});
tabbarEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest(".rename-input")) return;
  if (target.closest(".h-add")) return newTab();
  const id = target.closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (!id) return;
  if (target.closest(".h-close")) return closeTab(id);
  if (isDoubleClick(id)) return startRename("tab", id);
  showTab(id);
});
// Double-clicking the empty part of the tab bar opens a tab, like browsers.
tabbarEl.addEventListener("dblclick", (e) => {
  if (e.target === tabbarEl) newTab();
});
// Middle click closes, like browser tabs.
wsListEl.addEventListener("auxclick", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-ws]")?.dataset.ws;
  if (e.button === 1 && id) closeWorkspaces([id]);
});
tabbarEl.addEventListener("auxclick", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (e.button === 1 && id) closeTab(id);
});

// Drag to reorder: workspaces vertically in the sidebar, tabs horizontally in the bar.
// Pointer events rather than HTML5 drag-and-drop: the window must keep native file drop on
// (dragDropEnabled), and WebView2 then no longer delivers HTML5 drag events to the page.
function clearDropMarks() {
  document.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
}
function wireDrag(container: HTMLElement, kind: "ws" | "tab", attr: string, horizontal: boolean) {
  const itemOf = (t: EventTarget | null) => ((t as HTMLElement | null)?.closest?.(`[data-${attr}]`) as HTMLElement | null | undefined) ?? null;
  container.addEventListener("pointerdown", (e) => {
    const el = itemOf(e.target);
    const id = el?.dataset[attr];
    if (e.button !== 0 || !id || renaming || (e.target as HTMLElement).closest("input")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let target: { id: string; after: boolean } | undefined;

    const onMove = (m: PointerEvent) => {
      if (!drag) {
        if (Math.hypot(m.clientX - startX, m.clientY - startY) < 5) return;
        drag = { kind, id };
        document.body.classList.add("reordering");
        el!.classList.add("dragging");
      }
      clearDropMarks();
      target = undefined;
      const over = itemOf(document.elementFromPoint(m.clientX, m.clientY));
      const overId = over?.dataset[attr];
      if (!over || !overId || !container.contains(over)) return;
      const r = over.getBoundingClientRect();
      const after = horizontal ? m.clientX > r.left + r.width / 2 : m.clientY > r.top + r.height / 2;
      over.classList.add(after ? "drop-after" : "drop-before");
      target = { id: overId, after };
    };
    const end = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      if (!drag) return;
      const moved = drag;
      drag = undefined;
      document.body.classList.remove("reordering");
      clearDropMarks();
      // The release would otherwise count as a click and switch to the dragged item.
      const swallow = (c: Event) => c.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 100);
      const list = kind === "ws" ? wsOrder : workspaces.get(tabs.get(moved.id)?.wsId ?? "")?.tabs;
      if (target && list) {
        const from = list.indexOf(moved.id);
        let to = list.indexOf(target.id) + (target.after ? 1 : 0);
        if (from < to) to--;
        if (kind === "ws") moveWorkspace(moved.id, to);
        else moveTab(moved.id, to);
      }
      scheduleRender();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  });
}
// Files dragged in from Explorer: type their paths into the current terminal, quoted when they
// contain spaces (what Windows Terminal does). Goes through paste, so a program that asked for
// bracketed paste (Claude Code) sees one paste and can pick up image paths.
getCurrentWebview()
  .onDragDropEvent((e) => {
    const p = e.payload;
    document.body.classList.toggle("file-over", p.type === "over" || p.type === "enter");
    if (p.type !== "drop" || !p.paths.length) return;
    const tab = activeTab();
    if (!tab) return;
    tab.term.paste(p.paths.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(" ") + " ");
    tab.term.focus();
  })
  .catch(() => {});

wireDrag(wsListEl, "ws", "ws", false);
wireDrag(tabbarEl, "tab", "tab", true);

// Drag the sidebar's right edge to resize it; the width is a per-machine UI preference.
const SIDEBAR_W = { min: 160, max: 280, def: 220 };
const sidebarResizer = $("sidebar-resizer");
function setSidebarWidth(w: number, save = false) {
  const px = Math.round(Math.min(SIDEBAR_W.max, Math.max(SIDEBAR_W.min, w)));
  document.documentElement.style.setProperty("--sidebar-w", `${px}px`);
  if (save) {
    try { localStorage.setItem("panex.sidebarWidth", String(px)); } catch { /* storage unavailable */ }
  }
}
try {
  const saved = Number(localStorage.getItem("panex.sidebarWidth"));
  if (saved) setSidebarWidth(saved);
} catch { /* storage unavailable */ }
sidebarResizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  sidebarResizer.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing-sidebar");
});
sidebarResizer.addEventListener("pointermove", (e) => {
  if (sidebarResizer.hasPointerCapture(e.pointerId)) setSidebarWidth(e.clientX);
});
sidebarResizer.addEventListener("pointerup", (e) => {
  if (!sidebarResizer.hasPointerCapture(e.pointerId)) return;
  sidebarResizer.releasePointerCapture(e.pointerId);
  document.body.classList.remove("resizing-sidebar");
  setSidebarWidth($("sidebar").getBoundingClientRect().width, true);
});
sidebarResizer.addEventListener("dblclick", () => setSidebarWidth(SIDEBAR_W.def, true));

$("sidebar-toggle").onclick = () => updateSettings({ sidebarHidden: !settings.sidebarHidden });
$("new-tab").onclick = () => newWorkspace();
$("shell-menu-btn").onclick = () => (shellMenuEl.hidden = !shellMenuEl.hidden);
$("settings-btn").onclick = openSettings;
$("resume-go").onclick = () => {
  const tab = activeTab();
  if (tab) resumeAgent(tab);
};
$("resume-skip").onclick = () => {
  const tab = activeTab();
  if (tab) dismissResume(tab);
};

let resizeTimer: number | undefined;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const tab = activeTab();
    if (tab?.opened) tab.fit.fit();
  }, 30);
}).observe(termsEl);

async function detectWindowsBuild() {
  if (!isWindows) return;
  // Chromium reports platformVersion >= 13 on Windows 11 (build >= 22000). xterm only
  // needs to know whether ConPTY is new enough (>= 21376) to handle reflow itself.
  try {
    const ua = (navigator as any).userAgentData;
    const v = await ua?.getHighEntropyValues(["platformVersion"]);
    winBuild = parseInt(v?.platformVersion ?? "0", 10) >= 13 ? 22000 : 19041;
  } catch {
    winBuild = 19041;
  }
}

async function main() {
  document.body.classList.toggle("mac", IS_MAC);
  if (IS_MAC) translateDom(); // swaps Ctrl wording for ⌘ even when the language stays Chinese
  const win = getCurrentWindow();
  win.onFocusChanged(({ payload }) => {
    focused = payload;
    const tab = activeTab();
    if (focused && tab) clearStatus(tab);
  });
  // Final save before the window goes away; crashes rely on the periodic snapshots.
  win.onCloseRequested(async () => {
    clearTimeout(snapshotTimer);
    await Promise.all([flushSnapshots(), sessionTimer !== undefined ? saveSession() : undefined]);
  });

  listen<{ id: string; code: number }>("pty-exit", ({ payload }) => {
    const tab = tabs.get(payload.id);
    if (!tab) return;
    tab.running = false;
    if (tab.status === "running") tab.status = "idle";
    if (payload.code === 0) {
      closeTab(tab.id);
    } else {
      tab.exited = true;
      const close = keyLabel("closeTab");
      const closeHint = close ? tr("，{key} 關閉分頁", { key: close }) : "";
      tab.term.write(`\r\n\x1b[90m${tr("[程序已結束（代碼 {code}）。按 Enter 重新啟動{close}]", { code: payload.code, close: closeHint })}\x1b[0m\r\n`);
      scheduleRender();
    }
  });

  listen<AgentNotify>("agent-notify", ({ payload: p }) => {
    const tab = tabs.get(p.pane);
    if (!tab) return;
    if (validSessionId(p.sessionId)) {
      tab.agentLive = true;
      if (tab.agentSession !== p.sessionId) {
        tab.agentSession = p.sessionId;
        saveSessionSoon();
      }
      scheduleRender();
    }
    if (p.event === "UserPromptSubmit") notify(tab, "running", "");
    else if (p.event === "Stop") notify(tab, "done", p.message || tr("已完成"));
    else if (p.notificationType === "auth_success") return;
    else if (p.notificationType === "idle_prompt" && tab.status === "done") return;
    else notify(tab, "attention", p.message || tr("需要你的回應"));
  });

  listen<LoadedConfig>("config-changed", ({ payload }) => {
    // While our own writes are queued the file lags behind the UI (e.g. dragging the
    // opacity slider); the reload after the last write brings them back in step.
    if (writeTimers.size || writesInFlight) return;
    applyConfig(payload);
    renderShellMenu();
  });

  const [, loaded, shellList, session] = await Promise.all([
    detectWindowsBuild(),
    invoke<LoadedConfig>("config_load"),
    invoke<ShellInfo[]>("shells_list"),
    invoke<Session>("session_load"),
  ]);
  shells = shellList;
  applyConfig(loaded);
  renderShellMenu();
  refreshHooks().then((ok) => {
    if (ok || !settings.askEnableHooks) return;
    askEl.hidden = false;
    // Focus the panel, not "Enable": an Enter typed for the terminal must not write the user's
    // global Claude settings.
    askEl.querySelector<HTMLElement>(".wt-panel")!.focus();
  });

  const saved = (session.workspaces ?? []).filter((w) => w.tabs?.length);
  const restored = await Promise.all(
    saved.flatMap((w) => w.tabs).map((t) => invoke<string>("scrollback_load", { id: t.id }).catch(() => "")),
  );
  let k = 0;
  for (const sw of saved) {
    const ws: Workspace = { id: sw.id, customTitle: sw.title ?? undefined, color: sw.color ?? undefined, tabs: [] };
    workspaces.set(ws.id, ws);
    wsOrder.push(ws.id);
    for (const st of sw.tabs) ws.tabs.push(createTab(st, ws.id, restored[k++]).id);
    ws.activeTab = sw.active && ws.tabs.includes(sw.active) ? sw.active : ws.tabs[0];
  }

  await document.fonts.ready;
  const first = session.active && workspaces.has(session.active) ? session.active : wsOrder[0];
  if (first) showWorkspace(first);
  else newWorkspace();
}

if (import.meta.env.DEV) (window as any).__panex = { tabs, workspaces, wsOrder, showTab, newTab, newWorkspace, closeTab };

main();
