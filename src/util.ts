// Small helpers with no app state: DOM lookup, HTML escaping, ids, path and time formatting.

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Same palette names as cmux's workspace colors.
export const COLORS: Record<string, string> = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  green: "#22c55e",
  teal: "#14b8a6",
  blue: "#3b82f6",
  purple: "#a855f7",
  pink: "#ec4899",
};

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
export const newWsId = () => `w${newId().slice(0, 11)}`;
export const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** 83 s → "1:23", 4000 s → "1:06:40". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
