import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import useWebDictation from "./useWebDictation";

// On-device dictation, driven by the Rust side (see src-tauri/src/dictation.rs).
// One microphone means one session process-wide, so the backend emits to every
// window and each caller filters for its own — `mine` below.
//
// Partial results are revisions, not additions: the recognizer rewrites the
// whole phrase as it gains context ("to" -> "two" -> "too"). Callers get the
// full text each time and should replace, never append. The final result can
// still differ from the last partial, because ending the audio lets the
// recognizer re-score the tail.
// Dictation is driven by the desktop's Rust side, so it only exists inside the
// Tauri webview. Outside it — the mobile PWA — these APIs are absent, and the
// browser's own recognizer stands in, so the composer gets a working mic in
// both places from one hook.
const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function useDictation(options = {}) {
  const native = useNativeDictation(options);
  const web = useWebDictation(options);
  return HAS_TAURI ? native : web;
}

function useNativeDictation({ onPartial, onFinal, onError } = {}) {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  // True between our own start() and the session ending. Gates the shared
  // events so a second chat pane doesn't type what this one dictated.
  const mine = useRef(false);

  // Keep the callbacks off the subscription's dependency list — they're
  // redefined every render, and resubscribing per keystroke would drop events.
  const handlers = useRef({});
  handlers.current = { onPartial, onFinal, onError };

  useEffect(() => {
    if (!HAS_TAURI) return;
    invoke("dictation_available").then(setAvailable).catch(() => {});
  }, []);

  useEffect(() => {
    if (!HAS_TAURI) return;
    const subs = [
      listen("dictation://partial", (e) => {
        if (mine.current) handlers.current.onPartial?.(e.payload.text);
      }),
      listen("dictation://final", (e) => {
        if (!mine.current) return;
        mine.current = false;
        handlers.current.onFinal?.(e.payload.text);
      }),
      listen("dictation://error", (e) => {
        if (!mine.current) return;
        mine.current = false;
        handlers.current.onError?.(e.payload.message);
      }),
      listen("dictation://state", (e) => {
        if (mine.current) setListening(e.payload.listening);
      }),
    ];
    return () => subs.forEach((p) => p.then((un) => un()));
  }, []);

  const start = useCallback(() => {
    if (mine.current) return;
    mine.current = true;
    // Optimistic: the mic takes a moment to open (and may prompt the first
    // time), and an unlit button in the meantime reads as a dropped press.
    setListening(true);
    invoke("dictation_start").catch((err) => {
      mine.current = false;
      setListening(false);
      handlers.current.onError?.(String(err));
    });
  }, []);

  // Stop, but keep `mine` set — the final result is still owed to us.
  const stop = useCallback(() => {
    if (!mine.current) return;
    setListening(false);
    invoke("dictation_stop").catch(() => {});
  }, []);

  const cancel = useCallback(() => {
    if (!mine.current) return;
    mine.current = false;
    setListening(false);
    invoke("dictation_cancel").catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    if (mine.current) stop();
    else start();
  }, [start, stop]);

  // A pane that unmounts mid-phrase must not leave the mic open — but only
  // ours: another pane may own the session.
  useEffect(
    () => () => {
      if (mine.current) invoke("dictation_cancel").catch(() => {});
    },
    [],
  );

  return { available, listening, start, stop, cancel, toggle };
}
