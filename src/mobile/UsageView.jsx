// Token totals for the pane's session — the "what did that overnight run
// cost" glance. Summed from the transcript on the workstation; cost only
// exists when the harness recorded one (headless runs).
import { useEffect, useState } from "react";

function fmt(n) {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export default function UsageView({ transport, cwd, sid }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!sid) return;
    transport
      .invoke("session_stats", { project: cwd, sid })
      .then(setStats)
      .catch((e) => setError(String(e.message ?? e)));
  }, [cwd, sid]);

  if (!sid)
    return (
      <div className="mob-note" style={{ margin: 14 }}>
        This pane hasn't reported a session id (the broker on that machine may
        predate this build), so its usage can't be looked up.
      </div>
    );
  if (error) return <div className="mob-warn" style={{ margin: 14 }}>{error}</div>;
  if (!stats) return <div className="mob-note" style={{ margin: 14 }}>Adding it up…</div>;

  const rows = [
    ["Model", stats.model ?? "—"],
    ["Assistant turns", fmt(stats.turns)],
    ["Input tokens", fmt(stats.inputTokens)],
    ["Output tokens", fmt(stats.outputTokens)],
    ["Cache reads", fmt(stats.cacheReadTokens)],
    ["Cache writes", fmt(stats.cacheWriteTokens)],
  ];
  if (stats.costUsd != null) rows.push(["Reported cost", `$${stats.costUsd.toFixed(2)}`]);

  return (
    <div className="mob-usage">
      <div className="mob-card">
        {rows.map(([label, value]) => (
          <div key={label} className="mob-usage-row">
            <span>{label}</span>
            <span className="mob-mono">{value}</span>
          </div>
        ))}
      </div>
      <p className="mob-note">
        Counted from this session's transcript. Cache reads are heavily
        discounted, so tokens alone overstate cost.
      </p>
    </div>
  );
}
