import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleNotch, DownloadSimple, X } from "@phosphor-icons/react";
import { useTransport } from "../lib/TransportContext";
import { convertFileSrc, revealItemInDir } from "@/lib/ipc";

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const extOf = (p) => /\.([A-Za-z0-9]+)$/.exec(p)?.[1].toLowerCase() ?? "";
export const isImagePath = (p) => !!p && extOf(p) in MIME;
export const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// path → Promise<{ blob, url }>. The chat remounts rows as it scrolls, so the
// fetch (and the object URL) outlives any one component. Failures are dropped
// so a later mount can retry.
const cache = new Map();
function loadImage(transport, path) {
  let hit = cache.get(path);
  if (!hit) {
    hit = transport
      .download(path)
      .then((raw) => {
        // the gateway sends octet-stream; the extension says what it is
        const blob = new Blob([raw], { type: MIME[extOf(path)] });
        return { blob, url: URL.createObjectURL(blob) };
      })
      .catch((e) => {
        cache.delete(path);
        throw e;
      });
    cache.set(path, hit);
  }
  return hit;
}

const MAX_ZOOM = 6;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_ZOOM = 2.5;

/** Full-screen viewer: pinch (or wheel) to zoom, drag to pan once zoomed,
 *  double-tap to jump in/out. Tap the dark area / ✕ / Esc / back gesture to
 *  close. Pointer events throughout, so touch, pen and mouse share one path. */
export function Lightbox({ src, name, onSave, onClose }) {
  const [view, setView] = useState({ s: 1, x: 0, y: 0 }); // scale + translate (px from centre)
  const stageRef = useRef(null);
  const imgRef = useRef(null);
  const viewRef = useRef(view);
  const pointers = useRef(new Map()); // pointerId → {x, y}
  const gesture = useRef(null); // pinch/pan baseline
  const moved = useRef(false);
  const lastTap = useRef(0);
  const closedRef = useRef(false);
  const apply = (v) => {
    viewRef.current = v;
    setView(v);
  };

  // Own a history entry so the phone's back gesture closes the viewer instead
  // of leaving the chat. The mobLayer bump keeps MobileApp's layers (which
  // close when state.mobLayer drops below theirs) from reacting to our entry.
  useEffect(() => {
    history.pushState({ mobLayer: (history.state?.mobLayer ?? 0) + 1, lightbox: true }, "");
    const onPop = () => {
      closedRef.current = true;
      onClose();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
      // closed by the UI rather than the gesture: consume our entry
      if (!closedRef.current && history.state?.lightbox) history.back();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the picture from being dragged off-screen: at scale s it may travel
  // only as far as it overflows the stage.
  const clamp = (v) => {
    const st = stageRef.current;
    const im = imgRef.current;
    if (!st || !im) return v;
    const maxX = Math.max(0, (im.offsetWidth * v.s - st.clientWidth) / 2);
    const maxY = Math.max(0, (im.offsetHeight * v.s - st.clientHeight) / 2);
    return {
      s: v.s,
      x: Math.min(maxX, Math.max(-maxX, v.x)),
      y: Math.min(maxY, Math.max(-maxY, v.y)),
    };
  };
  const centre = () => {
    const r = stageRef.current.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  // Zoom to `s` keeping the content under screen point (px, py) in place.
  const zoomAt = (s, px, py, from = viewRef.current) => {
    const c = centre();
    const next = Math.min(MAX_ZOOM, Math.max(1, s));
    const qx = (px - c.x - from.x) / from.s;
    const qy = (py - c.y - from.y) / from.s;
    apply(clamp(next === 1 ? { s: 1, x: 0, y: 0 } : { s: next, x: px - c.x - next * qx, y: py - c.y - next * qy }));
  };

  const baseline = () => {
    const pts = [...pointers.current.values()];
    const mid = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { mid, dist, view: viewRef.current };
  };

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) moved.current = false;
    else moved.current = true; // a second finger is never a tap
    baseline();
  };
  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const pts = [...pointers.current.values()];
    const mid = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    if (Math.hypot(mid.x - g.mid.x, mid.y - g.mid.y) > 6 || pts.length > 1) moved.current = true;
    if (pts.length > 1 && g.dist > 0) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const s = Math.min(MAX_ZOOM, Math.max(1, g.view.s * (dist / g.dist)));
      const c = centre();
      const qx = (g.mid.x - c.x - g.view.x) / g.view.s;
      const qy = (g.mid.y - c.y - g.view.y) / g.view.s;
      apply(clamp({ s, x: mid.x - c.x - s * qx, y: mid.y - c.y - s * qy }));
    } else if (viewRef.current.s > 1) {
      apply(clamp({ s: g.view.s, x: g.view.x + (mid.x - g.mid.x), y: g.view.y + (mid.y - g.mid.y) }));
    }
  };
  const onPointerUp = (e) => {
    const wasTap = pointers.current.size === 1 && !moved.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) return baseline(); // pinch → pan hand-off
    gesture.current = null;
    if (!wasTap) return;
    const now = Date.now();
    const onImage = e.target === imgRef.current;
    if (onImage && now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      const v = viewRef.current;
      v.s > 1 ? apply({ s: 1, x: 0, y: 0 }) : zoomAt(DOUBLE_TAP_ZOOM, e.clientX, e.clientY);
    } else {
      lastTap.current = now;
      // a tap on the dark area (not the picture) closes, unless zoomed in
      if (!onImage && viewRef.current.s === 1) onClose();
    }
  };
  const onWheel = (e) => {
    const v = viewRef.current;
    zoomAt(v.s * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
  };

  return createPortal(
    <div className="img-lightbox" role="dialog" aria-label={name}>
      <div className="img-lightbox-bar">
        <span className="img-lightbox-name">{name}</span>
        <button className="img-lightbox-btn" onClick={onSave} aria-label="Download">
          <DownloadSimple size={18} />
        </button>
        <button className="img-lightbox-btn" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div
        className="img-lightbox-stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <img
          ref={imgRef}
          src={src}
          alt={name}
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
        />
      </div>
    </div>,
    document.body,
  );
}

/** An image an agent sent — fetched through the gateway once it scrolls into
 *  view, shown inline, expands on tap. `fallback` renders if it can't load
 *  (the plain download card). */
export default function ImagePreview({ path, alt, fallback }) {
  const transport = useTransport();
  const hostRef = useRef(null);
  // No download on the transport → the file is on this machine; the asset
  // protocol streams it off disk, no fetch and no blob needed.
  const local = !transport.download;
  const [seen, setSeen] = useState(false);
  const [img, setImg] = useState(local ? { blob: null, url: convertFileSrc(path) } : null); // { blob, url }
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const name = baseName(path);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver(
      (rows) => rows.some((r) => r.isIntersecting) && (setSeen(true), io.disconnect()),
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen || local) return;
    let dead = false;
    loadImage(transport, path)
      .then((r) => !dead && setImg(r))
      .catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, [seen, local, transport, path]);

  if (failed) return fallback;
  return (
    <span className="chat-image" ref={hostRef}>
      {img ? (
        <button
          type="button"
          className="chat-image-btn"
          onClick={() => setOpen(true)}
          aria-label={`Expand ${alt || name}`}
        >
          <img src={img.url} alt={alt || name} loading="lazy" draggable={false} onError={() => setFailed(true)} />
        </button>
      ) : (
        <span className="chat-image-wait">
          <CircleNotch size={16} className="chat-tool-spin" />
        </span>
      )}
      {open && img && (
        <Lightbox
          src={img.url}
          name={name}
          onSave={() => (img.blob ? saveBlob(img.blob, name) : revealItemInDir(path).catch(() => {}))}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
