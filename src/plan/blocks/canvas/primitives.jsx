// Wireframe primitives: flexbox only, no coordinates. `id` becomes a
// data-wf-id anchor that <Note target="..."> can point at.

export function Row({ gap = 8, id, children }) {
  return (
    <div className="wf-row" style={{ gap }} data-wf-id={id}>
      {children}
    </div>
  );
}

export function Col({ gap = 8, w, grow, id, children }) {
  return (
    <div
      className="wf-col"
      style={{
        gap,
        width: w,
        flex: grow ? "1 1 0" : w != null ? `0 0 ${w}px` : "0 1 auto",
      }}
      data-wf-id={id}
    >
      {children}
    </div>
  );
}

export function Box({ h = 60, label, id, children }) {
  return (
    <div className="wf-box" style={{ minHeight: h }} data-wf-id={id}>
      {children ?? <span className="wf-label">{label}</span>}
    </div>
  );
}

const TEXT_SIZES = { xs: 10, sm: 11.5, md: 13, lg: 17, xl: 24 };

export function Text({ size = "md", dim, bold, id, children }) {
  return (
    <span
      className="wf-text"
      style={{
        fontSize: TEXT_SIZES[size] ?? TEXT_SIZES.md,
        color: dim ? "var(--text-dim)" : "var(--text)",
        fontWeight: bold ? 600 : 400,
      }}
      data-wf-id={id}
    >
      {children}
    </span>
  );
}

export function Button({ primary, id, children }) {
  return (
    <span className={`wf-button ${primary ? "primary" : ""}`} data-wf-id={id}>
      {children}
    </span>
  );
}

export function Input({ placeholder = "", id }) {
  return (
    <span className="wf-input" data-wf-id={id}>
      {placeholder}
    </span>
  );
}

export function Img({ h = 100, label, id }) {
  return (
    <span className="wf-img" style={{ height: h }} data-wf-id={id}>
      <span className="wf-label">{label ?? "image"}</span>
    </span>
  );
}

export function Pill({ id, children }) {
  return (
    <span className="wf-pill" data-wf-id={id}>
      {children}
    </span>
  );
}

export function Divider() {
  return <span className="wf-divider" />;
}
