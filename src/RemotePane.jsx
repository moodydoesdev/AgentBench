import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X, Stop } from "@phosphor-icons/react";
import ChatView from "./chat/ChatView";
import { TransportProvider } from "./lib/TransportContext";

/**
 * A pane that lives on a linked bench, rendered in this machine's grid.
 *
 * The remote machine's gateway speaks the same protocol to us as it does to a
 * phone, so everything here rides the machine's wsTransport: ChatView works
 * untouched once wrapped in a TransportProvider, and the terminal view is an
 * xterm fed by `pane_buffer` backlog plus streamed `pane-output` frames —
 * the wire keeps pty bytes as base64 precisely so a terminal can attach.
 */

const STATUS_LABEL = {
  working: "running",
  done: "done",
  input: "needs input",
  exited: "exited",
};

const FALLBACK_STACK = '"SF Mono", Menlo, Consolas, monospace';
const FONT_STACK = `"FiraCode Nerd Font Mono", ${FALLBACK_STACK}`;

function decodeBase64(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

/** Same paste-then-submit dance the phone does for a remote pty composer. */
function sendToPty(transport, id, text) {
  transport
    .invoke("write_pane", { id, data: `\x1b[200~${text}\x1b[201~` })
    .catch(() => {});
  const submit = () =>
    transport.invoke("write_pane", { id, data: "\r" }).catch(() => {});
  setTimeout(submit, 450);
  setTimeout(submit, 1300);
}

/**
 * Interactive terminal over the wire ops. Keystrokes go out as `write`,
 * output comes back as base64 `pane-output` frames. Attaching resizes the
 * remote pty to this pane's dimensions — tmux semantics: the most recent
 * attach wins the size.
 */
function RemoteTerm({ transport, paneId, termTheme, connected }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const termThemeRef = useRef(termTheme);
  termThemeRef.current = termTheme;

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = termTheme;
  }, [termTheme]);

  useEffect(() => {
    const term = new Xterm({
      fontSize: 13,
      fontFamily: document.fonts.check('13px "FiraCode Nerd Font Mono"')
        ? FONT_STACK
        : FALLBACK_STACK,
      theme: termThemeRef.current,
      allowTransparency: true,
      cursorBlink: true,
      cursorInactiveStyle: "none",
      scrollback: 8000,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((ev, uri) => {
        if (ev.ctrlKey || ev.metaKey) openUrl(uri).catch(() => {});
      }),
    );
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;

    let dead = false;
    // Backlog first, live frames after. Frames that arrive while the backlog
    // request is in flight are buffered so bytes are never written out of
    // order — an escape sequence split across the seam would corrupt the
    // screen.
    let backlogDone = false;
    const held = [];
    transport
      .invoke("pane_buffer", { id: paneId, limit: 512 * 1024 })
      .then((res) => {
        if (dead) return;
        if (res?.buffer) term.write(decodeBase64(res.buffer));
        backlogDone = true;
        for (const chunk of held) term.write(chunk);
        held.length = 0;
      })
      .catch(() => {
        backlogDone = true;
        for (const chunk of held) term.write(chunk);
        held.length = 0;
      });

    const un = transport.listen("pane-output", ({ payload }) => {
      if (payload.id !== paneId) return;
      const bytes = decodeBase64(payload.data);
      if (backlogDone) term.write(bytes);
      else held.push(bytes);
    });

    const unData = term.onData((data) => {
      transport.invoke("write_pane", { id: paneId, data }).catch(() => {});
    });

    const sendSize = () => {
      transport
        .invoke("resize_pane", { id: paneId, cols: term.cols, rows: term.rows })
        .catch(() => {});
    };
    sendSize();
    const ro = new ResizeObserver(() => {
      fit.fit();
      sendSize();
    });
    ro.observe(containerRef.current);

    return () => {
      dead = true;
      ro.disconnect();
      unData.dispose();
      un.then?.((f) => f?.());
      term.dispose();
      termRef.current = null;
    };
  }, [transport, paneId]);

  return (
    <div className="pane-inner">
      <div className="pane-term" ref={containerRef} />
      {!connected && <div className="remote-overlay">reconnecting…</div>}
    </div>
  );
}

/** Chat body for a remote pane; backfills headless scrollback like the phone. */
function RemoteChat({ machine, pane, status }) {
  const headless = pane.kind === "chat";
  const [lines, setLines] = useState(headless ? null : []);
  useEffect(() => {
    if (!headless) return;
    let dead = false;
    machine.transport
      .invoke("pane_buffer", { id: pane.id })
      .then((res) => !dead && setLines(res?.lines ?? []))
      .catch(() => !dead && setLines([]));
    return () => {
      dead = true;
    };
  }, [pane.id]);
  if (lines == null) return <div className="remote-loading">Opening…</div>;
  return (
    <ChatView
      id={pane.id}
      cwd={pane.cwd}
      mode={headless ? "stream" : "transcript"}
      initialLines={lines}
      allowImages
      placeholder={`Message Claude on ${machine.machine ?? machine.name}…`}
      pendingAsks={(machine.asks ?? []).filter((a) => a.id === pane.id)}
      onSend={(text) =>
        headless
          ? machine.transport
              .invoke("write_pane", { id: pane.id, data: text })
              .catch(() => {})
          : sendToPty(machine.transport, pane.id, text)
      }
      onStop={(resubmit) =>
        machine.transport
          .invoke("interrupt_pane", { id: pane.id, resubmit: !!resubmit })
          .catch(() => {})
      }
      status={status}
    />
  );
}

export default function RemotePane({ machine, pane, status, termTheme, defaultView }) {
  const isChat = pane.kind === "chat";
  const isRun = pane.kind === "run";
  const claude = isChat || pane.harness === "claude";
  // Claude pty panes get the same Term/Chat toggle the local grid has; runs
  // and unknown harnesses are terminals, headless chats are chat only.
  const showToggle = claude && !isChat && !isRun;
  const [view, setView] = useState(isChat ? "chat" : showToggle ? defaultView : "term");
  const chatVisible = isChat || (showToggle && view === "chat");
  const name =
    pane.title || (isRun ? pane.harness?.slice(4) || "run" : `${pane.harness ?? "agent"} ${pane.id}`);

  return (
    <TransportProvider transport={machine.transport}>
      <section className={`pane pane-remote status-${status}`}>
        <header className="pane-head">
          <span className={`dot ${status}`} />
          <span className="pane-title">{name}</span>
          <span className="pane-machine" title={`Running on ${machine.machine ?? machine.name}`}>
            {machine.machine ?? machine.name}
          </span>
          <span className="pane-status">{STATUS_LABEL[status] ?? status}</span>
          <span className="pane-cwd" title={pane.cwd}>
            {pane.cwd}
          </span>
          {showToggle && (
            <div className="pane-view-toggle">
              <button
                className={!chatVisible ? "on" : ""}
                title="Terminal view"
                onClick={() => setView("term")}
              >
                Term
              </button>
              <button
                className={chatVisible ? "on" : ""}
                title="Chat view"
                onClick={() => setView("chat")}
              >
                Chat
              </button>
            </div>
          )}
          {status !== "exited" && (
            <button
              className="pane-size"
              title="Interrupt (Esc)"
              onClick={() =>
                machine.transport
                  .invoke("interrupt_pane", { id: pane.id, resubmit: false })
                  .catch(() => {})
              }
            >
              <Stop size={13} weight="bold" />
            </button>
          )}
          <button
            className="pane-close"
            title={`Kill this ${isRun ? "process" : "agent"} on ${machine.machine ?? "the remote machine"}`}
            onClick={() =>
              machine.transport.invoke("kill_pane", { id: pane.id }).catch(() => {})
            }
          >
            <X size={13} weight="bold" />
          </button>
        </header>
        {chatVisible ? (
          <RemoteChat machine={machine} pane={pane} status={status} />
        ) : (
          <RemoteTerm
            transport={machine.transport}
            paneId={pane.id}
            termTheme={termTheme}
            connected={machine.connected}
          />
        )}
      </section>
    </TransportProvider>
  );
}
