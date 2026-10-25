import { useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, PaperPlaneTilt, WarningCircle, Check, CaretDown } from "@phosphor-icons/react";
import Markdown from "./Markdown";

// Agent-to-agent messages (Claude Code's cross-session messaging). Sent ones
// are SendMessage tool calls; received ones arrive as a user turn wrapping the
// text in <cross-session-message from-name="…">…</cross-session-message>.
// Both render as chat bubbles instead of raw JSON / tag soup.

/** "Developer 4 (AntiDote)" → { name: "Developer 4", scope: "AntiDote" }. */
function who(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { name: "another session", scope: null };
  if (s === "*") return { name: "everyone", scope: null };
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(s);
  return m && m[1] ? { name: m[1], scope: m[2] } : { name: s, scope: null };
}

function Name({ raw }) {
  const { name, scope } = who(raw);
  return (
    <span className="peer-who">
      <span className="peer-name">{name}</span>
      {scope && <span className="peer-scope">{scope}</span>}
    </span>
  );
}

/** Message body as markdown, folded past a few lines with a Show more. */
function Body({ text }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 4);
  }, [text, open]);
  return (
    <>
      <div ref={ref} className={`peer-body${open ? " open" : ""}`}>
        <Markdown text={text} />
      </div>
      {(overflows || open) && (
        <button className="peer-more" onClick={() => setOpen((o) => !o)}>
          <CaretDown size={10} weight="bold" className={open ? "flip" : undefined} />
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

/** A message another agent sent this one. */
export function PeerBubble({ peer }) {
  return (
    <div className="peer peer-in">
      <div className="peer-head">
        <ArrowDown size={12} weight="bold" />
        <span className="peer-dir">From</span>
        <Name raw={peer.from} />
      </div>
      <Body text={peer.text} />
    </div>
  );
}

// The tool result is JSON — {"success":true,"message":"… delivery notice …"}.
// The notice is boilerplate about inboxes; all that matters is it went.
function delivery(tool) {
  if (!tool.done) return { state: "sending", label: "Sending…" };
  let ok = !tool.isError;
  let err = null;
  try {
    const r = JSON.parse(tool.result);
    if (r && r.success === false) {
      ok = false;
      err = r.error || r.message || null;
    }
  } catch {
    if (tool.isError) err = tool.result || null;
  }
  // the pill stays one short word; the reason gets its own wrapped line
  return ok ? { state: "ok", label: "Delivered" } : { state: "error", label: "Not delivered", error: err };
}

/** Can this SendMessage call render as a bubble? (Anything else — shutdown
 *  requests, structured payloads — stays a normal tool row.) */
export const isSendMessage = (tool) =>
  tool?.name === "SendMessage" && typeof tool.input?.message === "string";

/** A message this agent sent another one. */
export function SendMessageCard({ tool }) {
  const [raw, setRaw] = useState(false);
  const { to, summary, message } = tool.input;
  const st = delivery(tool);
  return (
    <div className={`peer peer-out${st.state === "error" ? " failed" : ""}`}>
      <div className="peer-head">
        <PaperPlaneTilt size={12} weight="fill" />
        <span className="peer-dir">To</span>
        <Name raw={to} />
        <span className="peer-spacer" />
        <button
          className={`peer-status ${st.state}`}
          title={raw ? "Hide raw call" : "Show raw call"}
          onClick={() => setRaw((r) => !r)}
        >
          {st.state === "ok" && <Check size={11} weight="bold" />}
          {st.state === "error" && <WarningCircle size={11} weight="fill" />}
          {st.label}
        </button>
      </div>
      {st.error && (
        <div className="peer-error" role="alert">
          <WarningCircle size={13} weight="fill" />
          <span>{st.error}</span>
        </div>
      )}
      {summary && <div className="peer-summary">{summary}</div>}
      <Body text={message} />
      {raw && (
        <pre className="chat-tool-pre peer-raw">
          {JSON.stringify(tool.input, null, 2)}
          {tool.result ? `\n\n${tool.result}` : ""}
        </pre>
      )}
    </div>
  );
}
