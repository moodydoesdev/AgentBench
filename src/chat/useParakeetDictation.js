import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dictation that runs on the workstation: the browser streams the mic to the
 * gateway, which transcribes it with NVIDIA Parakeet (see
 * src-tauri/src/gateway/dictate.rs). Unlike the phone's own recognizer it
 * doesn't give up at a pause — it listens until the user stops.
 *
 * Same shape and contract as `useDictation`: `{ available, listening, start,
 * stop, cancel, toggle }`, and every partial is the whole transcript so far,
 * so callers replace rather than append.
 */

// Downmixes to mono, resamples to 16 kHz and packs little-endian PCM16 in
// 100 ms frames, with the frame's loudness for the level meter. Resampling
// here rather than asking for a 16 kHz AudioContext: Firefox refuses to
// connect a mic to a context at a different rate than the device.
const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.energy = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch = input[0];
    for (; this.pos < ch.length; this.pos += this.step) {
      const i = Math.floor(this.pos);
      let v = ch[i];
      for (let c = 1; c < input.length; c++) v += input[c][i];
      v /= input.length;
      this.energy += v * v;
      this.out[this.n++] = Math.max(-1, Math.min(1, v)) * 0x7fff;
      if (this.n === this.out.length) {
        const level = Math.min(1, Math.sqrt(this.energy / this.n) * 6);
        this.port.postMessage({ pcm: this.out.buffer, level }, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.n = 0;
        this.energy = 0;
      }
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("pcm16", Pcm16);
`;

let workletUrl = null;
const getWorkletUrl = () =>
  (workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));

// How long to wait for the final transcript after stop before settling for
// the last partial.
const FINAL_TIMEOUT_MS = 8000;

export default function useParakeetDictation(
  transport,
  { onPartial, onFinal, onError, onLevel, onStatus } = {},
) {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  // The live session: socket, mic, audio graph. `null` when idle.
  const sessionRef = useRef(null);

  const handlers = useRef({});
  handlers.current = { onPartial, onFinal, onError, onLevel, onStatus };

  const api = transport?.dictation;
  useEffect(() => {
    setAvailable(false);
    if (!api || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined")
      return;
    let live = true;
    api.available().then((ok) => live && setAvailable(ok));
    return () => {
      live = false;
    };
  }, [api]);

  // Mic and audio graph off. The socket is closed separately: after a stop it
  // still owes the final transcript.
  const releaseAudio = (s) => {
    s.stream?.getTracks().forEach((t) => t.stop());
    s.stream = null;
    s.ctx?.close().catch(() => {});
    s.ctx = null;
  };

  const end = (s, text, error) => {
    if (s.done) return;
    s.done = true;
    clearTimeout(s.timer);
    releaseAudio(s);
    try {
      s.ws?.close();
    } catch {
      // already closed
    }
    if (sessionRef.current === s) sessionRef.current = null;
    setListening(false);
    if (s.abandoned) return;
    if (error) handlers.current.onError?.(error);
    else if (text) handlers.current.onFinal?.(text);
  };

  const start = useCallback(async () => {
    if (!api || sessionRef.current) return;
    const s = { text: "", queue: [], done: false, abandoned: false, stopping: false };
    sessionRef.current = s;
    setListening(true);
    handlers.current.onStatus?.("starting…");

    try {
      s.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const denied = err?.name === "NotAllowedError";
      return end(s, "", denied ? "microphone permission denied" : String(err?.message || err));
    }
    if (s.done) return releaseAudio(s);

    s.ws = api.open();
    s.ws.binaryType = "arraybuffer";
    s.ws.onopen = () => {
      for (const buf of s.queue) s.ws.send(buf);
      s.queue = [];
      if (s.stopping) s.ws.send("stop");
    };
    s.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "partial") {
        s.text = msg.text;
        if (!s.abandoned) {
          handlers.current.onStatus?.(null);
          handlers.current.onPartial?.(msg.text);
        }
      } else if (msg.type === "final") {
        end(s, msg.text || s.text);
      } else if (msg.type === "error") {
        end(s, "", msg.text || "dictation failed");
      }
    };
    // Closing without a final: keep what was already on screen, and only
    // call it an error if the user hadn't asked to stop.
    s.ws.onclose = () =>
      end(s, s.text, s.stopping || s.text ? null : "lost the connection to dictation");

    try {
      s.ctx = new AudioContext();
      await s.ctx.audioWorklet.addModule(getWorkletUrl());
      if (s.done) return releaseAudio(s);
      const node = new AudioWorkletNode(s.ctx, "pcm16", { numberOfOutputs: 0 });
      node.port.onmessage = ({ data }) => {
        if (s.done || s.stopping) return;
        handlers.current.onLevel?.(data.level);
        if (s.ws.readyState === WebSocket.OPEN) s.ws.send(data.pcm);
        else s.queue.push(data.pcm);
      };
      s.ctx.createMediaStreamSource(s.stream).connect(node);
      // Some browsers start a context suspended until a gesture resumes it;
      // the mic tap was that gesture.
      await s.ctx.resume();
      if (!s.text) handlers.current.onStatus?.(null);
    } catch (err) {
      end(s, "", String(err?.message || err));
    }
  }, [api]);

  const stop = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.stopping) return;
    s.stopping = true;
    setListening(false);
    releaseAudio(s);
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send("stop");
    else if (!s.ws || s.ws.readyState > WebSocket.OPEN) return end(s, s.text);
    // onopen sends the stop for a socket still connecting.
    s.timer = setTimeout(() => end(s, s.text), FINAL_TIMEOUT_MS);
  }, []);

  const cancel = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    s.abandoned = true;
    end(s, "");
  }, []);

  const toggle = useCallback(() => {
    const s = sessionRef.current;
    if (s && !s.stopping) stop();
    else if (!s) start();
  }, [start, stop]);

  // Leaving the screen mid-phrase must not hold the microphone open.
  useEffect(
    () => () => {
      const s = sessionRef.current;
      if (!s) return;
      s.abandoned = true;
      end(s, "");
    },
    [],
  );

  return { available, listening, start, stop, cancel, toggle };
}
