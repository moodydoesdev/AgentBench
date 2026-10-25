import { useState } from "react";
import { DownloadSimple, FileText, CircleNotch } from "@phosphor-icons/react";
import { useTransport } from "../lib/TransportContext";
import { isTauri, revealItemInDir } from "@/lib/ipc";
import ImagePreview, { baseName, isImagePath, saveBlob } from "./ImagePreview";
import AudioPlayer, { isAudioPath } from "./AudioPlayer";

// How an agent sends a file: a markdown link whose target is an absolute path
// on the workstation — `[report.pdf](/Users/me/out/report.pdf)`, `file://…`,
// `~/…` or `C:\…`. (The bundled agentbench-files skill teaches the form.)
export function localPath(href) {
  if (!href) return null;
  let p = href;
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return null;
    }
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // file:///C:/x → C:/x
  } else {
    try {
      p = decodeURIComponent(p);
    } catch { /* keep as written */ }
  }
  return /^(\/|~\/|[A-Za-z]:[\\/])/.test(p) && !p.startsWith("//") ? p : null;
}

/** Download card for a file link. Browser/phone: fetch through the gateway
 *  and save; desktop: the file is already here, so reveal it. */
export default function FileLink({ path, children }) {
  const transport = useTransport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const name = baseName(path);
  const label = children ?? name;

  const onClick = async (ev) => {
    ev.preventDefault();
    if (busy) return;
    setError(null);
    if (isTauri || !transport.download) {
      revealItemInDir(path).catch((e) => setError(String(e?.message || e)));
      return;
    }
    setBusy(true);
    try {
      saveBlob(await transport.download(path), name);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const card = (
    <a
      href="#"
      className={`chat-file-link${error ? " error" : ""}`}
      title={error ? `${path}\n${error}` : isTauri ? `Show ${path}` : `Download ${path}`}
      onClick={onClick}
    >
      <FileText size={14} />
      <span className="chat-file-link-name">{label}</span>
      {busy ? (
        <CircleNotch size={13} className="chat-tool-spin" />
      ) : (
        <DownloadSimple size={13} />
      )}
      {error && <span className="chat-file-link-err">{error}</span>}
    </a>
  );

  // Audio plays in the chat everywhere: desktop streams the local file off
  // disk, browser/phone/remote panes fetch the bytes on the first play tap.
  if (isAudioPath(path)) return <AudioPlayer path={path} fallback={card} />;

  // Pictures show in the chat everywhere (tap to expand): browser/phone
  // fetch through the gateway, desktop streams the local file off disk.
  // The lightbox's download button reveals the file in Finder on desktop.
  if (isImagePath(path)) {
    return <ImagePreview path={path} alt={typeof children === "string" ? children : undefined} fallback={card} />;
  }
  return card;
}
