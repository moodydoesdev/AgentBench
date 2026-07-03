import { useEffect, useState } from "react";
import { useFeedback } from "../feedback";

export function QuestionForm({
  id,
  title,
  mode = "single",
  options = [],
  recommended,
}) {
  const fb = useFeedback();
  const [selected, setSelected] = useState(() => new Set());

  useEffect(() => {
    const labels = options
      .filter((o) => selected.has(o.id))
      .map((o) => o.label);
    fb?.report(id, {
      label: title,
      value: labels.join(", "),
      answered: labels.length > 0,
    });
  }, [selected]);

  const toggle = (oid) => {
    setSelected((s) => {
      if (mode === "single") return new Set(s.has(oid) ? [] : [oid]);
      const next = new Set(s);
      next.has(oid) ? next.delete(oid) : next.add(oid);
      return next;
    });
  };

  return (
    <fieldset className="plan-question">
      <legend className="plan-question-title">{title}</legend>
      {options.map((o) => (
        <label
          key={o.id}
          className={`plan-option ${selected.has(o.id) ? "selected" : ""}`}
        >
          <input
            type={mode === "single" ? "radio" : "checkbox"}
            name={id}
            checked={selected.has(o.id)}
            onChange={() => toggle(o.id)}
            onClick={(e) => {
              // allow radio deselect
              if (mode === "single" && selected.has(o.id)) {
                e.preventDefault();
                toggle(o.id);
              }
            }}
          />
          <span className="plan-option-body">
            <span className="plan-option-label">
              {o.label}
              {recommended === o.id && (
                <span className="plan-badge">recommended</span>
              )}
            </span>
            {o.desc && <span className="plan-option-desc">{o.desc}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
