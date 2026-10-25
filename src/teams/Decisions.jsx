import { useEffect, useState } from "react";
import { Signpost } from "@phosphor-icons/react";

/**
 * Open decisions for one team, live from the broker's `decisions` event.
 * `transport` is anything with invoke/listen — the desktop ipc module or a
 * phone's per-machine transport.
 */
export function useDecisions(transport, teamId, enabled = true) {
  const [list, setList] = useState([]);
  useEffect(() => {
    if (!enabled || !teamId || !transport) return;
    let dead = false;
    const take = (state) =>
      !dead && setList((state?.decisions ?? []).filter((d) => d.teamId === teamId));
    // a broker that predates decisions answers "unknown op": show nothing
    transport.invoke("decisions").then(take).catch(() => {});
    const un = transport.listen("decisions", (e) => take(e.payload));
    return () => {
      dead = true;
      Promise.resolve(un).then((f) => f?.());
    };
  }, [transport, teamId, enabled]);
  return list;
}

function DecisionCard({ transport, d, cls }) {
  const [pick, setPick] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const answer = pick ?? "";
  const ready = !busy && (answer || note.trim());

  const send = () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    transport
      .invoke("decision_answer", { id: d.id, answer, note: note.trim() || null })
      .then((r) => {
        if (r && r.delivered === false)
          setError("Saved, but the manager isn't running — it will see this when it checks its decisions.");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className={`${cls}-card`}>
      <div className={`${cls}-q`}>
        <span className={`${cls}-id`}>{d.id}</span>
        {d.question}
      </div>
      {d.context && <div className={`${cls}-ctx`}>{d.context}</div>}
      {d.options.length > 0 && (
        <div className={`${cls}-opts`}>
          {d.options.map((o) => (
            <button
              key={o}
              type="button"
              className={`${cls}-opt${pick === o ? " on" : ""}`}
              onClick={() => setPick(pick === o ? null : o)}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <div className={`${cls}-row`}>
        <input
          className={`${cls}-note`}
          value={note}
          placeholder={d.options.length ? "Add a note (optional)" : "Your answer"}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button type="button" className={`${cls}-send`} disabled={!ready} onClick={send}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {error && <div className={`${cls}-err`}>{error}</div>}
    </div>
  );
}

/**
 * Questions the team's manager is waiting on the user for. Answering types
 * the decision into the manager's session; the card then drops off.
 */
export default function Decisions({ transport, teamId, enabled = true, cls = "decisions" }) {
  const open = useDecisions(transport, teamId, enabled).filter((d) => d.status === "open");
  if (open.length === 0) return null;
  return (
    <section className={cls} aria-label="Decisions waiting on you">
      <div className={`${cls}-head`}>
        <Signpost size={12} weight="bold" />
        <span>Decisions · {open.length}</span>
      </div>
      {open.map((d) => (
        <DecisionCard key={d.id} transport={transport} d={d} cls={cls} />
      ))}
    </section>
  );
}
