import { useLayoutEffect, useRef, useState } from "react";

/**
 * Header drag for grid panes, pointer-capture based. HTML5 DnD makes WebKit
 * snapshot the pane for its ghost image — slow to start and glitchy with
 * terminal canvases — so instead the real pane follows the cursor via
 * transform and drop targets are hit-tested with elementsFromPoint.
 *
 * Also owns the FLIP glide: whenever layout shoves the pane around
 * (reorder, its own resize, a neighbor's resize), it animates from the old
 * rect to the new one instead of teleporting.
 *
 * The pane's <section> must carry data-pane-id and the "pane" class.
 */
export default function usePaneDrag(sectionRef, id, onReorder) {
  const [dragging, setDragging] = useState(false);
  const flipRectRef = useRef(null);

  useLayoutEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    if (el.style.transform) {
      // mid-drag: just track the cursor position, never fight the hand
      flipRectRef.current = el.getBoundingClientRect();
      return;
    }
    // cancel a mid-flight glide so the measurement below is the true rect
    for (const a of el.getAnimations()) a.cancel();
    const rect = el.getBoundingClientRect();
    const prev = flipRectRef.current;
    flipRectRef.current = rect;
    if (!prev || !prev.width || !rect.width) return; // hidden project tab
    const dx = prev.left - rect.left;
    const dy = prev.top - rect.top;
    const sx = prev.width / rect.width;
    const sy = prev.height / rect.height;
    if (!dx && !dy && sx === 1 && sy === 1) return;
    // Size changes snap instead of glide: scale-animating a pane stretches
    // its terminal canvas for 220ms while the fit addon refits underneath
    // (e.g. toggling the plans rail resizes every pane) — looks choppy.
    // Pure moves (reorder) still glide.
    if (Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01) return;
    el.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px)`,
          transformOrigin: "top left",
        },
        { transform: "none", transformOrigin: "top left" },
      ],
      { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  });

  const onHeadPointerDown = (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest("button")) return; // size/close buttons stay clicks
    const el = sectionRef.current;
    const head = ev.currentTarget;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let started = false;
    let target = null; // drop target pane element under the cursor

    const onMove = (e) => {
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (!started) {
        if (Math.hypot(dx, dy) < 5) return; // plain clicks still focus
        started = true;
        setDragging(true);
        el.style.pointerEvents = "none"; // hit-test through the moving pane
        document.body.style.cursor = "grabbing";
      }
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      const pane = document
        .elementsFromPoint(e.clientX, e.clientY)
        .map((n) => (n.closest ? n.closest(".pane") : null))
        .find((p) => p && p !== el);
      if (target && target !== pane) target.classList.remove("drag-over");
      pane?.classList.add("drag-over"); // re-add each move; renders may wipe it
      target = pane ?? null;
    };

    const onUp = (e) => {
      head.removeEventListener("pointermove", onMove);
      head.removeEventListener("pointerup", onUp);
      head.removeEventListener("pointercancel", onUp);
      try {
        head.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      if (!started) return;
      document.body.style.cursor = "";
      // remember the drop position so the FLIP glide starts at the cursor
      flipRectRef.current = el.getBoundingClientRect();
      el.style.transform = "";
      el.style.pointerEvents = "";
      target?.classList.remove("drag-over");
      setDragging(false);
      // we are the dragged pane; the hovered pane's slot is the destination
      const raw = target?.dataset.paneId;
      if (raw) onReorder(id, /^\d+$/.test(raw) ? Number(raw) : raw);
    };

    head.setPointerCapture(ev.pointerId);
    head.addEventListener("pointermove", onMove);
    head.addEventListener("pointerup", onUp);
    head.addEventListener("pointercancel", onUp);
  };

  return { dragging, onHeadPointerDown };
}
