// Derive a full theme (themes.js vars shape) from the wallpaper: sample the
// image, find its dominant hue, and build a dark palette tinted with it.
// Bytes come through a Rust command because drawing asset:// images onto a
// canvas can taint it and block getImageData.
import { invoke } from "@tauri-apps/api/core";

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hslToTriple(h, s, l) {
  const hex = hslToHex(h, s, l);
  return `${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}`;
}

export async function themeVarsFromImage(path) {
  const b64 = await invoke("read_file_base64", { path });
  const ext = path.split(".").pop().toLowerCase();
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("could not decode image"));
    img.src = `data:${MIME[ext] ?? "image/png"};base64,${b64}`;
  });

  const N = 48;
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, N, N);
  const { data } = ctx.getImageData(0, 0, N, N);

  // Dominant hue: bucket every pixel's hue, weighted by saturation ×
  // brightness so vivid areas win over near-grey and near-black ones.
  const BUCKETS = 24;
  const weight = new Array(BUCKETS).fill(0);
  const hueSum = new Array(BUCKETS).fill(0);
  const satSum = new Array(BUCKETS).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (max === 0 || d === 0) continue;
    const s = d / max;
    let h;
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    const w = s * max;
    const bucket = Math.min(BUCKETS - 1, Math.floor((h / 360) * BUCKETS));
    weight[bucket] += w;
    hueSum[bucket] += h * w;
    satSum[bucket] += s * w;
  }

  let best = 0;
  for (let i = 1; i < BUCKETS; i++) if (weight[i] > weight[best]) best = i;
  // near-greyscale image: fall back to a neutral graphite-style hue
  const hue = weight[best] > 0 ? hueSum[best] / weight[best] : 220;
  const sat =
    weight[best] > 0
      ? Math.min(0.55, Math.max(0.15, satSum[best] / weight[best]))
      : 0.05;

  return {
    "--bg": hslToHex(hue, sat, 0.05),
    "--panel": hslToHex(hue, sat, 0.08),
    "--panel-head": hslToHex(hue, sat, 0.11),
    // lighter than predefined themes' borders — these sit over the
    // wallpaper, not a flat bg, and need more lift to read
    "--border": hslToHex(hue, sat * 0.8, 0.27),
    "--text": hslToHex(hue, Math.min(sat, 0.25), 0.88),
    "--text-dim": hslToHex(hue, Math.min(sat, 0.2), 0.52),
    "--green": "74, 222, 128",
    "--amber": "251, 191, 36",
    "--red": "248, 113, 113",
    "--blue": hslToTriple(hue, Math.max(sat, 0.55), 0.72),
    "--hilite": "255, 255, 255",
    "--theme-term-bg": hslToHex(hue, sat, 0.08),
    "--theme-term-fg": hslToHex(hue, Math.min(sat, 0.25), 0.88),
    "--theme-term-cursor": hslToHex(hue, Math.min(sat, 0.25), 0.88),
    "--theme-term-sel": hslToHex(hue, sat, 0.22),
  };
}
