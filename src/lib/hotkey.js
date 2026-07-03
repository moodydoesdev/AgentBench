// Hotkey strings look like "mod+shift+p". "mod" is ⌘ on macOS and Ctrl
// elsewhere so one default works everywhere.

const IS_MAC = navigator.userAgent.includes("Mac");

export function parseHotkey(str) {
  const parts = (str || "").toLowerCase().split("+").filter(Boolean);
  const combo = { meta: false, ctrl: false, alt: false, shift: false, key: "" };
  for (const p of parts) {
    if (p === "mod") combo[IS_MAC ? "meta" : "ctrl"] = true;
    else if (p === "meta" || p === "cmd") combo.meta = true;
    else if (p === "ctrl") combo.ctrl = true;
    else if (p === "alt") combo.alt = true;
    else if (p === "shift") combo.shift = true;
    else combo.key = p;
  }
  return combo;
}

export function matchesHotkey(e, str) {
  const c = parseHotkey(str);
  if (!c.key) return false;
  return (
    e.metaKey === c.meta &&
    e.ctrlKey === c.ctrl &&
    e.altKey === c.alt &&
    e.shiftKey === c.shift &&
    e.key.toLowerCase() === c.key
  );
}

// Build a storable hotkey string from a keydown event, or null if the
// event is only modifiers (still waiting for the real key).
export function hotkeyFromEvent(e) {
  const key = e.key.toLowerCase();
  if (["meta", "control", "alt", "shift"].includes(key)) return null;
  const parts = [];
  if (e.metaKey) parts.push("meta");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (parts.length === 0) return null; // bare keys would swallow typing
  parts.push(key);
  return parts.join("+");
}

const KEY_SYMBOLS = {
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "↵",
  escape: "⎋",
  " ": "Space",
};

export function formatHotkey(str) {
  const c = parseHotkey(str);
  const parts = [];
  if (c.ctrl) parts.push(KEY_SYMBOLS.ctrl);
  if (c.alt) parts.push(KEY_SYMBOLS.alt);
  if (c.shift) parts.push(KEY_SYMBOLS.shift);
  if (c.meta) parts.push(KEY_SYMBOLS.meta);
  parts.push(KEY_SYMBOLS[c.key] ?? c.key.toUpperCase());
  return parts.join("");
}
