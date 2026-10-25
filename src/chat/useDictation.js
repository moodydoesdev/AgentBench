import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@/lib/ipc";
import { invoke } from "@/lib/ipc";
import useWebDictation from "./useWebDictation";
import useParakeetDictation from "./useParakeetDictation";
import { useTransport } from "@/lib/TransportContext";

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

// In the browser, the workstation's Parakeet wins when its gateway has the
// model; the phone's recognizer is the fallback.
export default function useDictation(options = {}) {
  const transport = useTransport();
  const native = useNativeDictation(options);
  const parakeet = useParakeetDictation(HAS_TAURI ? null : transport, options);
  const web = useWebDictation(options);
  if (HAS_TAURI) return native;
  return parakeet.available ? parakeet : web;
}

function useNativeDictation({ onPartial, onFinal, onError, onLevel, onStatus } = {}) {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  // True between our own start() and the session ending. Gates the shared
  // events so a second chat pane doesn't type what this one dictated.
  const mine = useRef(false);

  // Keep the callbacks off the subscription's dependency list — they're
  // redefined every render, and resubscribing per keystroke would drop events.
  const handlers = useRef({});
  handlers.current = { onPartial, onFinal, onError, onLevel, onStatus };

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
      // Mic loudness 0–1, ~30/s. Only the macOS 26 engine sends it; callers
      // must cope with never hearing one.
      listen("dictation://level", (e) => {
        if (mine.current) handlers.current.onLevel?.(e.payload.level);
      }),
      listen("dictation://status", (e) => {
        if (mine.current) handlers.current.onStatus?.(e.payload.message);
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
