// Pure checks and text fixes, kept free of DOM/Tauri imports so `npm test` can load them in Node.

/** Mirrors ssh.rs `valid_target`: the target lands on ssh's command line. */
export const validSshTarget = (t: string) => /^[A-Za-z0-9@._:\[\]%-]{1,255}$/.test(t) && !t.startsWith("-");

/**
 * The id ends up typed into a shell after `claude --resume`, so accept only what a Claude Code
 * session id looks like; a leading "-" would turn it into another option.
 */
export function validSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/.test(id);
}

/**
 * A TUI (Claude Code) pads its screen with blank rows to park the input box at the bottom. Those rows
 * only make sense while it runs; replayed as history they become a big gap, so cap blank runs at 2.
 */
export const squeezeBlankRuns = (snapshot: string) => snapshot.replace(/(?:[ \t]*\r?\n){4,}/g, "\n\n\n");

/** dim（SGR 2）改畫成的灰色，約等於 xterm 把 #e4e4e7 淡化 50% 的結果。 */
const DIM_GRAY = "38;2;114;114;118";

/**
 * 把輸出裡的 SGR 2（dim）換成固定灰色前景、丟掉 SGR 3／23（斜體），回傳有狀態的過濾函式（每個終端機一個）。
 *
 * 為什麼：xterm 的 WebGL 渲染器在 allowTransparency 下，dim 與斜體文字的格子會多畫出黑色底塊
 * （Claude Code 的輸入提示用 dim，recap 用 dim＋斜體；2026-10-25 實機驗證純斜體也會）。
 * DOM 渲染器沒這問題，但太慢，所以在餵給 xterm 前改寫。
 * 代價：疊在彩色字上的 dim 會變灰，斜體全部變直體。
 *
 * 狀態：`dim` 記住目前的灰色是我們塞的，遇到 22 時補一個 39 還原前景；中途有人自己設了前景色
 * 就放棄還原（那個前景是對方要的）。`pending` 暫存尾端被切斷的跳脫序列，等下一塊再接。
 */
export function createDimFilter(): (chunk: string) => string {
  let dim = false;
  let pending = "";
  return (chunk) => {
    const text = pending + chunk;
    const cut = text.match(/\x1b(?:\[[0-9;:]*)?$/);
    pending = cut && cut[0].length <= 32 ? cut[0] : "";
    const body = pending ? text.slice(0, -pending.length) : text;
    return body.replace(/\x1b\[([0-9;:]*)m/g, (seq, raw: string) => {
      if (raw.includes(":")) return seq; // 子參數寫法不處理，原樣放行
      const out: string[] = [];
      const ps = raw === "" ? ["0"] : raw.split(";");
      for (let i = 0; i < ps.length; i++) {
        const n = Number(ps[i] || "0");
        if (n === 38 || n === 48 || n === 58) {
          // 擴充色：吃掉後面的 5;n 或 2;r;g;b，其中的 2 不是 dim
          const len = ps[i + 1] === "2" ? 5 : 3;
          out.push(...ps.slice(i, i + len));
          i += len - 1;
          if (n === 38) dim = false;
        } else if (n === 3 || n === 23) {
          continue; // 斜體整個丟掉
        } else if (n === 2) {
          out.push(DIM_GRAY);
          dim = true;
        } else if (n === 22) {
          out.push(dim ? "22;39" : "22");
          dim = false;
        } else {
          if (n === 0 || n === 39 || (n >= 30 && n <= 37) || (n >= 90 && n <= 97)) dim = false;
          out.push(ps[i]);
        }
      }
      // 參數全被丟光（例如只有 3）就整段不輸出，免得變成 \x1b[m 把屬性重設
      return out.length ? `\x1b[${out.join(";")}m` : "";
    });
  };
}
