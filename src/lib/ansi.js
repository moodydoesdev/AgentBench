// Minimal ANSI → styled segments for command output shown outside a terminal
// (chat tool cards). Handles SGR colour/bold/dim/italic/underline, including
// 256-colour and truecolour, applies carriage returns the way a terminal
// would (progress bars keep only their last frame), and drops every other
// escape sequence rather than printing it.

const BASIC = [
  "#1e1e1e", "#f87171", "#4ade80", "#facc15",
  "#60a5fa", "#c084fc", "#22d3ee", "#d4d4d4",
];
const BRIGHT = [
  "#737373", "#fca5a5", "#86efac", "#fde047",
  "#93c5fd", "#d8b4fe", "#67e8f9", "#ffffff",
];

function xterm256(n) {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const step = (v) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${step(Math.floor(i / 36))},${step(Math.floor(i / 6) % 6)},${step(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

function applySgr(style, params) {
  const codes = params.length ? params.split(";").map((p) => Number(p) || 0) : [0];
  const next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.keys(next).forEach((k) => delete next[k]);
    else if (c === 1) next.fontWeight = 600;
    else if (c === 2) next.opacity = 0.65;
    else if (c === 3) next.fontStyle = "italic";
    else if (c === 4) next.textDecoration = "underline";
    else if (c === 22) { delete next.fontWeight; delete next.opacity; }
    else if (c === 23) delete next.fontStyle;
    else if (c === 24) delete next.textDecoration;
    else if (c >= 30 && c <= 37) next.color = BASIC[c - 30];
    else if (c >= 90 && c <= 97) next.color = BRIGHT[c - 90];
    else if (c === 39) delete next.color;
    else if (c >= 40 && c <= 47) next.background = BASIC[c - 40];
    else if (c >= 100 && c <= 107) next.background = BRIGHT[c - 100];
    else if (c === 49) delete next.background;
    else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
      next[c === 38 ? "color" : "background"] = xterm256(codes[i + 2] ?? 0);
      i += 2;
    } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
      const [r, g, b] = codes.slice(i + 2, i + 5);
      next[c === 38 ? "color" : "background"] = `rgb(${r ?? 0},${g ?? 0},${b ?? 0})`;
      i += 4;
    }
  }
  return next;
}

// A line after its carriage returns: "10%\r50%\r100%" shows as "100%".
function collapseCr(line) {
  if (!line.includes("\r")) return line;
  const parts = line.split("\r").filter((p, i, all) => p !== "" || i === all.length - 1);
  return parts[parts.length - 1] ?? "";
}

/** Plain text with escapes removed — for measuring or copying. */
export function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/**
 * Split text into lines of { text, style } segments. Style objects are
 * React inline styles, or null for default text.
 */
export function ansiLines(text) {
  const lines = [];
  let style = {};
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = collapseCr(raw.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ""));
    const segs = [];
    const re = /\x1b\[([0-9;?]*)([ -/]*[@-~])/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last)
        segs.push({ text: line.slice(last, m.index), style: Object.keys(style).length ? style : null });
      if (m[2] === "m") style = applySgr(style, m[1]);
      last = re.lastIndex;
    }
    if (last < line.length)
      segs.push({
        text: line.slice(last).replace(/\x1b[@-Z\\-_]/g, ""),
        style: Object.keys(style).length ? style : null,
      });
    lines.push(segs);
  }
  return lines;
}
