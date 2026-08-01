// A published plan, rendered with the desktop's own MDX renderer so question
// forms and feedback work identically — answers land in the owning agent's
// composer via onSend. Loaded lazily: the MDX toolchain is the heaviest thing
// in the app and most sessions never open a plan.
import { useEffect, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import PlanRenderer from "../plan/PlanRenderer";
import "../plan/plan.css";

export default function PlanView({ transport, cwd, onSend }) {
  const [plans, setPlans] = useState(null);
  const [sel, setSel] = useState(0);
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);

  const loadList = () => {
    transport
      .invoke("list_plans", { project: cwd })
      .then((p) => setPlans(Array.isArray(p) ? p : []))
      .catch((e) => setError(String(e.message ?? e)));
  };
  useEffect(loadList, [cwd]);

  const plan = plans?.[sel];
  useEffect(() => {
    if (!plan) return;
    setDoc(null);
    transport
      .invoke("read_plan", { path: plan.path })
      .then((r) => setDoc(r.content))
      .catch((e) => setError(String(e.message ?? e)));
  }, [plan?.path]);

  if (error) return <div className="mob-warn" style={{ margin: 14 }}>{error}</div>;
  if (plans == null) return <div className="mob-note" style={{ margin: 14 }}>Looking for plans…</div>;
  if (plans.length === 0)
    return (
      <div className="mob-note" style={{ margin: 14 }}>
        No plan published in this project yet. Ask the agent to /agentbench-plan
        one and it shows up here.
      </div>
    );

  return (
    <div className="mob-plan">
      <div className="mob-plan-bar">
        {plans.length > 1 ? (
          <div className="mob-plan-picker">
            {plans.slice(0, 6).map((p, i) => (
              <button
                key={p.path}
                className={`mob-plan-chip${i === sel ? " on" : ""}`}
                onClick={() => setSel(i)}
              >
                {p.title || p.slug}
              </button>
            ))}
          </div>
        ) : (
          <strong className="mob-plan-title">{plan.title || plan.slug}</strong>
        )}
        <span className="mob-spacer" />
        <button
          className="mob-icon"
          aria-label="Refresh plan"
          onClick={() => {
            loadList();
            if (plan)
              transport
                .invoke("read_plan", { path: plan.path })
                .then((r) => setDoc(r.content))
                .catch(() => {});
          }}
        >
          <ArrowClockwise size={16} />
        </button>
      </div>
      <div className="mob-plan-body plan-body">
        {doc == null ? (
          <div className="mob-note" style={{ margin: 14 }}>Loading plan…</div>
        ) : (
          <PlanRenderer source={doc} title={plan.title || plan.slug} onSend={onSend} />
        )}
      </div>
    </div>
  );
}
