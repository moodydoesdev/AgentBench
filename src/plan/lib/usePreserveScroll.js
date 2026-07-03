// Keep the reader's place while the plan document shifts under them.
//
// Live reloads recompile the MDX into a new component type, so the whole
// doc remounts; async blocks (hero canvas portal, mermaid, shiki) mount
// short and grow back over the next frames. WebKit has no native CSS
// scroll anchoring (Chrome does — this is why the bug only shows in the
// Tauri webview), so every one of those layout shifts moves the text under
// the viewport or lets the browser clamp scrollTop.
//
// Strategy: continuously remember which block the reader is looking at
// (recorded from their own scroll events), and whenever the layout shifts
// without them scrolling — DOM swap, async block resize — put that block
// back at the same viewport offset. User scrolls always win: they simply
// re-record the anchor.
import { useLayoutEffect } from "react";

const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,pre,figure,table";

function captureAnchor(scroller) {
  const doc = scroller.querySelector(".plan-doc");
  if (!doc) return null;
  const top = scroller.getBoundingClientRect().top;
  const els = [...doc.querySelectorAll(BLOCKS)];
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (r.bottom > top + 1) {
      return {
        text: (els[i].textContent ?? "").trim().slice(0, 200),
        idx: i,
        offset: r.top - top,
      };
    }
  }
  return null;
}

function restoreAnchor(scroller, anchor) {
  const doc = scroller.querySelector(".plan-doc");
  if (!doc) return;
  const els = [...doc.querySelectorAll(BLOCKS)];
  if (els.length === 0) return;
  let el = anchor.text
    ? els.find((e) => (e.textContent ?? "").trim().slice(0, 200) === anchor.text)
    : null;
  el ??= els[Math.min(anchor.idx, els.length - 1)];
  const dy =
    el.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    anchor.offset;
  if (Math.abs(dy) > 1) scroller.scrollTop += dy;
}

export function usePreserveScroll(ref) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let anchor = null; // where the reader is, by content block
    let lastSH = el.scrollHeight;
    let expected = null; // scrollTop we set ourselves; skip recording it
    let raf = 0;
    let userUntil = 0; // recent input → scrolls are the reader's, never undo

    const markUser = () => {
      userUntil = performance.now() + 250;
    };

    const scheduleRestore = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!anchor) return;
        restoreAnchor(el, anchor);
        expected = el.scrollTop;
        lastSH = el.scrollHeight;
      });
    };

    const onScroll = () => {
      if (performance.now() < userUntil) {
        // reader is driving (incl. momentum) — record, even mid-reload
        expected = null;
        lastSH = el.scrollHeight;
        anchor = captureAnchor(el);
        return;
      }
      if (expected !== null && Math.abs(el.scrollTop - expected) <= 1) {
        expected = null; // our own restore echoing back
        return;
      }
      if (el.scrollHeight !== lastSH) {
        // height changed with this scroll → browser clamp from a layout
        // shift, not the reader — undo it instead of recording it
        lastSH = el.scrollHeight;
        scheduleRestore();
        return;
      }
      expected = null;
      anchor = captureAnchor(el);
    };

    // any resize of the doc (or hero slot) is a layout shift to compensate
    const ro = new ResizeObserver(scheduleRestore);
    const watch = () => {
      ro.disconnect();
      for (const sel of [".plan-doc", ".plan-hero"]) {
        const t = el.querySelector(sel);
        if (t) ro.observe(t);
      }
    };
    // MDX remounts replace the observed nodes — rewatch on DOM swaps
    const mo = new MutationObserver(() => {
      scheduleRestore();
      watch();
    });
    watch();
    mo.observe(el, { childList: true, subtree: true });
    el.addEventListener("scroll", onScroll);
    el.addEventListener("wheel", markUser, { passive: true });
    el.addEventListener("touchmove", markUser, { passive: true });
    el.addEventListener("mousedown", markUser);
    el.addEventListener("keydown", markUser);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", markUser);
      el.removeEventListener("touchmove", markUser);
      el.removeEventListener("mousedown", markUser);
      el.removeEventListener("keydown", markUser);
    };
  }, [ref]);
}
