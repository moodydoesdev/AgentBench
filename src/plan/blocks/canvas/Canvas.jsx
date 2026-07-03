// Pan/zoom wireframe board: viewport → dotted grid layer → transformed
// world (translate + scale). Artboards render at fixed logical px; the board
// owns all scaling. Sketchy mode hides CSS borders and draws rough.js SVG
// overlays over each artboard, hand-drawn-kit style.
import {
  Children,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import rough from "roughjs";
import { PencilSimple, Broom, CornersOut } from "@phosphor-icons/react";
import { useThemeVersion, themeVar } from "../../lib/theme";
import { HeroSlotCtx } from "../../lib/heroSlot";

const SURFACES = {
  desktop: { w: 1200, h: 760 },
  mobile: { w: 390, h: 760 },
  browser: { w: 1200, h: 760, chrome: true },
};

const GRID = 26;
const MIN_K = 0.05;
const MAX_K = 2.5;

const BoardCtx = createContext(null);
const ArtboardCtx = createContext(null);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function offsetWithin(el, ancestor) {
  let x = 0;
  let y = 0;
  while (el && el !== ancestor) {
    x += el.offsetLeft;
    y += el.offsetTop;
    el = el.offsetParent;
  }
  return { x, y };
}

export function Canvas({
  title,
  look = "sketchy",
  height,
  inline = false,
  children,
}) {
  // the first non-inline Canvas in a plan claims the full-bleed top surface
  const slot = useContext(HeroSlotCtx);
  const heroRef = useRef(null);
  heroRef.current ??= !inline && !!slot && slot.claim();
  const hero = heroRef.current;
  const boardHeight = height ?? (hero ? 520 : 440);

  // per-artboard style default; each artboard owns its own Sketch/Clean
  const defaultSketchy = look !== "clean";
  const [userHeight, setUserHeight] = useState(null); // drag-resized board height
  const viewRef = useRef(null);
  const worldRef = useRef(null);
  // Hero canvases mount via portal on a later commit, so effects keyed on
  // mount would see a null ref. Track the actual board element in state and
  // key the wheel/refit effects on it.
  const [viewportEl, setViewportEl] = useState(null);
  const setViewport = (el) => {
    viewRef.current = el;
    setViewportEl((cur) => (cur === el ? cur : el));
  };
  const [view, setView] = useState({ x: 40, y: 30, k: 0.4 });
  const viewState = useRef(view);
  viewState.current = view;
  // auto-refit until the user pans/zooms themselves
  const interacted = useRef(false);

  const fit = () => {
    const vp = viewRef.current;
    const w = worldRef.current;
    if (!vp || !w || !w.offsetWidth) return;
    const k = clamp(
      Math.min(
        (vp.clientWidth - 48) / w.offsetWidth,
        (vp.clientHeight - 40) / w.offsetHeight,
      ),
      MIN_K,
      1,
    );
    setView({
      x: (vp.clientWidth - w.offsetWidth * k) / 2,
      y: (vp.clientHeight - w.offsetHeight * k) / 2,
      k,
    });
  };

  // Initial layout can settle after mount (stylesheet injection, fonts,
  // portal) — keep refitting on world/viewport resize until first interaction.
  useLayoutEffect(() => {
    if (!viewportEl) return;
    const ro = new ResizeObserver(() => {
      if (!interacted.current) fit();
    });
    if (worldRef.current) ro.observe(worldRef.current);
    ro.observe(viewportEl);
    return () => ro.disconnect();
  }, [viewportEl]);

  // Plain wheel pans the board; ctrl/cmd+wheel — and trackpad pinch, which
  // WebKit reports as ctrl+wheel — zooms toward the cursor, gently:
  // mouse-wheel notches are ±120 so the delta is clamped, or one notch
  // would jump ~3× at the old rate. Non-passive so preventDefault works.
  useEffect(() => {
    const vp = viewportEl;
    if (!vp) return;
    const onWheel = (e) => {
      e.preventDefault();
      interacted.current = true;
      const { x, y, k } = viewState.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = vp.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const dy = clamp(e.deltaY, -24, 24);
        const nk = clamp(k * Math.exp(-dy * 0.008), MIN_K, MAX_K);
        setView({
          k: nk,
          x: cx - ((cx - x) / k) * nk,
          y: cy - ((cy - y) / k) * nk,
        });
      } else {
        // gentle pan — damped so a wheel notch nudges instead of flinging
        setView({ k, x: x - e.deltaX * 0.4, y: y - e.deltaY * 0.4 });
      }
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [viewportEl]);

  // pan with left-drag or middle-drag (middle needs preventDefault to stop
  // the browser's autoscroll widget)
  const onPointerDown = (e) => {
    if ((e.button !== 0 && e.button !== 1) || e.target.closest("button"))
      return;
    if (e.button === 1) e.preventDefault();
    interacted.current = true;
    const vp = viewRef.current;
    const start = { ...viewState.current };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const onMove = (ev) =>
      setView({ k: start.k, x: start.x + ev.clientX - x0, y: start.y + ev.clientY - y0 });
    const onUp = (ev) => {
      try {
        vp.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released */
      }
      vp.removeEventListener("pointermove", onMove);
      vp.removeEventListener("pointerup", onUp);
      vp.removeEventListener("pointercancel", onUp);
    };
    vp.setPointerCapture(e.pointerId);
    vp.addEventListener("pointermove", onMove);
    vp.addEventListener("pointerup", onUp);
    vp.addEventListener("pointercancel", onUp);
  };

  const zoomBy = (f) => {
    interacted.current = true;
    const vp = viewRef.current;
    const { x, y, k } = viewState.current;
    const cx = vp.clientWidth / 2;
    const cy = vp.clientHeight / 2;
    const nk = clamp(k * f, MIN_K, MAX_K);
    setView({ k: nk, x: cx - ((cx - x) / k) * nk, y: cy - ((cy - y) / k) * nk });
  };

  const body = (
    <figure className={`plan-canvas ${hero ? "hero" : ""}`}>
      {title && (
        <div className="plan-canvas-head">
          <figcaption className="plan-block-title">{title}</figcaption>
        </div>
      )}
      <div
        className="plan-board"
        ref={setViewport}
        style={{ height: userHeight ?? boardHeight }}
        onPointerDown={onPointerDown}
      >
        <div
          className="plan-board-grid"
          style={{
            backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
        />
        <div
          className="plan-board-world"
          ref={worldRef}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          <BoardCtx.Provider value={{ defaultSketchy }}>
            {children}
          </BoardCtx.Provider>
        </div>
        <div className="plan-board-controls">
          <button type="button" onClick={() => zoomBy(1 / 1.25)}>−</button>
          <span>{Math.round(view.k * 100)}%</span>
          <button type="button" onClick={() => zoomBy(1.25)}>+</button>
          <button type="button" title="Zoom to fit" onClick={fit}>
            <CornersOut size={11} weight="bold" />
          </button>
        </div>
        <div
          className="plan-board-hgrip"
          title="Drag to resize the canvas height"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            const grip = e.currentTarget;
            const y0 = e.clientY;
            const h0 = viewRef.current?.clientHeight ?? boardHeight;
            const onMove = (ev) =>
              setUserHeight(clamp(h0 + (ev.clientY - y0), 220, 900));
            const onUp = (ev) => {
              try {
                grip.releasePointerCapture(ev.pointerId);
              } catch {
                /* already released */
              }
              grip.removeEventListener("pointermove", onMove);
              grip.removeEventListener("pointerup", onUp);
              grip.removeEventListener("pointercancel", onUp);
              document.body.style.cursor = "";
            };
            grip.setPointerCapture(e.pointerId);
            grip.addEventListener("pointermove", onMove);
            grip.addEventListener("pointerup", onUp);
            grip.addEventListener("pointercancel", onUp);
            document.body.style.cursor = "row-resize";
          }}
        />
      </div>
    </figure>
  );

  // hero canvases portal to the full-bleed slot above the doc columns
  if (hero) return slot?.el ? createPortal(body, slot.el) : null;
  return body;
}

function roundedRectPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  return (
    `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} ` +
    `L ${x + w} ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} ` +
    `L ${x + r} ${y + h} Q ${x} ${y + h} ${x} ${y + h - r} ` +
    `L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} Z`
  );
}

const ROUGH_SEL = ".wf-box, .wf-button, .wf-input, .wf-img, .wf-pill, .wf-urlbar-field";

/** Hand-drawn borders over the real DOM: one rough path per bordered node. */
function RoughOverlay({ innerRef, w, h }) {
  const svgRef = useRef(null);
  const themeV = useThemeVersion();

  // no dep array: redraw after every render so overlay tracks content;
  // seeded rough output is stable and generation is a few ms.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const svg = svgRef.current;
      const inner = innerRef.current;
      if (!svg || !inner) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const rc = rough.svg(svg);
      const stroke = themeVar("--text-dim") || "#666";
      // Matches Excalidraw's generateRoughOptions for solid rounded rects
      // (packages/element/src/shape.ts): roughness 1 ("artist"), rough.js
      // defaults for bowing/curveFitting, multi-stroke on, and — because
      // rounded rects are drawn as one continuous Q-corner path —
      // preserveVertices: true. Small shapes get roughness halved
      // (their adjustRoughness), or thirds under 10px.
      const excaliOpts = (ew, eh, seed, strokeWidth) => {
        const minS = Math.min(ew, eh);
        const maxS = Math.max(ew, eh);
        const roughness =
          (minS >= 20 && maxS >= 50) || minS >= 15
            ? 1
            : Math.min(1 / (maxS < 10 ? 3 : 2), 2.5);
        return { stroke, strokeWidth, roughness, preserveVertices: true, seed };
      };
      svg.appendChild(
        rc.path(
          roundedRectPath(2, 2, w - 4, h - 4, 14),
          excaliOpts(w, h, 7, 2),
        ),
      );
      inner.querySelectorAll(ROUGH_SEL).forEach((el, i) => {
        const ew = el.offsetWidth;
        const eh = el.offsetHeight;
        if (!ew || !eh) return;
        const { x, y } = offsetWithin(el, inner);
        const pill =
          el.classList.contains("wf-pill") ||
          el.classList.contains("wf-urlbar-field");
        // adaptive corner radius, same shape as Excalidraw's ADAPTIVE_RADIUS
        const r = pill ? eh / 2 : Math.min(10, Math.min(ew, eh) * 0.25);
        svg.appendChild(
          rc.path(
            roundedRectPath(x + 0.5, y + 0.5, ew - 1, eh - 1, r),
            excaliOpts(ew, eh, i * 13 + 11, 1.5),
          ),
        );
      });
    });
    return () => cancelAnimationFrame(raf);
  });

  return (
    <svg
      ref={svgRef}
      className="plan-rough-overlay"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      data-theme-v={themeV}
    />
  );
}

export function Artboard({ title, surface = "desktop", children }) {
  const preset = SURFACES[surface] ?? SURFACES.desktop;
  const board = useContext(BoardCtx);
  // each mockup is its own canvas element with its own Sketch/Clean style
  const [sketchy, setSketchy] = useState(board?.defaultSketchy ?? true);
  const innerRef = useRef(null);
  const [notes, setNotes] = useState([]); // {key, target, text}
  const [markers, setMarkers] = useState([]); // {n, left, top}

  // resolve note targets to marker positions (logical px — offset chain is
  // unaffected by the board's transform, so no scale math needed).
  // IMPORTANT: bail out when positions are unchanged — `children` gets a new
  // identity every render, so an unconditional setMarkers here would loop
  // render → effect → setState forever (layout churn that yanks scroll).
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const next = notes
      .map((note, i) => {
        const target = inner.querySelector(
          `[data-wf-id="${CSS.escape(note.target ?? "")}"]`,
        );
        if (!target) return null;
        const { x, y } = offsetWithin(target, inner);
        return { n: i + 1, left: x + target.offsetWidth - 9, top: y - 9 };
      })
      .filter(Boolean);
    setMarkers((prev) =>
      prev.length === next.length &&
      prev.every(
        (m, i) =>
          m.n === next[i].n &&
          m.left === next[i].left &&
          m.top === next[i].top,
      )
        ? prev
        : next,
    );
    // sketchy: clean/sketch swap shifts layout (borders/padding differ)
  }, [notes, children, sketchy]);

  const ctx = useRef({
    add: (note) => {
      setNotes((ns) => (ns.some((x) => x.key === note.key) ? ns : [...ns, note]));
      return () => setNotes((ns) => ns.filter((x) => x.key !== note.key));
    },
  });

  return (
    <div
      className={`plan-artboard ${sketchy ? "look-sketchy" : ""}`}
      style={{ width: preset.w }}
    >
      {title && <div className="plan-artboard-title">{title}</div>}
      <div
        className="plan-artboard-frame"
        style={{ width: preset.w, height: preset.h }}
      >
        <button
          type="button"
          className="plan-artboard-look"
          title={sketchy ? "Switch to clean style" : "Switch to sketch style"}
          onClick={(e) => {
            e.stopPropagation();
            setSketchy((s) => !s);
          }}
        >
          {sketchy ? (
            <>
              <Broom size={13} weight="bold" /> Clean
            </>
          ) : (
            <>
              <PencilSimple size={13} weight="bold" /> Sketch
            </>
          )}
        </button>
        <div
          ref={innerRef}
          className="plan-artboard-inner"
          style={{ width: preset.w, height: preset.h }}
        >
          {preset.chrome && (
            <div className="wf-urlbar">
              <span className="wf-urlbar-dots">● ● ●</span>
              <span className="wf-urlbar-field">https://…</span>
            </div>
          )}
          <ArtboardCtx.Provider value={ctx.current}>
            {children}
          </ArtboardCtx.Provider>
          {markers.map((m) => (
            <span
              key={m.n}
              className="wf-note-marker"
              style={{ left: m.left, top: m.top }}
            >
              {m.n}
            </span>
          ))}
        </div>
        {sketchy && <RoughOverlay innerRef={innerRef} w={preset.w} h={preset.h} />}
      </div>
      {notes.length > 0 && (
        <ol className="plan-artboard-notes">
          {notes.map((n, i) => (
            <li key={n.key}>
              <span className="wf-note-marker static">{i + 1}</span> {n.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

let noteSeq = 0;

export function Note({ target, children }) {
  const ctx = useContext(ArtboardCtx);
  const keyRef = useRef(null);
  keyRef.current ??= `note-${++noteSeq}`;
  const text = Children.toArray(children)
    .map((c) => (typeof c === "string" || typeof c === "number" ? c : ""))
    .join("")
    .trim();

  useEffect(() => {
    if (!ctx) return;
    return ctx.add({ key: keyRef.current, target, text });
  }, [ctx, target, text]);

  return null;
}
