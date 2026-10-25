// Local text-to-speech playback. The voice itself (Kokoro) runs on the
// workstation — in-process on the desktop, behind the gateway's `speak_text`
// read for browsers and phones — and answers a WAV; this module plays it,
// one clip at a time, and caches recent clips so replays and voice previews
// are instant.

const CACHE_MAX = 40;
const cache = new Map(); // `${voice}|${speed}|${raw}|${text}` -> AudioBuffer

let current = null; // { source, key }

// Playback goes through Web Audio, not <audio>. WebKit only lets media play
// inside a user gesture, and generating a clip takes long enough that the
// click's permission has lapsed by the time it arrives — <audio>.play() was
// rejected and nothing sounded. An AudioContext resumed during any tap stays
// unlocked for the rest of the visit, which also lets readouts autoplay.
let ctx = null;
function audioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  return ctx;
}
export function unlockAudio() {
  try {
    const c = audioContext();
    if (c.state !== "running") c.resume().catch(() => {});
  } catch {
    /* no Web Audio: nothing to unlock */
  }
}
if (typeof document !== "undefined") {
  for (const ev of ["pointerdown", "keydown", "touchend"])
    document.addEventListener(ev, unlockAudio, { capture: true, passive: true });
}
// Bumped by every speak/stop: a clip that finishes generating after the user
// moved on (clicked another preview, hit stop) is dropped instead of played.
// Without it, slow clips queued up and then played back to back.
let generation = 0;
let pendingKey = null; // what's being generated right now
const listeners = new Set();
const emit = () => listeners.forEach((f) => f(current?.key ?? pendingKey ?? null, !current && !!pendingKey));

// Settings live in another window (or another device), so a cached copy goes
// stale the moment they change there. Speaking re-reads them; the short TTL
// only spares a burst of buttons asking about availability at once.
const PREFS_TTL = 3000;
let prefsCache = null;
let prefsAt = 0;
let prefsPromise = null;

/** Shared speech settings (readouts, voice, speed, available, voices). */
export function loadSpeechPrefs(invoke, fresh = false) {
  if (!fresh && prefsCache && Date.now() - prefsAt < PREFS_TTL) return Promise.resolve(prefsCache);
  if (!fresh && prefsPromise) return prefsPromise;
  prefsPromise = invoke("speech_prefs")
    .then((p) => {
      prefsAt = Date.now();
      return (prefsCache = p);
    })
    .catch(() => (prefsCache = { available: false, readouts: false, voices: [] }))
    .finally(() => (prefsPromise = null));
  return prefsPromise;
}

export async function saveSpeechPrefs(invoke, patch) {
  prefsCache = await invoke("set_speech_prefs", { prefs: patch });
  prefsAt = Date.now();
  return prefsCache;
}

/** Subscribe to the key of whatever is playing (null when quiet). */
export function onSpeaking(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function stopSpeaking() {
  generation++;
  if (pendingKey) {
    pendingKey = null;
    emit();
  }
  if (current) {
    // a Web Audio source (generated clips) or an <audio> wrapper (URL
    // previews) — both expose stop()
    const { source } = current;
    current = null;
    try {
      source.stop();
    } catch {
      /* already ended */
    }
    emit();
  }
}

async function clipBuffer(invoke, text, { voice, speed, raw, engine }) {
  const key = `${engine ?? ""}|${voice}|${speed}|${raw ? 1 : 0}|${text}`;
  const hit = cache.get(key);
  if (hit) {
    // refresh LRU position
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const res = await invoke("speak_text", { text, voice, speed, raw: !!raw, engine });
  const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
  const buffer = await audioContext().decodeAudioData(bytes.buffer);
  cache.set(key, buffer);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return buffer;
}

/**
 * Say `text`. `key` names the thing being spoken (a message, a voice
 * preview) so buttons can show a playing state; speaking the same key again
 * stops it. `raw` skips the server's markdown stripping (readouts are
 * already plain). Resolves when playback ends or is replaced.
 */
export async function speak(invoke, text, { key = text, raw = false, voice, speed, engine } = {}) {
  // tapping what's playing (or still generating) again is "stop"
  if (current?.key === key || pendingKey === key) {
    stopSpeaking();
    return;
  }
  stopSpeaking();
  unlockAudio();
  const gen = generation;
  pendingKey = key;
  emit();
  let buffer;
  try {
    const prefs = await loadSpeechPrefs(invoke);
    // `voice` without `engine` would mix a Kokoro id into another engine;
    // the server falls back to the saved voice for whichever engine runs
    buffer = await clipBuffer(invoke, text, {
      engine,
      voice: voice ?? (engine ? undefined : prefs.engine === "elevenlabs" ? prefs.elevenVoice : prefs.voice),
      speed: speed ?? prefs.speed ?? 1,
      raw,
    });
  } catch (e) {
    if (gen === generation) {
      pendingKey = null;
      emit();
    }
    throw e;
  }
  // the user moved on while this clip was generating: drop it
  if (gen !== generation) return;
  pendingKey = null;
  const c = audioContext();
  // still locked (autoplay with no tap yet this visit): stay silent, the
  // chip replays on tap
  if (c.state !== "running") await c.resume().catch(() => {});
  if (c.state !== "running" || gen !== generation) {
    emit();
    return;
  }
  const source = c.createBufferSource();
  source.buffer = buffer;
  source.connect(c.destination);
  current = { source, key };
  emit();
  return new Promise((resolve) => {
    source.onended = () => {
      if (current?.source === source) {
        current = null;
        emit();
      }
      resolve();
    };
    source.start();
  });
}

/**
 * Play a ready-made clip by URL (ElevenLabs voice previews). Called straight
 * from a click, so a plain <audio> is allowed to play; it joins the same
 * one-at-a-time slot so buttons show it and anything else stops.
 */
export function playUrl(url, key = url) {
  if (current?.key === key) {
    stopSpeaking();
    return Promise.resolve();
  }
  stopSpeaking();
  const audio = new Audio(url);
  const source = { stop: () => audio.pause() };
  current = { source, key };
  emit();
  return new Promise((resolve) => {
    const done = () => {
      if (current?.source === source) {
        current = null;
        emit();
      }
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}
