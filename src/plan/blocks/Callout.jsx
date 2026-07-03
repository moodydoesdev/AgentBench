// Left accent bar note: bold bright lead flows into dim body text, tinted
// gradient fading left→right. `decision` is the violet tone used for
// settled strategy calls (themes have no purple token, so it's fixed).
const KINDS = {
  info: "var(--blue)",
  warn: "var(--amber)",
  danger: "var(--red)",
  success: "var(--green)",
  decision: "175, 130, 247",
};

export function Callout({ kind = "info", title, children }) {
  const t = KINDS[kind] ?? KINDS.info;
  return (
    <aside
      className="plan-callout"
      style={{
        borderLeftColor: `rgb(${t})`,
        background: `linear-gradient(90deg, rgba(${t}, 0.09), rgba(${t}, 0.02) 38%, transparent 72%)`,
      }}
    >
      <div className="plan-callout-body">
        {title && <span className="plan-callout-title">{title} — </span>}
        {children}
      </div>
    </aside>
  );
}
