import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  Bell,
  CaretLeft,
  Desktop,
  Gear,
  Plugs,
  Plus,
  SquaresFour,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import ChatView from "../chat/ChatView";
import LogView from "./LogView";
import { TransportProvider } from "../lib/TransportContext";
import { pairWithGateway } from "../lib/transport";
import { BUILTIN_HARNESSES } from "../settings";
import {
  CLIENT_PROTOCOL,
  baseName,
  groupPanes,
  loadGateways,
  saveGateways,
  useFleet,
} from "./gateways";

const STATUS_LABEL = {
  working: "running",
  done: "done",
  input: "needs input",
  exited: "exited",
};

/**
 * Only Claude panes keep a transcript, which is what the chat view reads.
 * Everything else — project run commands, and harnesses like codex or gemini —
 * is a terminal, so it belongs in a log rather than being dressed up as a
 * conversation it never had.
 */
function isChatPane(pane) {
  if (pane.kind === "run") return false;
  return pane.harness === "claude" || pane.harness === "claude-chat";
}

/** A pairing QR opens the app with #pair=<base64 handshake>. */
function readPairingHash() {
  const m = /[#&]pair=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return null;
  try {
    const json = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const { u, c, m: machine } = JSON.parse(json);
    return u && c ? { url: u, code: c, machine } : null;
  } catch {
    return null;
  }
}

export default function MobileApp() {
  const [gateways, setGateways] = useState(loadGateways);
  const [tab, setTab] = useState("fleet");
  const [open, setOpen] = useState(null); // { url, paneId, cwd, label }
  const [activity, setActivity] = useState([]);
  const [pairing, setPairing] = useState(null); // { state, message }
  const [updateReady, setUpdateReady] = useState(false);
  const { machines, refresh } = useFleet(gateways);

  // A new build is on the workstation; reloading is the user's call so it
  // cannot interrupt a message being typed.
  useEffect(() => {
    const onUpdate = () => setUpdateReady(true);
    window.addEventListener("agentbench:update-ready", onUpdate);
    return () => window.removeEventListener("agentbench:update-ready", onUpdate);
  }, []);

  useEffect(() => saveGateways(gateways), [gateways]);

  // Scanning the desktop's QR lands here with the handshake in the fragment.
  // Also handled on hashchange, not just mount: once the app is installed, a
  // later scan reuses the running instance and only the fragment changes.
  useEffect(() => {
    const consumeHandshake = () => {
      const handshake = readPairingHash();
      if (!handshake) return;
      history.replaceState(null, "", location.pathname + location.search);
      setTab("fleet");
      setGateways((list) => {
        if (list.some((g) => g.url === handshake.url)) {
          setPairing({ state: "done", message: "That machine is already paired." });
          return list;
        }
        setPairing({
          state: "busy",
          message: `Pairing with ${handshake.machine ?? "workstation"}…`,
        });
        pairWithGateway(handshake.url, handshake.code, deviceName())
          .then((res) => {
            const name = res.machine ?? handshake.machine ?? handshake.url;
            setGateways((cur) =>
              cur.some((g) => g.url === handshake.url)
                ? cur
                : [...cur, { url: handshake.url, token: res.token, name }],
            );
            setPairing({ state: "done", message: `Paired with ${name}.` });
          })
          .catch((err) =>
            setPairing({ state: "error", message: String(err.message ?? err) }),
          );
        return list;
      });
    };
    consumeHandshake();
    window.addEventListener("hashchange", consumeHandshake);
    return () => window.removeEventListener("hashchange", consumeHandshake);
  }, []);

  // Activity feed: one entry per agent event across every machine.
  useEffect(() => {
    const offs = [];
    for (const m of machines) {
      if (!m.transport) continue;
      offs.push(
        m.transport.listen("agent-event", ({ payload }) =>
          setActivity((list) =>
            [
              {
                key: `${m.url}-${payload.id}-${Date.now()}`,
                machine: m.machine ?? m.name,
                paneId: payload.id,
                url: m.url,
                kind: payload.kind,
                at: Date.now(),
              },
              ...list,
            ].slice(0, 50),
          ),
        ),
      );
    }
    return () => offs.forEach((p) => p.then?.((f) => f?.()));
  }, [machines.map((m) => m.url).join(",")]);

  const unread = activity.filter((a) => a.kind !== "done").length;

  if (open) {
    const machine = machines.find((m) => m.url === open.url);
    return (
      <>
        {updateReady && <UpdateBanner />}
        <ChatScreen machine={machine} pane={open} onBack={() => setOpen(null)} />
      </>
    );
  }

  return (
    <div className="mob">
      <header className="mob-top">
        <strong className="mob-brand">AgentBench</strong>
        <span className="mob-spacer" />
        <button className="mob-icon" onClick={refresh} title="Reconnect">
          <ArrowClockwise size={18} />
        </button>
      </header>

      {updateReady && <UpdateBanner />}

      {pairing && (
        <div className={`mob-banner ${pairing.state}`} onClick={() => setPairing(null)}>
          {pairing.message}
        </div>
      )}

      <main className="mob-body">
        {tab === "fleet" && (
          <FleetScreen machines={machines} onOpen={setOpen} onAdd={() => setTab("settings")} />
        )}
        {tab === "activity" && <ActivityScreen items={activity} machines={machines} onOpen={setOpen} />}
        {tab === "settings" && (
          <SettingsScreen
            gateways={gateways}
            machines={machines}
            onChange={setGateways}
          />
        )}
      </main>

      <nav className="mob-tabs">
        <TabButton icon={SquaresFour} label="Fleet" on={tab === "fleet"} onClick={() => setTab("fleet")} />
        <TabButton icon={Bell} label="Activity" badge={unread} on={tab === "activity"} onClick={() => setTab("activity")} />
        <TabButton icon={Gear} label="Settings" on={tab === "settings"} onClick={() => setTab("settings")} />
      </nav>
    </div>
  );
}

function UpdateBanner() {
  return (
    <button
      className="mob-update"
      onClick={() => {
        // A hard reload so the new shell and its assets are fetched rather
        // than restored from the back/forward cache.
        location.reload();
      }}
    >
      AgentBench was updated on your computer — tap to reload
    </button>
  );
}

function TabButton({ icon: Icon, label, on, badge, onClick }) {
  return (
    <button className={`mob-tab${on ? " on" : ""}`} onClick={onClick}>
      <span className="mob-tab-icon">
        <Icon size={20} weight={on ? "fill" : "regular"} />
        {badge > 0 && <span className="mob-badge">{badge}</span>}
      </span>
      <span>{label}</span>
    </button>
  );
}

function FleetScreen({ machines, onOpen, onAdd }) {
  if (machines.length === 0) {
    return (
      <div className="mob-empty">
        <Plugs size={32} />
        <h2>No machines paired</h2>
        <p>
          Open AgentBench on your computer, go to Settings → Mobile access, and
          scan the QR code with this phone's camera.
        </p>
        <button className="mob-primary" onClick={onAdd}>
          Pair a machine
        </button>
      </div>
    );
  }
  return (
    <div className="mob-fleet">
      {machines.map((m) => (
        <MachineSection key={m.url} machine={m} onOpen={onOpen} />
      ))}
    </div>
  );
}

/**
 * Start an agent in a project. Mirrors the desktop's New Agent button: the
 * broker is handed the same harness spec, so a session started from the phone
 * is indistinguishable from one started at the desk.
 */
function NewAgentSheet({ project, machine, onClose, onStarted }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const start = async (harness) => {
    setBusy(harness.id);
    setError(null);
    try {
      const id = await machine.transport.invoke("create_pane", {
        cwd: project.cwd,
        // a phone-sized terminal; the desktop resizes it when it attaches
        cols: 100,
        rows: 30,
        harness: {
          id: harness.id,
          command: harness.command,
          resume: harness.resume ?? null,
          claude: !!harness.claude,
          interactive: !!harness.interactive,
        },
      });
      onStarted({
        url: machine.url,
        paneId: id,
        cwd: project.cwd,
        label: `${harness.id} ${id}`,
        chat: !!harness.claude,
        machine: machine.machine ?? machine.name,
      });
    } catch (err) {
      setError(String(err.message ?? err));
      setBusy(null);
    }
  };

  return (
    <div className="mob-sheet-backdrop" onClick={onClose}>
      <div className="mob-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mob-sheet-head">
          <strong>New agent</strong>
          <small className="mob-mono">{project.cwd}</small>
        </div>
        {BUILTIN_HARNESSES.map((h) => (
          <button
            key={h.id}
            className="mob-sheet-item"
            disabled={busy != null}
            onClick={() => start(h)}
          >
            <span>{h.name}</span>
            {busy === h.id ? (
              <small>starting…</small>
            ) : (
              <small className="mob-mono">{h.command.split(" ")[0]}</small>
            )}
          </button>
        ))}
        {error && <div className="mob-warn">{error}</div>}
        <button className="mob-sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function MachineSection({ machine, onOpen }) {
  const projects = groupPanes(machine);
  const [spawnIn, setSpawnIn] = useState(null);
  const stale =
    machine.protocolVersion != null && machine.protocolVersion !== CLIENT_PROTOCOL;
  return (
    <section className="mob-machine">
      <div className="mob-machine-head">
        <Desktop size={13} />
        <span className="mob-machine-name">
          {machine.machine ?? machine.name ?? baseName(machine.url)}
        </span>
        <span className="mob-spacer" />
        <span className={`mob-dot ${machine.connected ? "ok" : "off"}`} />
        <span className="mob-machine-state">
          {machine.connected ? (machine.brokerConnected === false ? "no broker" : "online") : "offline"}
        </span>
      </div>

      {stale && (
        <div className="mob-warn">
          <WarningCircle size={14} />
          This machine speaks protocol v{machine.protocolVersion}; this app
          expects v{CLIENT_PROTOCOL}. Update AgentBench on both ends.
        </div>
      )}

      {!machine.connected && (
        <div className="mob-note">
          Can't reach this machine. Check that it's awake and Tailscale is
          connected on both devices.
        </div>
      )}

      {machine.connected && projects.length === 0 && (
        <div className="mob-note">No agents running.</div>
      )}

      {!stale &&
        projects.map((proj) => (
          <div key={proj.cwd} className={`mob-card ${proj.status}`}>
            <div className="mob-card-head">
              <span className={`mob-dot ${proj.status}`} />
              <strong>{proj.name}</strong>
              <span className="mob-spacer" />
              <span className="mob-pill">
                {proj.panes.length
                  ? `${proj.panes.length} agent${proj.panes.length === 1 ? "" : "s"}`
                  : "idle"}
              </span>
            </div>
            {proj.panes.map((pane) => (
              <button
                key={pane.id}
                className="mob-agent"
                onClick={() =>
                  onOpen({
                    url: machine.url,
                    paneId: pane.id,
                    cwd: pane.cwd,
                    label: `${pane.harness ?? "agent"} ${pane.id}`,
                    kind: pane.kind,
                    chat: isChatPane(pane),
                    machine: machine.machine ?? machine.name,
                  })
                }
              >
                {/* Several agents per project is the norm, and they all run the
                    same harness — the pane id is what tells them apart. */}
                <span className="mob-agent-name">
                  {pane.harness ?? "agent"} <span className="mob-agent-id">{pane.id}</span>
                </span>
                {!isChatPane(pane) && <span className="mob-agent-kind">log</span>}
                {machine.asks?.some((a) => a.id === pane.id) && (
                  <span className="mob-ask">question</span>
                )}
                <span className={`mob-agent-status ${pane.status}`}>
                  {STATUS_LABEL[pane.status] ?? pane.status}
                </span>
              </button>
            ))}
            <button className="mob-agent mob-new" onClick={() => setSpawnIn(proj)}>
              <Plus size={13} weight="bold" />
              <span className="mob-agent-name">New agent</span>
            </button>
          </div>
        ))}
      {spawnIn && (
        <NewAgentSheet
          project={spawnIn}
          machine={machine}
          onClose={() => setSpawnIn(null)}
          onStarted={(pane) => {
            setSpawnIn(null);
            onOpen(pane);
          }}
        />
      )}
    </section>
  );
}

function ChatScreen({ machine, pane, onBack }) {
  if (!machine?.transport) {
    return (
      <div className="mob">
        <header className="mob-top">
          <button className="mob-icon" onClick={onBack}>
            <CaretLeft size={18} />
          </button>
          <strong className="mob-brand">Disconnected</strong>
        </header>
        <div className="mob-empty">
          <p>Lost the connection to this machine.</p>
          <button className="mob-primary" onClick={onBack}>
            Back to fleet
          </button>
        </div>
      </div>
    );
  }
  const status = machine.statuses?.[pane.paneId] ?? "working";
  const chat = pane.chat;
  return (
    <div className="mob mob-chat-screen">
      <header className="mob-top">
        <button className="mob-icon" onClick={onBack} aria-label="Back">
          <CaretLeft size={18} />
        </button>
        <div className="mob-chat-title">
          <strong>{pane.label}</strong>
          <small>
            {baseName(pane.cwd)} · {pane.machine}
          </small>
        </div>
        <span className="mob-spacer" />
        <span className={`mob-agent-status ${status}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
      </header>
      {chat ? (
        <TransportProvider transport={machine.transport}>
          <ChatView
            id={pane.paneId}
            cwd={pane.cwd}
            mode={pane.kind === "chat" ? "stream" : "transcript"}
            placeholder="Message Claude…"
            onSend={(text) => sendToPane(machine.transport, pane, text)}
            onStop={(resubmit) =>
              machine.transport
                .invoke("interrupt_pane", { id: pane.paneId, resubmit })
                .catch(() => {})
            }
            status={status}
          />
        </TransportProvider>
      ) : (
        <LogView
          transport={machine.transport}
          paneId={pane.paneId}
          onStop={() =>
            machine.transport
              .invoke("interrupt_pane", { id: pane.paneId, resubmit: false })
              .catch(() => {})
          }
        />
      )}
    </div>
  );
}

/**
 * Composer text into a pane. A pty pane needs the same bracketed paste plus
 * delayed Enter the desktop uses — the TUI coalesces an Enter that arrives in
 * the same chunk as the paste into a newline instead of a submit.
 */
function sendToPane(transport, pane, text) {
  if (pane.kind === "chat") {
    transport.invoke("write_pane", { id: pane.paneId, data: text }).catch(() => {});
    return;
  }
  transport
    .invoke("write_pane", { id: pane.paneId, data: `\x1b[200~${text}\x1b[201~` })
    .catch(() => {});
  const submit = () =>
    transport.invoke("write_pane", { id: pane.paneId, data: "\r" }).catch(() => {});
  setTimeout(submit, 450);
  setTimeout(submit, 1300);
}

function ActivityScreen({ items, machines, onOpen }) {
  if (!items.length) {
    return (
      <div className="mob-empty">
        <Bell size={28} />
        <p>Nothing yet. Agent activity across your machines shows up here.</p>
      </div>
    );
  }
  return (
    <div className="mob-activity">
      {items.map((a) => (
        <button
          key={a.key}
          className="mob-activity-row"
          onClick={() => {
            const m = machines.find((x) => x.url === a.url);
            const pane = m?.panes?.find((p) => p.id === a.paneId);
            if (m && pane)
              onOpen({
                url: m.url,
                paneId: pane.id,
                cwd: pane.cwd,
                label: `${pane.harness ?? "agent"} ${pane.id}`,
                kind: pane.kind,
                chat: isChatPane(pane),
                machine: m.machine ?? m.name,
              });
          }}
        >
          <span className={`mob-dot ${a.kind === "done" ? "done" : "input"}`} />
          <span className="mob-activity-text">
            Agent {a.paneId} {a.kind === "done" ? "finished" : "needs input"}
          </span>
          <span className="mob-activity-meta">{a.machine}</span>
        </button>
      ))}
    </div>
  );
}

function SettingsScreen({ gateways, machines, onChange }) {
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const clean = url.trim().replace(/\/+$/, "");
      const res = await pairWithGateway(clean, code.trim(), deviceName());
      onChange([
        ...gateways,
        { url: clean, token: res.token, name: res.machine ?? clean },
      ]);
      setUrl("");
      setCode("");
    } catch (err) {
      setError(String(err.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mob-settings">
      <h2>Machines</h2>
      {gateways.length === 0 && <p className="mob-note">Nothing paired yet.</p>}
      {gateways.map((g) => {
        const live = machines.find((m) => m.url === g.url);
        return (
          <div key={g.url} className="mob-card">
            <div className="mob-card-head">
              <span className={`mob-dot ${live?.connected ? "ok" : "off"}`} />
              <strong>{live?.machine ?? g.name}</strong>
              <span className="mob-spacer" />
              <button
                className="mob-icon"
                aria-label="Forget machine"
                onClick={() => onChange(gateways.filter((x) => x.url !== g.url))}
              >
                <Trash size={16} />
              </button>
            </div>
            <div className="mob-mono">{g.url}</div>
          </div>
        );
      })}

      <h2>This app</h2>
      <div className="mob-card">
        <div className="mob-card-head">
          <strong>Build</strong>
          <span className="mob-spacer" />
          <span className="mob-mono">
            {typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "dev"}
          </span>
        </div>
        <p className="mob-note" style={{ padding: "6px 0 0" }}>
          An installed app keeps running the version it loaded. If this is older
          than the workstation's build, reload to pick up changes.
        </p>
        <button
          className="mob-sheet-item"
          style={{ marginTop: 8 }}
          onClick={async () => {
            // Clear the shell cache too: a plain reload can be served from it.
            if ("caches" in window) {
              const keys = await caches.keys();
              await Promise.all(keys.map((k) => caches.delete(k)));
            }
            const reg = await navigator.serviceWorker?.getRegistration();
            await reg?.update().catch(() => {});
            location.reload();
          }}
        >
          <span>Reload to latest</span>
          <small>clears the cached shell</small>
        </button>
      </div>

      <h2>Pair another machine</h2>
      <p className="mob-note">
        Easiest: open Settings → Mobile access on that computer and scan the QR
        with this phone's camera. Or enter it by hand:
      </p>
      <input
        className="mob-input"
        placeholder="https://machine.tailnet.ts.net"
        value={url}
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        className="mob-input"
        placeholder="Pairing code (1234-5678)"
        value={code}
        inputMode="numeric"
        onChange={(e) => setCode(e.target.value)}
      />
      {error && <div className="mob-warn">{error}</div>}
      <button className="mob-primary" disabled={busy || !url || !code} onClick={add}>
        {busy ? "Pairing…" : "Pair"}
      </button>
    </div>
  );
}

function deviceName() {
  const ua = navigator.userAgent;
  const m = /(iPhone|iPad|Android[^;)]*|Macintosh|Windows)/.exec(ua);
  return m ? m[1].trim() : "Phone";
}
