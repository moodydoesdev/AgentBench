// Presentation helpers for scheduled prompts, shared by the desktop dialog
// and the phone sheet (kept dependency-free so the mobile bundle stays lean).

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function cadenceLabel(s) {
  const c = s.cadence ?? {};
  if (c.kind === "interval") {
    const m = c.everyMin ?? 60;
    return `every ${m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`}`;
  }
  if (c.kind === "weekdays") return `weekdays ${c.time}`;
  if (c.kind === "weekly")
    return `${(c.days ?? []).map((d) => DAY_LABELS[d - 1]).join(", ")} ${c.time}`;
  return `daily ${c.time}`;
}

export function fmtWhen(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

export function fmtNext(ms) {
  if (!ms) return "paused";
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins <= 0) return "due now";
  if (mins < 60) return `in ${mins}m`;
  if (mins < 60 * 48) return `in ${Math.round(mins / 60)}h`;
  return `in ${Math.round(mins / 60 / 24)}d`;
}

export function fmtDuration(run) {
  if (!run.endedAt) return "running";
  const s = Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

export const freshSchedule = (cwd) => ({
  id: "",
  name: "",
  cwd,
  prompt: "",
  cadence: { kind: "daily", time: "08:00", days: [1], everyMin: 60 },
  enabled: true,
  closePrevious: true,
});
