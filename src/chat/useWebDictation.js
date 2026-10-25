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
 *
 * Android Chrome breaks the list's contract in continuous mode: rather than
 * revising one result, it pushes a new result per update, each holding the
 * whole phrase so far ("can you", "can you check", "can you check and see").
 * Joining those gives "can youcan you checkcan you check and see". So a result
 * that extends the one before it replaces it instead of following it.
 */
const norm = (s) => s.replace(/\s+/g, " ").trim();

export function transcriptFromResults(results) {
  const segments = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const text = norm(result[0]?.transcript ?? "");
    if (!text) continue;
    const prev = segments[segments.length - 1];
    if (prev && text.toLowerCase().startsWith(prev.text.toLowerCase())) {
      segments[segments.length - 1] = { text, isFinal: result.isFinal };
    } else {
      segments.push({ text, isFinal: result.isFinal });
    }
  }
  const join = (list) => list.map((s) => s.text).join(" ");
  return {
    final: join(segments.filter((s) => s.isFinal)),
    text: join(segments),
  };
}

export default function useWebDictation({ onPartial, onFinal, onError } = {}) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  // The transcript as of the last result: earlier sessions plus this one.
  const textRef = useRef("");
  // Text from sessions that already ended. Android Chrome ends a session after
  // a second or two of silence even with `continuous` on, so one press can
  // span several sessions, and each new one starts with an empty result list.
  const carryRef = useRef("");
  // True from start() until the user stops or cancels. A session that ends
  // while this is set ended on its own, and is reopened.
  const wantRef = useRef(false);
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

  const finish = () => {
    wantRef.current = false;
    recRef.current = null;
    setListening(false);
    const text = textRef.current;
    if (!abandonedRef.current && text) handlers.current.onFinal?.(text);
  };

  const open = () => {
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    const carry = carryRef.current;
    const opened = Date.now();
    let heard = false;

    rec.onresult = (ev) => {
      const { final, text } = transcriptFromResults(ev.results);
      // Commit what the user last saw: a stop can land between a cumulative
      // interim and its final, when `final` alone would drop the phrase.
      const session = final.length >= text.length ? final : text;
      heard ||= !!session;
      textRef.current = [carry, session].filter(Boolean).join(" ");
      if (!abandonedRef.current) handlers.current.onPartial?.(textRef.current);
    };

    rec.onerror = (ev) => {
      // "no-speech" and "aborted" are ordinary outcomes of a pause or a short
      // press, not failures worth putting in front of the user.
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      // Anything else would fail again on reopen.
      wantRef.current = false;
      const message =
        ev.error === "not-allowed"
          ? "microphone permission denied"
          : String(ev.error);
      handlers.current.onError?.(message);
    };

    rec.onend = () => {
      if (recRef.current !== rec) return;
      // A session that dies at once without hearing anything would spin here.
      const quickEmpty = !heard && Date.now() - opened < 1000;
      if (wantRef.current && !abandonedRef.current && !quickEmpty) {
        carryRef.current = textRef.current;
        open();
      } else {
        finish();
      }
    };

    try {
      rec.start();
      recRef.current = rec;
    } catch (err) {
      handlers.current.onError?.(String(err));
      finish();
    }
  };

  const start = useCallback(() => {
    if (!SpeechRecognition || recRef.current) return;
    textRef.current = "";
    carryRef.current = "";
    abandonedRef.current = false;
    wantRef.current = true;
    setListening(true);
    open();
  }, []);

  const stop = useCallback(() => {
    wantRef.current = false;
    setListening(false);
    const rec = recRef.current;
    if (!rec) return;
    // onend delivers the final text, once the recognizer settles the tail
    try {
      rec.stop();
    } catch {
      finish();
    }
  }, []);

  const cancel = useCallback(() => {
    abandonedRef.current = true;
    wantRef.current = false;
    teardown();
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (wantRef.current) stop();
    else start();
  }, [start, stop]);

  // Leaving the screen mid-phrase must not hold the microphone open.
  useEffect(
    () => () => {
      wantRef.current = false;
      teardown();
    },
    [],
  );

  return {
    available: !!SpeechRecognition,
    listening,
    start,
    stop,
    cancel,
    toggle,
  };
}
