import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Popover } from "radix-ui";
import { Globe } from "@phosphor-icons/react";

/**
 * Preview a dev server that is running on a linked bench, on this machine.
 *
 * The remote gateway stands up a cookie-gated proxy port in front of the
 * chosen loopback port (its in-tree preview.rs); this popover starts one and
 * opens the handshake URL — which sets the auth cookie and bounces to / — in
 * an in-app preview window. Candidates are scraped from the remote project's
 * pane scrollback, live-probed on that machine; the manual field covers
 * servers AgentBench never saw start.
 *
 * Desktop sibling of the mobile PreviewSheet, same wire calls.
 */
// A gateway from an older install answers new fs reads with "not allowed" —
// say what that actually means instead of parroting the wire error.
function friendly(err, machineName) {
  const s = String(err?.message ?? err);
  return /not allowed/i.test(s)
    ? `${machineName} is running an older gateway — update AgentBench there and relaunch it (or toggle Mobile access off and on).`
    : s;
}

export default function RemotePreviewPopover({ machine, project }) {
  const [open, setOpen] = useState(false);
  const [detected, setDetected] = useState(null); // null = still looking
  const [active, setActive] = useState([]);
  const [hosts, setHosts] = useState([]);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const refresh = () => {
    machine.transport
      .invoke("preview_detect", { cwd: project.cwd })
      .then((d) => setDetected(Array.isArray(d) ? d : []))
      .catch((err) => {
        setDetected([]);
        setError(friendly(err, machine.machine ?? machine.name));
      });
    machine.transport
      .invoke("preview_list", {})
      .then((res) => {
        setActive(res?.previews ?? []);
        setHosts(res?.hosts ?? []);
      })
      .catch(() => setActive([]));
  };

  useEffect(() => {
    if (!open) return;
    setDetected(null);
    setError(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.cwd]);

  // We already reach the gateway by some address; if that is an IP it is
  // proven routable and the preview should ride it. Otherwise fall back to
  // the gateway's candidate list — always IPs, because dev servers' host
  // checks allow IP literals and block unknown names.
  const pickHost = (fresh) => {
    try {
      const h = new URL(machine.url).hostname;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
    } catch {
      /* fall through to the gateway's list */
    }
    return (fresh?.length ? fresh : hosts)[0] ?? null;
  };

  const handshakeUrl = (p, fresh) => {
    const h = pickHost(fresh);
    if (!h) return null;
    const path = p.handshakePath ?? "/__abpv";
    return `http://${h}:${p.publicPort}${path}?t=${p.secret}`;
  };

  const openPreview = (p, fresh, inBrowser = false) => {
    const url = handshakeUrl(p, fresh);
    if (!url) {
      setError("No reachable address for that machine — is Tailscale connected?");
      return;
    }
    if (inBrowser) {
      openUrl(url).catch(() => {});
      return;
    }
    invoke("open_preview_window", {
      url,
      title: `${project.name} :${p.targetPort} — ${machine.machine ?? machine.name}`,
    }).catch((err) => setError(String(err)));
  };

  const start = async (port) => {
    setBusy(port);
    setError(null);
    try {
      const res = await machine.transport.invoke("preview_start", {
        cwd: project.cwd,
        port,
      });
      openPreview(res, res.hosts);
      refresh();
    } catch (err) {
      setError(friendly(err, machine.machine ?? machine.name));
    } finally {
      setBusy(null);
    }
  };

  const stop = (port) =>
    machine.transport.invoke("preview_stop", { port }).then(refresh).catch(() => {});

  const mine = active.filter((p) => p.cwd === project.cwd);
  const activePorts = new Set(mine.map((p) => p.targetPort));
  const candidates = (detected ?? [])
    .filter((d) => !activePorts.has(d.port))
    // dead mentions in old scrollback sort under anything actually listening
    .sort((a, b) => (b.live === true) - (a.live === true));

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="btn-sm"
          title={`Preview a dev server running on ${machine.machine ?? machine.name}`}
        >
          <Globe size={13} weight="bold" /> Preview
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="preview-pop" align="end" sideOffset={8}>
          <div className="preview-pop-head">
            Preview — {project.name}
            <small>proxied from {machine.machine ?? machine.name}</small>
          </div>

          {mine.length > 0 && <div className="preview-pop-sub">Being previewed</div>}
          {mine.map((p) => (
            <div key={p.targetPort} className="preview-pop-row">
              <button className="preview-pop-open" onClick={() => openPreview(p)}>
                <span className="preview-pop-port">:{p.targetPort}</span>
                <small>{p.live === false ? "server stopped" : "open window"}</small>
              </button>
              <button
                className="btn-sm"
                title="Open in your default browser instead"
                onClick={() => openPreview(p, null, true)}
              >
                browser
              </button>
              <button className="btn-sm danger" onClick={() => stop(p.targetPort)}>
                Stop
              </button>
            </div>
          ))}

          {detected == null && <div className="preview-pop-note">Looking for dev servers…</div>}
          {candidates.length > 0 && (
            <div className="preview-pop-sub">Detected in this project</div>
          )}
          {candidates.map((d) => (
            <button
              key={d.port}
              className="preview-pop-row preview-pop-open"
              disabled={busy != null || !d.live}
              onClick={() => start(d.port)}
            >
              <span className="preview-pop-port">:{d.port}</span>
              <small>
                {busy === d.port
                  ? "starting…"
                  : d.live
                    ? `seen in pane ${d.paneId}`
                    : "not listening"}
              </small>
            </button>
          ))}
          {detected != null && candidates.length === 0 && mine.length === 0 && (
            <div className="preview-pop-note">
              No dev server spotted in this project's panes on{" "}
              {machine.machine ?? machine.name}. Start one there, or enter its
              port below.
            </div>
          )}

          <div className="preview-pop-manual">
            <input
              className="mobile-url-input"
              placeholder="Port, e.g. 5173"
              inputMode="numeric"
              value={manual}
              onChange={(e) => setManual(e.target.value.replace(/\D/g, "").slice(0, 5))}
            />
            <button
              className="btn-sm"
              disabled={!manual || busy != null}
              onClick={() => start(Number(manual))}
            >
              Start
            </button>
          </div>

          {error && <div className="preview-pop-warn">{error}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
