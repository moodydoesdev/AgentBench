import { useCallback, useEffect, useState } from "react";
import { invoke } from "../lib/ipc";

// Titlebar glance at the Claude plan's weekly allowance: how much is left,
// with the 5-hour window and reset times on hover. The backend caches for a
// minute, so polling every minute costs at most one Anthropic call.

const REFRESH_MS = 60_000;

function resetsIn(iso) {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function line(label, w) {
  if (!w) return null;
  const used = Math.round(w.utilization ?? 0);
  const reset = resetsIn(w.resets_at);
  return `${label}: ${100 - used}% left (${used}% used)${reset ? ` · resets in ${reset}` : ""}`;
}

export default function UsageMeter() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    invoke("claude_usage")
      .then((v) => {
        setData(v);
        setError(null);
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const week = data?.seven_day;
  if (!week) {
    // nothing to show until the first answer; an error stays a quiet dash
    if (!error) return null;
    return (
      <button className="usage-meter usage-meter-err" title={error} onClick={load}>
        week —
      </button>
    );
  }

  const used = Math.max(0, Math.min(100, week.utilization ?? 0));
  const left = Math.round(100 - used);
  const tone = used >= 90 ? "hot" : used >= 70 ? "warm" : "ok";
  const title = [
    line("This week", week),
    line("Opus this week", data.seven_day_opus),
    line("Sonnet this week", data.seven_day_sonnet),
    line("5-hour session", data.five_hour),
    error && `Last refresh failed: ${error}`,
    "Click to refresh",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button className={`usage-meter usage-meter-${tone}`} title={title} onClick={load}>
      <span className="usage-meter-label">week</span>
      <span className="usage-meter-bar">
        <span style={{ width: `${left}%` }} />
      </span>
      <span className="usage-meter-pct">{left}% left</span>
    </button>
  );
}
