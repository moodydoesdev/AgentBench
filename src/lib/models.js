// Model lists for the chat composer's picker and the team editor's
// suggestions — one place to touch when a new model ships.

// Model shortcuts Claude Code's `/model <name>` (and the stream-json
// set_model control request) accept. Fable and Opus 5.5 have no shortcut
// alias, so their entries carry the exact model id — /model and set_model
// take those too.
export const CLAUDE_MODELS = [
  { id: "default", label: "Default", desc: "recommended for daily use" },
  { id: "claude-fable-5", label: "Fable", desc: "most capable, deepest reasoning" },
  { id: "claude-opus-5-5", label: "Opus 5.5", desc: "great for complex work" },
  { id: "sonnet", label: "Sonnet", desc: "fast and smart" },
  { id: "sonnet[1m]", label: "Sonnet 1M", desc: "1M-token context" },
  { id: "haiku", label: "Haiku", desc: "fastest" },
  { id: "opusplan", label: "Opus Plan", desc: "Opus plans, Sonnet builds" },
];

// Codex CLI model slugs (from its own catalog): `/model <slug>` switches a
// live session directly on codex ≥ 0.153, and `-m <slug>` at launch.
export const CODEX_MODELS = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", desc: "frontier, most demanding work" },
  { id: "gpt-6-sol", label: "GPT-6 Sol", desc: "workhorse for everyday coding" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", desc: "fast and affordable" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", desc: "older, for complex work" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", desc: "older, balanced" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", desc: "older, fast" },
];

// The transcript and init records report full model ids ("claude-opus-5-5",
// "claude-3-5-haiku-20241022"); the picker's ids are shortcuts or undated
// ids. Map an observed id onto a picker id so the button and menu can show
// where the session actually is.
export function pickerIdFor(full, list) {
  if (!full) return null;
  if (list.some((m) => m.id === full)) return full;
  // a dated release of a full-id entry ("claude-opus-5-5-20260901")
  const dated = list.find((m) => m.id.includes("-") && full.startsWith(`${m.id}-`));
  if (dated) return dated.id;
  const fam = /^claude-(?:\d+(?:-\d+)*-)?(opus|sonnet|haiku|fable)/.exec(full)?.[1];
  return fam ?? full;
}
