import { useCallback, useEffect, useState } from "react";
import Logo from "../components/Logo";

// bench.example/usage — the numbers Claude Code's /usage shows, for the
// Claude account logged in on this machine. Read by the gateway from
// Anthropic (GET /api/usage); needs only the device token, not the socket.

const WINDOWS = [
  ["five_hour", "Current session", "5-hour window"],
  ["seven_day", "Current week", "All models"],
  ["seven_day_opus", "Current week", "Opus only"],
  ["seven_day_sonnet", "Current week", "Sonnet only"],
];

const REFRESH_MS = 60_000;

function resetsIn(iso) {
  if (!iso) return null;
  const at = new Date(iso);
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const rel = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  const when = at.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Resets in ${rel} · ${when}`;
}

function Meter({ title, sub, pct, resets }) {
  const v = Math.max(0, Math.min(100, pct ?? 0));
  const tone = v >= 90 ? "hot" : v >= 70 ? "warm" : "ok";
  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span className="usage-title">{title}</span>
        <span className="usage-sub">{sub}</span>
        <span className="usage-pct">{Math.round(v)}%</span>
      </div>
      <div className={`usage-bar usage-${tone}`} role="meter" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${v}%` }} />
      </div>
      {resets && <div className="usage-reset">{resets}</div>}
    </div>
  );
}

export default function UsagePage({ token, onSignOut }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/usage", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) return onSignOut();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body);
      setError(null);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }, [token, onSignOut]);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const extra = data?.extra_usage;
  const plan = typeof data?.plan === "string" ? data.plan : null;

  return (
    <div className="usage-page">
      <div className="usage-card">
        <header className="usage-head">
          <Logo className="logo" width={120} />
          <div className="usage-head-text">
            <h1>Plan usage</h1>
            {plan && <span className="usage-plan">Claude {plan[0].toUpperCase() + plan.slice(1)}</span>}
          </div>
        </header>

        {error && <div className="usage-error">{error}</div>}
        {!data && !error && <div className="usage-reset">Loading…</div>}

        {data &&
          WINDOWS.filter(([k]) => data[k]).map(([k, title, sub]) => (
            <Meter
              key={k}
              title={title}
              sub={sub}
              pct={data[k].utilization}
              resets={resetsIn(data[k].resets_at)}
            />
          ))}

        {extra?.is_enabled && (
          <Meter
            title="Extra usage"
            sub={`${(extra.used_credits / 10 ** (extra.decimal_places ?? 2)).toFixed(2)} / ${(
              extra.monthly_limit / 10 ** (extra.decimal_places ?? 2)
            ).toFixed(2)} ${extra.currency ?? ""}`}
            pct={extra.utilization}
          />
        )}

        <footer className="usage-foot">
          <span>
            {data?.fetchedAt &&
              `Updated ${new Date(data.fetchedAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}`}
          </span>
          <button type="button" onClick={load} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
          <a href="/">Open bench</a>
        </footer>
      </div>
    </div>
  );
}
