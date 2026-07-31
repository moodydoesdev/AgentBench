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

/**
 * The whole phrase, rebuilt from scratch on every event.
 *
 * `results` is cumulative — it holds every result for the session, and an
 * event's `resultIndex` only says where the *changes* begin. Accumulating from
 * that index appends text that is already present, which is what turns
 * "testing testing 1 2 3" into "testingtesting testing 1testing testing 1 2".
 * Reading the full list instead makes this idempotent: however many times an
 * event revises a result, the transcript is whatever the recognizer currently
 * believes was said.
 */
export function transcriptFromResults(results) {
  let final = "";
  let interim = "";
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const text = result[0]?.transcript ?? "";
    if (result.isFinal) final += text;
    else interim += text;
  }
  return { final, text: (final + interim).replace(/\s+/g, " ").trim() };
}

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
      const { final, text } = transcriptFromResults(ev.results);
      finalRef.current = final;
      if (!abandonedRef.current) handlers.current.onPartial?.(text);
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
      const text = finalRef.current.replace(/\s+/g, " ").trim();
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
