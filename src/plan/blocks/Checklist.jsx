import { useEffect, useState } from "react";
import { useFeedback } from "../feedback";

export function Checklist({ id, title, items = [] }) {
  const fb = useFeedback();
  const [checked, setChecked] = useState(
    () => new Set(items.filter((i) => i.done).map((i) => i.id)),
  );

  useEffect(() => {
    const value = items
      .map((i) => `[${checked.has(i.id) ? "x" : " "}] ${i.label}`)
      .join(", ");
    fb?.report(id, { label: title ?? "Checklist", value, answered: true });
  }, [checked]);

  const toggle = (iid) =>
    setChecked((s) => {
      const next = new Set(s);
      next.has(iid) ? next.delete(iid) : next.add(iid);
      return next;
    });

  return (
    <fieldset className="plan-checklist">
      {title && <legend className="plan-question-title">{title}</legend>}
      {items.map((i) => (
        <label key={i.id} className="plan-check">
          <input
            type="checkbox"
            checked={checked.has(i.id)}
            onChange={() => toggle(i.id)}
          />
          <span className={checked.has(i.id) ? "plan-check-done" : ""}>
            {i.label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
