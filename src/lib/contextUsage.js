// Context-window math for the broker's per-pane usage snapshots
// ({ context, input, cache_read, cache_create, output, model }). `context`
// is the prompt side of the session's last main-chain turn — what the next
// request will carry, i.e. how full the window is right now.

// Every current Claude model ships a 200k window. The 1M-context beta is
// invisible in transcript model ids, so a measurement past 200k is itself
// the evidence of a 1M session.
export function contextWindow(usage) {
  if (!usage?.context) return null;
  if (usage.model?.includes("[1m]") || usage.context > 200_000) return 1_000_000;
  return 200_000;
}

export function contextPercent(usage) {
  const window = contextWindow(usage);
  if (!window) return null;
  return Math.min(100, Math.round((usage.context / window) * 100));
}

export function fmtTokens(n) {
  if (n == null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
