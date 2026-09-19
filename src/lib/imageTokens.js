// Inline image references, the way Claude Code's own composer does them:
// staging an image drops an "[Image #N]" token at the cursor, so the prose can
// point at a specific image ("see [Image #2]"). On send each token becomes the
// image's temp path, and the pty paste delivers every path as its own
// bracketed paste — Claude only turns a paste into an attached image when the
// paste is the path alone; "path + text" in one paste arrives as plain text.

// The temp files save_pasted_image / the gateway write. Paths never contain
// spaces, so \S+ is a safe terminator.
export const IMAGE_PATH_RE = /\S*agentbench-images[\\/]paste-\S+/g;
const TOKEN_RE = /\[Image #(\d+)\]/g;

// Claude Code wraps a large bracketed paste in <pasted_content id="N"> tags in
// the transcript record (the closing tag repeats the id attribute). The person
// never typed the tags — only the content between them.
export const PASTED_TAG_RE = /<\/?pasted_content\b[^>]*>\n?/g;

export const imageToken = (n) => `[Image #${n}]`;

/** Composer text + staged images ({ n, path }) → the text to paste. Tokens
 *  are swapped for their image's path in place; images the text no longer
 *  references (token deleted by hand) lead the message, as before. */
export function buildWire(text, images) {
  const byN = new Map(images.map((im) => [im.n, im.path]));
  const used = new Set();
  const body = text.replace(TOKEN_RE, (tok, n) => {
    const path = byN.get(Number(n));
    if (!path) return tok;
    used.add(Number(n));
    return path;
  });
  const lead = images.filter((im) => !used.has(im.n)).map((im) => im.path);
  return [...lead, body].filter(Boolean).join(" ");
}

/** Split wire text into bracketed-paste chunks, each image path on its own.
 *  Text around a path keeps its spacing so the prose reads as typed. */
export function pasteChunks(wire) {
  const chunks = [];
  let at = 0;
  for (const m of wire.matchAll(IMAGE_PATH_RE)) {
    if (m.index > at) chunks.push({ text: wire.slice(at, m.index), image: false });
    chunks.push({ text: m[0], image: true });
    at = m.index + m[0].length;
  }
  if (at < wire.length) chunks.push({ text: wire.slice(at), image: false });
  return chunks.length ? chunks : [{ text: wire, image: false }];
}

// Claude reads an image paste asynchronously before inserting its marker; the
// next chunk must wait or it can land ahead of the marker.
export const IMAGE_SETTLE_MS = 300;
export const CHUNK_GAP_MS = 40;

/** Comparable form of a prompt: no image paths, no markers (Claude renumbers
 *  them), no pasted_content wrappers (Claude adds them to a large paste),
 *  whitespace collapsed. Matches an echo against its transcript record or
 *  queue entry whichever way the images were rendered. */
export function promptKey(text) {
  return String(text ?? "")
    .replace(IMAGE_PATH_RE, " ")
    .replace(TOKEN_RE, " ")
    .replace(PASTED_TAG_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Marker numbers in order of appearance — labels for a record's images. */
export function tokenNumbers(text) {
  return [...String(text ?? "").matchAll(TOKEN_RE)].map((m) => Number(m[1]));
}
