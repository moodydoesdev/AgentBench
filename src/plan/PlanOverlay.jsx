// Full-window plan view: covers the terminal grid (below the topbar) while
// reviewing. Esc or ✕ returns to the terminals; content live-reloads on
// republish and via a light mtime poll.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, FileText } from "@phosphor-icons/react";
import PlanRenderer from "./PlanRenderer";
import { usePreserveScroll } from "./lib/usePreserveScroll";
import "./plan.css";

const POLL_MS = 2000;

export default function PlanOverlay({
  path,
  title,
  refreshNonce = 0,
  onClose,
  onSend,
}) {
  const [doc, setDoc] = useState({ content: null, error: null });
  const mtimeRef = useRef(0);
  const bodyRef = useRef(null);
  usePreserveScroll(bodyRef);

  useEffect(() => {
    let alive = true;
    const load = async (force) => {
      try {
        const res = await invoke("read_plan", { path });
        if (!alive) return;
        if (force || res.mtime !== mtimeRef.current) {
          mtimeRef.current = res.mtime;
          setDoc({ content: res.content, error: null });
        }
      } catch (error) {
        if (alive) setDoc((d) => ({ ...d, error }));
      }
    };
    load(true);
    const t = setInterval(() => load(false), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path, refreshNonce]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="plan-overlay">
      <header className="plan-overlay-head">
        <FileText size={14} className="plan-head-icon" />
        <span className="plan-overlay-title">{title || "Plan"}</span>
        <span className="plan-overlay-path" title={path}>
          {path}
        </span>
        <button
          className="pane-close"
          title="Close plan (Esc)"
          onClick={onClose}
        >
          <X size={14} weight="bold" />
        </button>
      </header>
      <div className="plan-body" ref={bodyRef}>
        {doc.error && doc.content == null ? (
          <div className="plan-error">
            <div className="plan-error-head">Cannot read plan file</div>
            <pre className="plan-error-msg">{String(doc.error)}</pre>
          </div>
        ) : doc.content == null ? (
          <div className="plan-loading">loading plan…</div>
        ) : (
          <PlanRenderer
            source={doc.content}
            title={title || "Plan"}
            onSend={onSend}
          />
        )}
      </div>
    </div>
  );
}
