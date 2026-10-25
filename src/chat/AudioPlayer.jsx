import { useState } from "react";
import { CircleNotch, DownloadSimple, Play, SpeakerHigh } from "@phosphor-icons/react";
import { useTransport } from "../lib/TransportContext";
import { convertFileSrc } from "@/lib/ipc";
import { baseName, saveBlob } from "./ImagePreview";

// Audio-only extensions; webm/mp4 are left to the file card — ambiguous with
// video. Safari refuses octet-stream blobs, so the MIME type is load-bearing.
const MIME = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  aiff: "audio/aiff",
  aif: "audio/aiff",
};

const extOf = (p) => /\.([A-Za-z0-9]+)$/.exec(p)?.[1].toLowerCase() ?? "";
export const isAudioPath = (p) => !!p && extOf(p) in MIME;

// path → Promise<{ blob, url }>, shared across remounts: chat rows unmount as
// the list scrolls, and refetching a multi-MB file per scroll-back would hurt.
const cache = new Map();
function loadAudio(transport, path) {
  let hit = cache.get(path);
  if (!hit) {
    hit = transport
      .download(path)
      .then((raw) => {
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

/** An audio file an agent sent — a player card in the chat. Local desktop
 *  panes stream straight off disk (asset protocol does range requests, so
 *  seeking works); browser/phone/remote panes fetch the bytes through the
 *  gateway on the first play tap, never on scroll — files can be big and
 *  there's no size hint before fetching. `fallback` renders if the file
 *  can't load (the plain download card). */
export default function AudioPlayer({ path, fallback }) {
  const transport = useTransport();
  // No download on the transport → the file is on this machine.
  const local = !transport.download;
  const [src, setSrc] = useState(local ? convertFileSrc(path) : null);
  const [blob, setBlob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = baseName(path);

  const fetchAndPlay = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await loadAudio(transport, path);
      setBlob(r.blob);
      setSrc(r.url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (failed) return fallback;
  return (
    <span className="chat-audio" title={path}>
      <span className="chat-audio-head">
        <SpeakerHigh size={14} />
        <span className="chat-audio-name">{name}</span>
        {blob && (
          <button
            type="button"
            className="chat-audio-save"
            onClick={() => saveBlob(blob, name)}
            aria-label={`Download ${name}`}
          >
            <DownloadSimple size={13} />
          </button>
        )}
      </span>
      {src ? (
        // iOS may swallow autoplay once the gesture crosses the async fetch;
        // the controls are there either way, so that's one extra tap, not a bug.
        <audio controls preload="metadata" src={src} autoPlay={!local} onError={() => setFailed(true)} />
      ) : (
        <button type="button" className="chat-audio-fetch" onClick={fetchAndPlay} disabled={busy}>
          {busy ? <CircleNotch size={14} className="chat-tool-spin" /> : <Play size={14} weight="fill" />}
          {busy ? "Loading…" : "Play"}
        </button>
      )}
    </span>
  );
}
