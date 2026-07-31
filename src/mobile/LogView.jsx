import { useEffect, useRef, useState } from "react";
import { foldCarriageReturns, stripAnsi } from "./ansi";

/**
 * Live output for panes that have no chat transcript: project run commands
 * (dev servers, builds) and non-Claude harnesses. These are terminals, so the
 * honest mobile rendering is a log — the raw stream with control sequences
 * resolved, not a conversation.
 *
 * Backlog is fetched on open (`pane_buffer`) rather than carried in the fleet
 * snapshot, then `pane-output` appends live.
 */

const MAX_LINES = 2000;

function decodeBase64(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

export default function LogView({ transport, paneId, onStop }) {
  const [text, setText] = useState("");
  const [state, setState] = useState("loading"); // loading | ready | error
  const [error, setError] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const listRef = useRef(null);
  const atBottomRef = useRef(true);
  const pendingRef = useRef("");
  const frameRef = useRef(0);

  // Coalesce appends: a build can emit hundreds of chunks a second and a
  // setState per chunk would keep the phone busy repainting.
  const flush = () => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const chunk = pendingRef.current;
      pendingRef.current = "";
      if (!chunk) return;
      setText((prev) => {
        const next = prev + chunk;
        const lines = next.split("\n");
        return lines.length > MAX_LINES
          ? lines.slice(lines.length - MAX_LINES).join("\n")
          : next;
      });
    });
  };

  useEffect(() => {
    let dead = false;
    setState("loading");
    setText("");

    transport
      .invoke("pane_buffer", { id: paneId })
      .then((res) => {
        if (dead) return;
        const backlog = res?.buffer
          ? decodeBase64(res.buffer)
          : (res?.lines ?? []).join("\n");
        setText(stripAnsi(backlog));
        setTruncated(!!res?.truncated);
        setState("ready");
      })
      .catch((err) => {
        if (dead) return;
        setError(String(err.message ?? err));
        setState("error");
      });

    const un = transport.listen("pane-output", ({ payload }) => {
      if (payload.id !== paneId) return;
      pendingRef.current += stripAnsi(decodeBase64(payload.data));
      flush();
    });

    return () => {
      dead = true;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      un.then?.((f) => f?.());
    };
  }, [transport, paneId]);

  // Stay pinned to the newest output unless the user has scrolled up to read.
  useEffect(() => {
    const el = listRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const lines = text.split("\n").map(foldCarriageReturns);

  return (
    <div className="mob-log">
      <div
        className="mob-log-body"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          atBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {state === "loading" && <div className="mob-note">Loading output…</div>}
        {state === "error" && (
          <div className="mob-warn">Couldn't read this pane's output: {error}</div>
        )}
        {state === "ready" && truncated && (
          <div className="mob-log-trunc">earlier output not shown</div>
        )}
        {state === "ready" && lines.length === 1 && lines[0] === "" && (
          <div className="mob-note">No output yet.</div>
        )}
        <pre className="mob-log-pre">{lines.join("\n")}</pre>
      </div>
      <div className="mob-log-bar">
        <span className="mob-log-hint">live output</span>
        <span className="mob-spacer" />
        <button className="mob-log-stop" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  );
}
