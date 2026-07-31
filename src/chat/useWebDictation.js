import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dictation in the browser, for the mobile PWA.
 *
 * The desktop drives a native recognizer through Rust; a phone already has one
 * behind the Web Speech API, so the PWA uses that instead of shipping audio
 * anywhere. The hook deliberately mirrors `useDictation`'s shape — the same
 * `{ available, listening, start, stop, cancel, toggle }` — so the composer
 * cannot tell which one it is talking to.
 *
 * Partial results are revisions of the whole phrase, not additions, matching
 * the desktop contract: callers replace the transcript rather than append.
 */
const SpeechRecognition =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : undefined;

export default function useWebDictation({ onPartial, onFinal, onError } = {}) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const finalRef = useRef("");
  // Set when the user cancels, so the recognizer's trailing result is dropped
  // instead of being typed into the composer after they asked to discard it.
  const abandonedRef = useRef(false);

  const handlers = useRef({});
  handlers.current = { onPartial, onFinal, onError };

  const teardown = () => {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.stop();
    } catch {
      // already stopped
    }
  };

  const start = useCallback(() => {
    if (!SpeechRecognition || recRef.current) return;
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    finalRef.current = "";
    abandonedRef.current = false;

    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (result.isFinal) finalRef.current += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (!abandonedRef.current) {
        handlers.current.onPartial?.((finalRef.current + interim).trimStart());
      }
    };

    rec.onerror = (ev) => {
      // "no-speech" and "aborted" are ordinary outcomes of a short press, not
      // failures worth putting in front of the user.
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      const message =
        ev.error === "not-allowed"
          ? "microphone permission denied"
          : String(ev.error);
      handlers.current.onError?.(message);
    };

    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      const text = finalRef.current.trim();
      if (!abandonedRef.current && text) handlers.current.onFinal?.(text);
    };

    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch (err) {
      handlers.current.onError?.(String(err));
    }
  }, []);

  const stop = useCallback(() => {
    // onend delivers the final text
    teardown();
  }, []);

  const cancel = useCallback(() => {
    abandonedRef.current = true;
    teardown();
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (recRef.current) stop();
    else start();
  }, [start, stop]);

  // Leaving the screen mid-phrase must not hold the microphone open.
  useEffect(() => () => teardown(), []);

  return {
    available: !!SpeechRecognition,
    listening,
    start,
    stop,
    cancel,
    toggle,
  };
}
