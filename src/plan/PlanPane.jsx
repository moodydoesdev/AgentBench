// A plan document pane: same grid chrome as AgentPane (header, grips, drag
// reorder), but the body renders an interactive MDX plan instead of a pty.
import { memo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, ArrowsOutLineHorizontal, FileText } from "@phosphor-icons/react";
import PlanRenderer from "./PlanRenderer";
import usePaneDrag from "../usePaneDrag";
import { usePreserveScroll } from "./lib/usePreserveScroll";
import "./plan.css";

const MAX_ROW_SPAN = 4;
const POLL_MS = 2000;

export default memo(function PlanPane({
  id,
  title,
  path,
  agentId,
  focused,
  refreshNonce = 0,
  size,
  gridCols = 3,
  onResize,
  onReorder,
  onActivity,
  onClose,
}) {
  const sectionRef = useRef(null);
  const { dragging, onHeadPointerDown } = usePaneDrag(sectionRef, id, onReorder);
  const [doc, setDoc] = useState({ content: null, mtime: 0, error: null });
  const mtimeRef = useRef(0);
  const bodyRef = useRef(null);
  usePreserveScroll(bodyRef);

  const w = Math.min(size?.w ?? 1, gridCols);
  const h = Math.min(size?.h ?? 1, MAX_ROW_SPAN);

  // load + cheap mtime poll; refreshNonce bumps on re-publish from the agent
  useEffect(() => {
    let alive = true;
    const load = async (force) => {
      try {
        const res = await invoke("read_plan", { path });
        if (!alive) return;
        if (force || res.mtime !== mtimeRef.current) {
          mtimeRef.current = res.mtime;
          setDoc({ content: res.content, mtime: res.mtime, error: null });
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

  // paste the feedback into the owning agent's terminal, then submit.
  // Bracketed paste keeps the multi-line message as one prompt entry.
  const sendFeedback = (text) => {
    invoke("write_pane", {
      id: agentId,
      data: `\x1b[200~${text}\x1b[201~`,
    }).catch(() => {});
    setTimeout(() => {
      invoke("write_pane", { id: agentId, data: "\r" }).catch(() => {});
    }, 150);
  };

  const startResize = (ev, dirs) => {
    ev.preventDefault();
    ev.stopPropagation();
    const grip = ev.currentTarget;
    const grid = sectionRef.current.parentElement;
    const cellW = grid.clientWidth / gridCols;
    const ROW_UNIT = 340; // matches grid-auto-rows min in styles.css
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    const w0 = w;
    const h0 = h;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const onMove = (e) => {
      onResize(id, {
        w: dirs.includes("e")
          ? clamp(w0 + Math.round((e.clientX - x0) / cellW), 1, gridCols)
          : w0,
        h: dirs.includes("s")
          ? clamp(h0 + Math.round((e.clientY - y0) / ROW_UNIT), 1, MAX_ROW_SPAN)
          : h0,
      });
    };
    const onUp = (e) => {
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
    };
    grip.setPointerCapture(ev.pointerId);
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
    document.body.style.cursor =
      dirs === "se" ? "nwse-resize" : dirs === "e" ? "col-resize" : "row-resize";
  };

  const cycleSize = () => {
    const steps = [
      ...new Set([1, Math.max(1, Math.round(gridCols / 2)), gridCols]),
    ];
    const next = steps[(steps.indexOf(w) + 1) % steps.length];
    onResize(id, { w: next, h });
  };

  return (
    <section
      ref={sectionRef}
      className={`pane plan-pane ${focused ? "focused" : ""} ${dragging ? "dragging" : ""}`}
      style={{ gridColumn: `span ${w}`, gridRow: `span ${h}` }}
      data-pane-id={id}
      onMouseDown={() => onActivity?.(id)}
    >
      <header className="pane-head" onPointerDown={onHeadPointerDown}>
        <FileText size={13} className="plan-head-icon" />
        <span className="pane-title">{title || "Plan"}</span>
        <span className="pane-cwd" title={path}>
          {path}
        </span>
        <button
          className="pane-size"
          title={`Cycle width: 1 → half → full (now ${w}×${h})`}
          onClick={(ev) => {
            ev.stopPropagation();
            cycleSize();
          }}
        >
          <ArrowsOutLineHorizontal size={14} weight="bold" />
        </button>
        <button
          className="pane-close"
          title="Close plan"
          onClick={(ev) => {
            ev.stopPropagation();
            onClose(id);
          }}
        >
          <X size={13} weight="bold" />
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
            onSend={sendFeedback}
          />
        )}
      </div>

      <div
        className="pane-grip e"
        title="Drag to resize · double-click to reset"
        onPointerDown={(ev) => startResize(ev, "e")}
        onDoubleClick={() => onResize(id, { w: 1, h: 1 })}
      />
      <div
        className="pane-grip s"
        title="Drag to resize · double-click to reset"
        onPointerDown={(ev) => startResize(ev, "s")}
        onDoubleClick={() => onResize(id, { w: 1, h: 1 })}
      />
      <div
        className="pane-grip se"
        title="Drag to resize · double-click to reset"
        onPointerDown={(ev) => startResize(ev, "se")}
        onDoubleClick={() => onResize(id, { w: 1, h: 1 })}
      />
    </section>
  );
});
