/**
 * Just enough terminal grammar to render a run pane's output as a readable log.
 *
 * The phone has no terminal emulator, and a dev server's output is mostly
 * plain lines with colour codes, spinners, and the occasional cursor move. We
 * resolve those rather than print them: escape sequences are dropped, and a
 * carriage return rewrites the current line the way a real terminal would, so
 * progress bars collapse to their final state instead of stacking up.
 *
 * Full-screen TUIs (an agent's own interface) are not the target here — those
 * are read in Term view on the desktop.
 */

// ESC, built without a backslash escape so no build or transport step can
// mangle it.
const ESC = String.fromCharCode(27);

const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const OSC = new RegExp(`${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\)`, "g");
const CHARSET = new RegExp(`${ESC}[()#][0-9A-Za-z]`, "g");
const SHORT = new RegExp(`${ESC}[=>78McDEHM]`, "g");
// Control bytes that would otherwise render as tofu boxes. Tab, newline and
// carriage return are deliberately kept.
const CONTROL = new RegExp(
  "[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]",
  "g",
);

export function stripAnsi(text) {
  return text
    .replace(CSI, "")
    .replace(OSC, "")
    .replace(CHARSET, "")
    .replace(SHORT, "")
    .replace(CONTROL, "");
}

/**
 * Apply carriage returns within a line: each `\r` returns the cursor to the
 * start, so later text overwrites earlier text character by character and the
 * tail of a longer previous line stays visible.
 */
export function foldCarriageReturns(line) {
  if (!line.includes("\r")) return line;
  let out = "";
  for (const part of line.split("\r")) {
    out = part.length >= out.length ? part : part + out.slice(part.length);
  }
  return out;
}
