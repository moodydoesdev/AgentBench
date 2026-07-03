import { useEffect, useState } from "react";
import { CheckCircle, Circle } from "@phosphor-icons/react";
import { useFeedback } from "../feedback";

export function Options({ id, title, options = [], recommended }) {
  const fb = useFeedback();
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    const opt = options.find((o) => o.id === selected);
    fb?.report(id, {
      label: title,
      value: opt?.label ?? "",
      answered: !!opt,
    });
  }, [selected]);

  return (
    <fieldset className="plan-options">
      <legend className="plan-question-title">{title}</legend>
      <div className="plan-options-grid">
        {options.map((o) => {
          const sel = selected === o.id;
          return (
            <button
              key={o.id}
              type="button"
              className={`plan-option-card ${sel ? "selected" : ""}`}
              onClick={() => setSelected(sel ? null : o.id)}
            >
              <span className="plan-option-label">
                {sel ? (
                  <CheckCircle size={14} weight="fill" className="c-green" />
                ) : (
                  <Circle size={14} />
                )}
                {o.label}
                {recommended === o.id && (
                  <span className="plan-badge">recommended</span>
                )}
              </span>
              {(o.pros?.length || o.cons?.length) && (
                <span className="plan-option-proscons">
                  {o.pros?.map((p, i) => (
                    <span key={`p${i}`} className="plan-pro">
                      + {p}
                    </span>
                  ))}
                  {o.cons?.map((c, i) => (
                    <span key={`c${i}`} className="plan-con">
                      − {c}
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
