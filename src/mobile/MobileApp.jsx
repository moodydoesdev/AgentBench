import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  Bell,
  CaretLeft,
  Desktop,
  Gear,
  HandPalm,
  Plugs,
  Plus,
  SquaresFour,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import ChatView from "../chat/ChatView";
import LogView from "./LogView";
import ChangesView from "./ChangesView";
import UsageView from "./UsageView";

// The MDX toolchain behind plan rendering is the heaviest dependency in the
// app; almost every session never opens a plan, so it loads on first use.
const PlanView = lazy(() => import("./PlanView"));
import { TransportProvider } from "../lib/TransportContext";
import { pairWithGateway } from "../lib/transport";
import { BUILTIN_HARNESSES } from "../settings";
import { THEMES, getTheme } from "../themes";
import { applyTheme, loadThemeId, saveThemeId } from "./theme";
import {
  disablePush,
  enablePush,
  isSubscribed,
  pushSupported,
  setPushPrefs,
  testPush,
} from "./push";
import {
  CLIENT_PROTOCOL,
  baseName,
  groupPanes,
  loadGateways,
  mirrorGatewaysForSw,
  saveGateways,
  useFleet,
} from "./gateways";

const STATUS_LABEL = {
  working: "running",
  done: "done",
  input: "needs input",
  exited: "exited",
};

const ACTIVITY_KEY = "agentbench.activity";
const ACTIVITY_READ_KEY = "agentbench.activityRead";

/** The feed survives reloads — a phone reloads constantly (memory pressure,
    update banner), and losing the night's history every time made it useless
    for catching up. */
function loadActivity() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVITY_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((a) => a?.key).slice(0, 100) : [];
  } catch {
    return [];
  }
}

/** Panes blocked on the user, across every machine. */
function waitingItems(machines) {
  const out = [];
  for (const m of machines) {
    for (const pane of m.panes ?? []) {
      const ask = (m.asks ?? []).some((a) => a.id === pane.id);
      if (!ask && m.statuses?.[pane.id] !== "input") continue;
      out.push({ machine: m, pane, ask });
    }
  }
  return out;
}

/** The one shape ChatScreen needs, built the same from every entry point. */
function paneOpen(machine, pane) {
  const title = machine.titles?.[pane.id] ?? pane.title;
  return {
    url: machine.url,
    paneId: pane.id,
    cwd: pane.cwd,
    label: title || `${pane.harness ?? "agent"} ${pane.id}`,
    subtitle: `${pane.harness ?? "agent"} ${pane.id}`,
    kind: pane.kind,
    chat: isChatPane(pane),
    session: pane.session ?? null,
    machine: machine.machine ?? machine.name,
  };
}

/**
 * Long-press (or right-click, for a desktop browser) on top of a normal tap.
 * A drag cancels it — scrolling a list must never pop the sheet.
 *
 * The click a browser synthesizes when the finger finally lifts is the trap:
 * by then the sheet's backdrop is covering the row, so that ghost click lands
 * on the BACKDROP and instantly closes what the hold just opened. It has to
 * be swallowed at the document level, capture phase — a handler on the row
 * never sees it. The swallow disarms on the next fresh pointerdown (a real
 * tap on the sheet), which also covers browsers that never fire the ghost
 * click at all.
 */
function useLongPress(fire) {
  const s = useRef({ timer: 0, x: 0, y: 0, fired: false }).current;
  const clear = () => {
    clearTimeout(s.timer);
    s.timer = 0;
  };
  const held = () => {
    s.fired = true;
    navigator.vibrate?.(10);
    const cleanup = () => {
      document.removeEventListener("click", swallow, true);
      document.removeEventListener("pointerdown", disarm, true);
    };
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    };
    // pointerdown of the NEXT gesture runs before its click, so real taps
    // land; only the lift of the press that opened the sheet is eaten.
    const disarm = () => cleanup();
    document.addEventListener("click", swallow, true);
    document.addEventListener("pointerdown", disarm, true);
    fire();
  };
  return {
    onPointerDown: (e) => {
      s.fired = false;
      s.x = e.clientX;
      s.y = e.clientY;
      clearTimeout(s.timer);
      s.timer = setTimeout(held, 450);
    },
    onPointerMove: (e) => {
      if (s.timer && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 12) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    // Android fires contextmenu at its own long-press threshold; ours usually
    // lands first, so only fire when it hasn't. On desktop this is the
    // right-click path.
    onContextMenu: (e) => {
      e.preventDefault();
      clear();
      if (!s.fired) held();
    },
  };
}

/** An agent row that taps to open and holds for the action sheet. */
function PaneRow({ className, onTap, onHold, children }) {
  const press = useLongPress(onHold);
  return (
    <button className={className} onClick={onTap} {...press}>
      {children}
    </button>
  );
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

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
  const [activity, setActivity] = useState(loadActivity);
  const [activityRead, setActivityRead] = useState(
    () => Number(localStorage.getItem(ACTIVITY_READ_KEY)) || 0,
  );
  // A notification tapped with no window open lands on /?pane=…&machine=…
  // (sw.js falls back to a URL when there is no client to postMessage); a
  // manifest shortcut lands on /?tab=…. Held until the fleet knows the pane.
  const [pendingOpen, setPendingOpen] = useState(() => {
    const q = new URLSearchParams(location.search);
    return q.get("pane")
      ? { paneId: q.get("pane"), machine: q.get("machine") }
      : null;
  });
  const [pairing, setPairing] = useState(null); // { state, message }
  // Long-pressed row → action sheet. Held as ids, not objects: the fleet
  // keeps updating underneath, and the sheet should show live status (and
  // vanish if the pane exits while it's up).
  const [paneSheet, setPaneSheet] = useState(null); // { url, paneId }
  const [updateReady, setUpdateReady] = useState(false);
  const [theme, setTheme] = useState(loadThemeId);
  const { machines, refresh } = useFleet(gateways);

  useEffect(() => {
    saveThemeId(theme);
    applyTheme(theme);
  }, [theme]);

  // A new build is on the workstation; reloading is the user's call so it
  // cannot interrupt a message being typed.
  useEffect(() => {
    const onUpdate = () => setUpdateReady(true);
    window.addEventListener("agentbench:update-ready", onUpdate);
    return () => window.removeEventListener("agentbench:update-ready", onUpdate);
  }, []);

  useEffect(() => saveGateways(gateways), [gateways]);

  useEffect(() => {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity.slice(0, 100)));
  }, [activity]);

  // Keep the service worker's copy of the pairings fresh — including the
  // machine name each gateway reported, which is what push payloads carry.
  useEffect(() => {
    mirrorGatewaysForSw(
      machines.map((m) => ({
        url: m.url,
        token: m.token,
        name: m.name ?? null,
        machine: m.machine ?? null,
      })),
    );
  }, [machines.map((m) => `${m.url}|${m.machine ?? ""}`).join(",")]);

  // Opening the tab is what "reading" means here; new rows arriving while the
  // tab is showing are read too, hence activity.length in the deps.
  useEffect(() => {
    if (tab !== "activity") return;
    const now = Date.now();
    setActivityRead(now);
    localStorage.setItem(ACTIVITY_READ_KEY, String(now));
  }, [tab, activity.length]);

  // Shortcut / cold-notification URL params, consumed once.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const t = q.get("tab");
    if (t === "activity" || t === "settings") setTab(t);
    if (t || q.get("pane"))
      history.replaceState(null, "", location.pathname + location.hash);
  }, []);

  useEffect(() => {
    if (!pendingOpen) return;
    const target = machines.find(
      (m) => m.machine === pendingOpen.machine || m.name === pendingOpen.machine,
    );
    const pane = target?.panes?.find(
      (p) => String(p.id) === String(pendingOpen.paneId),
    );
    if (!target || !pane) return;
    setPendingOpen(null);
    setOpen(paneOpen(target, pane));
  }, [machines, pendingOpen]);

  // Tapping a notification focuses the app; the service worker tells us which
  // agent it was about so the tap lands somewhere useful.
  useEffect(() => {
    const onMessage = (ev) => {
      if (ev.data?.type !== "open-pane") return;
      const { machine, paneId } = ev.data;
      const target = machines.find(
        (m) => m.machine === machine || m.name === machine,
      );
      const pane = target?.panes?.find((p) => String(p.id) === String(paneId));
      if (!target || !pane) return;
      setOpen(paneOpen(target, pane));
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [machines]);

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
    const push = (m, paneId, kind) =>
      setActivity((list) =>
        [
          {
            // Date.now() alone collides when two events land in one ms
            key: `${m.url}-${paneId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            machine: m.machine ?? m.name,
            paneId,
            url: m.url,
            kind,
            at: Date.now(),
          },
          ...list,
        ].slice(0, 100),
      );
    for (const m of machines) {
      if (!m.transport) continue;
      offs.push(
        m.transport.listen("agent-event", ({ payload }) =>
          push(m, payload.id, payload.kind),
        ),
        // a question is the most feed-worthy event there is
        m.transport.listen("ask", ({ payload }) => push(m, payload.id, "ask")),
      );
    }
    return () => offs.forEach((p) => p.then?.((f) => f?.()));
    // The transport arrives a render AFTER its machine does. Keying this on
    // the URL list alone meant it ran once while every transport was still
    // null, attached nothing, and never ran again — the feed stayed
    // permanently empty. The dep has to change when a transport appears.
  }, [machines.map((m) => `${m.url}${m.transport ? "+" : "-"}`).join(",")]);

  const unread = activity.filter((a) => a.at > activityRead).length;
  const waiting = waitingItems(machines);

  const sheetMachine = paneSheet
    ? machines.find((m) => m.url === paneSheet.url)
    : null;
  const sheetPane = sheetMachine?.panes?.find(
    (p) => String(p.id) === String(paneSheet.paneId),
  );
  useEffect(() => {
    if (paneSheet && !sheetPane) setPaneSheet(null);
  }, [paneSheet, sheetPane]);

  // The home-screen icon carries the count of panes blocked on an answer —
  // the number that decides whether the phone is worth picking up.
  useEffect(() => {
    if (!("setAppBadge" in navigator)) return;
    (waiting.length
      ? navigator.setAppBadge(waiting.length)
      : navigator.clearAppBadge()
    )?.catch?.(() => {});
  }, [waiting.length]);

  if (open) {
    const machine = machines.find((m) => m.url === open.url);
    return (
      <>
        {updateReady && <UpdateBanner />}
        <ChatScreen
          // remount per pane: tab choice and kill-confirm are per-session state
          key={`${open.url}-${open.paneId}`}
          machine={machine}
          pane={open}
          onBack={() => setOpen(null)}
        />
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
          <FleetScreen
            machines={machines}
            waiting={waiting}
            onOpen={setOpen}
            onActions={(machine, pane) =>
              setPaneSheet({ url: machine.url, paneId: pane.id })
            }
            onAdd={() => setTab("settings")}
          />
        )}
        {tab === "activity" && (
          <ActivityScreen
            items={activity}
            readAt={activityRead}
            machines={machines}
            onOpen={setOpen}
            onClear={() => setActivity([])}
          />
        )}
        {tab === "settings" && (
          <SettingsScreen
            gateways={gateways}
            machines={machines}
            onChange={setGateways}
            theme={theme}
            onTheme={setTheme}
          />
        )}
      </main>

      <nav className="mob-tabs">
        <TabButton icon={SquaresFour} label="Fleet" on={tab === "fleet"} onClick={() => setTab("fleet")} />
        <TabButton icon={Bell} label="Activity" badge={unread} on={tab === "activity"} onClick={() => setTab("activity")} />
        <TabButton icon={Gear} label="Settings" on={tab === "settings"} onClick={() => setTab("settings")} />
      </nav>

      {sheetMachine && sheetPane && (
        <PaneActionSheet
          machine={sheetMachine}
          pane={sheetPane}
          onClose={() => setPaneSheet(null)}
          onOpen={setOpen}
        />
      )}
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

/** Everything blocked on an answer, across all machines, in one tappable
    place — the reason the app got opened, so it goes first. */
function WaitingSection({ waiting, onOpen, onActions }) {
  if (!waiting.length) return null;
  return (
    <section className="mob-waiting">
      <div className="mob-machine-head mob-waiting-head">
        <HandPalm size={13} weight="bold" />
        <span>Waiting on you</span>
      </div>
      {waiting.map(({ machine, pane, ask }) => {
        const title = machine.titles?.[pane.id] ?? pane.title;
        return (
          <PaneRow
            key={`${machine.url}-${pane.id}`}
            className="mob-agent"
            onTap={() => onOpen(paneOpen(machine, pane))}
            onHold={() => onActions(machine, pane)}
          >
            <span className="mob-agent-name">
              <span className="mob-agent-title">
                {title || `${pane.harness ?? "agent"} ${pane.id}`}
              </span>
              <span className="mob-agent-id">
                {baseName(pane.cwd)} · {machine.machine ?? machine.name}
              </span>
            </span>
            <span className="mob-ask">{ask ? "question" : "needs input"}</span>
          </PaneRow>
        );
      })}
    </section>
  );
}

function FleetScreen({ machines, waiting, onOpen, onActions, onAdd }) {
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
      <WaitingSection waiting={waiting} onOpen={onOpen} onActions={onActions} />
      {machines.map((m) => (
        <MachineSection key={m.url} machine={m} onOpen={onOpen} onActions={onActions} />
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
  // Recent Claude sessions in this project — resuming one is at least as
  // common a reason to open this sheet as starting cold.
  const [sessions, setSessions] = useState(null);

  useEffect(() => {
    let dead = false;
    machine.transport
      .invoke("list_sessions", { project: project.cwd })
      .then((s) => !dead && setSessions(Array.isArray(s) ? s.slice(0, 5) : []))
      .catch(() => !dead && setSessions([]));
    return () => {
      dead = true;
    };
  }, [project.cwd]);

  const start = async (harness, resume) => {
    setBusy(resume ?? harness.id);
    setError(null);
    try {
      const id = await machine.transport.invoke("create_pane", {
        cwd: project.cwd,
        // a phone-sized terminal; the desktop resizes it when it attaches
        cols: 100,
        rows: 30,
        resume: resume ?? null,
        // theme only means something to Claude's settings file
        theme: harness.claude ? getTheme(loadThemeId()).claudeTheme ?? null : null,
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

  const claude = BUILTIN_HARNESSES.find((h) => h.claude);

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
        {claude && sessions?.length > 0 && (
          <>
            <div className="mob-sheet-sub">Resume a recent session</div>
            {sessions.map((s) => (
              <button
                key={s.sid}
                className="mob-sheet-item mob-sheet-session"
                disabled={busy != null}
                onClick={() => start(claude, s.sid)}
              >
                <span className="mob-sheet-preview">
                  {s.preview || "(no message text)"}
                </span>
                {busy === s.sid ? (
                  <small>starting…</small>
                ) : (
                  <small>
                    {ago(s.mtime)} · {s.msgs} msg{s.msgs === 1 ? "" : "s"}
                  </small>
                )}
              </button>
            ))}
          </>
        )}
        {error && <div className="mob-warn">{error}</div>}
        <button className="mob-sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Held-down agent row: everything you'd want to do to a session without
 * opening it. Ending a session confirms in place — the sheet is one hold and
 * one tap away, which is too easy a path to a kill to make it single-tap.
 */
function PaneActionSheet({ machine, pane, onClose, onOpen }) {
  const [confirmKill, setConfirmKill] = useState(false);
  const [error, setError] = useState(null);
  const title = machine.titles?.[pane.id] ?? pane.title;
  const status = machine.statuses?.[pane.id] ?? "working";
  const chat = isChatPane(pane);

  const go = (view) => {
    onClose();
    onOpen({ ...paneOpen(machine, pane), view });
  };
  const run = (cmd, args) => {
    machine.transport.invoke(cmd, args).catch(() => {});
    onClose();
  };

  return (
    <div className="mob-sheet-backdrop" onClick={onClose}>
      <div className="mob-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mob-sheet-head">
          <strong>{title || `${pane.harness ?? "agent"} ${pane.id}`}</strong>
          <small className="mob-mono">
            {baseName(pane.cwd)} · {machine.machine ?? machine.name} ·{" "}
            {STATUS_LABEL[status] ?? status}
          </small>
        </div>
        <button className="mob-sheet-item" onClick={() => go("chat")}>
          <span>{chat ? "Open chat" : "Open log"}</span>
        </button>
        <button className="mob-sheet-item" onClick={() => go("changes")}>
          <span>View changes</span>
          <small>git diff</small>
        </button>
        {chat && (
          <button className="mob-sheet-item" onClick={() => go("usage")}>
            <span>Usage</span>
            <small>tokens · cost</small>
          </button>
        )}
        {status === "working" && (
          <button
            className="mob-sheet-item"
            onClick={() =>
              run("interrupt_pane", { id: pane.id, resubmit: false })
            }
          >
            <span>Stop the current turn</span>
            <small>like Esc</small>
          </button>
        )}
        <button
          className="mob-sheet-item mob-sheet-danger"
          onClick={() =>
            confirmKill
              ? machine.transport
                  .invoke("kill_pane", { id: pane.id })
                  .then(onClose)
                  .catch((e) => setError(String(e.message ?? e)))
              : setConfirmKill(true)
          }
        >
          <span>{confirmKill ? "Tap again to end it" : "End session"}</span>
          <small>{confirmKill ? "closes on every device" : ""}</small>
        </button>
        {error && <div className="mob-warn">{error}</div>}
        <button className="mob-sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function MachineSection({ machine, onOpen, onActions }) {
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
              <PaneRow
                key={pane.id}
                className="mob-agent"
                onTap={() => onOpen(paneOpen(machine, pane))}
                onHold={() => onActions(machine, pane)}
              >
                {/* What the session is about beats what it is called: several
                    agents per project is the norm and they all run the same
                    harness, so "claude 17" says nothing. */}
                <span className="mob-agent-name">
                  {pane.title ? (
                    <>
                      <span className="mob-agent-title">{pane.title}</span>
                      <span className="mob-agent-id">
                        {pane.harness ?? "agent"} {pane.id}
                      </span>
                    </>
                  ) : (
                    <>
                      {pane.harness ?? "agent"}{" "}
                      <span className="mob-agent-id">{pane.id}</span>
                    </>
                  )}
                </span>
                {!isChatPane(pane) && <span className="mob-agent-kind">log</span>}
                {machine.asks?.some((a) => a.id === pane.id) && (
                  <span className="mob-ask">question</span>
                )}
                <span className={`mob-agent-status ${pane.status}`}>
                  {STATUS_LABEL[pane.status] ?? pane.status}
                </span>
              </PaneRow>
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
  const [confirmKill, setConfirmKill] = useState(false);
  const [killError, setKillError] = useState(null);
  // The action sheet can open a pane straight onto a tab ("View changes").
  const [view, setView] = useState(pane.view ?? "chat");
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
            {pane.subtitle ? `${pane.subtitle} · ` : ""}
            {baseName(pane.cwd)} · {pane.machine}
          </small>
        </div>
        <span className="mob-spacer" />
        <span className={`mob-agent-status ${status}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
        <button
          className="mob-icon"
          aria-label="End session"
          onClick={() => setConfirmKill(true)}
        >
          <Trash size={16} />
        </button>
      </header>
      {confirmKill && (
        <div className="mob-kill-bar">
          <span>
            {killError
              ? `Couldn't end it: ${killError}`
              : "End this session? The pane closes on every device."}
          </span>
          <button
            className="mob-kill-go"
            onClick={() =>
              machine.transport
                .invoke("kill_pane", { id: pane.paneId })
                .then(onBack)
                .catch((err) => setKillError(String(err.message ?? err)))
            }
          >
            End
          </button>
          <button
            className="mob-kill-keep"
            onClick={() => {
              setConfirmKill(false);
              setKillError(null);
            }}
          >
            Keep
          </button>
        </div>
      )}
      <nav className="mob-pane-tabs">
        {[
          ["chat", chat ? "Chat" : "Log"],
          ["changes", "Changes"],
          ...(chat ? [["plan", "Plan"], ["usage", "Usage"]] : []),
        ].map(([id, label]) => (
          <button
            key={id}
            className={`mob-pane-tab${view === id ? " on" : ""}`}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {/* The chat stays mounted while other tabs show: unmounting drops the
          transcript watch and scroll position, and a diff peek shouldn't
          cost a full reload on the way back. */}
      <div className="mob-pane-view" style={view === "chat" ? undefined : { display: "none" }}>
        {chat ? (
          <TransportProvider transport={machine.transport}>
            <ChatView
              id={pane.paneId}
              cwd={pane.cwd}
              mode={pane.kind === "chat" ? "stream" : "transcript"}
              placeholder="Message Claude…"
              // A question posed while the phone was asleep only exists in the
              // fleet snapshot; without this the agent looks idle rather than
              // blocked on an answer.
              pendingAsks={(machine.asks ?? []).filter((a) => a.id === pane.paneId)}
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
      {view === "changes" && (
        <div className="mob-pane-view">
          <ChangesView transport={machine.transport} cwd={pane.cwd} />
        </div>
      )}
      {view === "plan" && (
        <div className="mob-pane-view">
          <Suspense fallback={<div className="mob-note" style={{ margin: 14 }}>Loading plan viewer…</div>}>
            <PlanView
              transport={machine.transport}
              cwd={pane.cwd}
              onSend={(text) => sendToPane(machine.transport, pane, text)}
            />
          </Suspense>
        </div>
      )}
      {view === "usage" && (
        <div className="mob-pane-view">
          <UsageView transport={machine.transport} cwd={pane.cwd} sid={pane.session} />
        </div>
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

const ACTIVITY_LABEL = {
  done: "finished",
  ask: "asked a question",
};

function ActivityScreen({ items, readAt, machines, onOpen, onClear }) {
  // What counted as read when this tab was OPENED. The live readAt updates
  // the moment the tab shows (that is what clears the badge), so styling
  // against it would dim every row before it could be seen as new.
  const [seenAt] = useState(readAt);
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
      {items.map((a) => {
        const m = machines.find((x) => x.url === a.url);
        const pane = m?.panes?.find((p) => String(p.id) === String(a.paneId));
        const title = m?.titles?.[a.paneId] ?? pane?.title;
        return (
          <button
            key={a.key}
            className={`mob-activity-row${a.at > seenAt ? " unread" : ""}${pane ? "" : " stale"}`}
            title={pane ? undefined : "This agent has since closed"}
            onClick={() => m && pane && onOpen(paneOpen(m, pane))}
          >
            <span className={`mob-dot ${a.kind === "done" ? "done" : "input"}`} />
            <span className="mob-activity-text">
              {title || `Agent ${a.paneId}`}{" "}
              {ACTIVITY_LABEL[a.kind] ?? "needs input"}
            </span>
            <span className="mob-activity-meta">
              {a.machine} · {ago(a.at)}
            </span>
          </button>
        );
      })}
      <button className="mob-activity-clear" onClick={onClear}>
        Clear history
      </button>
    </div>
  );
}

/** Local-time "HH:MM" → minutes-of-day in UTC, for the gateway's quiet-hours
    check. DST shifts the mapping until re-saved; close enough for sleep. */
function toUtcMinutes(hm) {
  const [h, m] = hm.split(":").map(Number);
  return ((h * 60 + m + new Date().getTimezoneOffset()) % 1440 + 1440) % 1440;
}

/** Quiet hours + per-project muting for one machine's notifications. The
    display copy lives on the phone; the gateway holds what it enforces. */
function PushPrefs({ gateway, projects }) {
  const KEY = `agentbench.pushPrefs.${gateway.url}`;
  const [prefs, setPrefs] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) ?? { from: "", to: "", muted: [] };
    } catch {
      return { from: "", to: "", muted: [] };
    }
  });
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async (next) => {
    setPrefs(next);
    localStorage.setItem(KEY, JSON.stringify(next));
    setBusy(true);
    setNote(null);
    try {
      await setPushPrefs(gateway, {
        quiet:
          next.from && next.to
            ? { startUtc: toUtcMinutes(next.from), endUtc: toUtcMinutes(next.to) }
            : null,
        muted: next.muted,
      });
      setNote("Saved.");
    } catch (err) {
      setNote(String(err.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mob-push-prefs">
      <div className="mob-push-quiet">
        <span>Quiet hours</span>
        <input
          type="time"
          value={prefs.from}
          onChange={(e) => save({ ...prefs, from: e.target.value })}
        />
        <span>to</span>
        <input
          type="time"
          value={prefs.to}
          onChange={(e) => save({ ...prefs, to: e.target.value })}
        />
        {(prefs.from || prefs.to) && (
          <button
            className="mob-push-clear"
            onClick={() => save({ ...prefs, from: "", to: "" })}
          >
            clear
          </button>
        )}
      </div>
      {projects.length > 0 && (
        <div className="mob-push-mutes">
          {projects.map((p) => {
            const muted = prefs.muted.includes(p.path);
            return (
              <button
                key={p.path}
                className={`mob-plan-chip${muted ? " off" : ""}`}
                disabled={busy}
                onClick={() =>
                  save({
                    ...prefs,
                    muted: muted
                      ? prefs.muted.filter((x) => x !== p.path)
                      : [...prefs.muted, p.path],
                  })
                }
              >
                {muted ? "🔕 " : ""}
                {p.name || baseName(p.path)}
              </button>
            );
          })}
        </div>
      )}
      {note && <div className="mob-note">{note}</div>}
    </div>
  );
}

/** Notification opt-in for one machine. */
function PushRow({ gateway, machines }) {
  const live = machines.find((m) => m.url === gateway.url);
  const [state, setState] = useState("off");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  // Holding the permission is not the same as being subscribed to this
  // machine, so ask rather than assume.
  useEffect(() => {
    let dead = false;
    isSubscribed(gateway).then((on) => {
      if (!dead) setState(on ? "on" : "off");
    });
    return () => {
      dead = true;
    };
  }, [gateway.url, gateway.token]);

  const run = async (fn, done) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      setNote(done);
    } catch (err) {
      setNote(String(err.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mob-card">
      <div className="mob-card-head">
        <span className={`mob-dot ${live?.connected ? "ok" : "off"}`} />
        <strong>{live?.machine ?? gateway.name}</strong>
        <span className="mob-spacer" />
        <span className="mob-pill">{state === "on" ? "on" : "off"}</span>
      </div>
      <p className="mob-note" style={{ padding: "4px 0 8px" }}>
        Get told when an agent finishes, needs input, or asks a question — even
        with the app closed.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="mob-sheet-item"
          style={{ flex: 1, justifyContent: "center", marginBottom: 0 }}
          disabled={busy}
          onClick={() =>
            state === "on"
              ? run(
                  () => disablePush(gateway).then(() => setState("off")),
                  "Notifications off.",
                )
              : run(
                  () => enablePush(gateway).then(() => setState("on")),
                  "Notifications on.",
                )
          }
        >
          {busy ? "…" : state === "on" ? "Turn off" : "Turn on"}
        </button>
        {state === "on" && (
          <button
            className="mob-sheet-item"
            style={{ flex: 1, justifyContent: "center", marginBottom: 0 }}
            disabled={busy}
            onClick={() => run(() => testPush(gateway), "Sent — check your notifications.")}
          >
            Send a test
          </button>
        )}
      </div>
      {state === "on" && (
        <PushPrefs gateway={gateway} projects={live?.projects ?? []} />
      )}
      {note && <div className="mob-note">{note}</div>}
    </div>
  );
}

function SettingsScreen({ gateways, machines, onChange, theme, onTheme }) {
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

      <h2>Notifications</h2>
      {!pushSupported() ? (
        <div className="mob-note">
          This browser can't receive notifications. On iPhone, add the app to
          your Home Screen first — Safari only allows them for installed apps.
        </div>
      ) : (
        gateways.map((g) => (
          <PushRow key={g.url} gateway={g} machines={machines} />
        ))
      )}

      <h2>Appearance</h2>
      <div className="mob-card">
        <div className="mob-theme-picker">
          {Object.entries(THEMES).map(([id, t]) => (
            <button
              key={id}
              className={`mob-theme${theme === id ? " on" : ""}`}
              onClick={() => onTheme(id)}
            >
              <span className="theme-chips" style={{ background: t.vars["--bg"] }}>
                <i style={{ background: `rgb(${t.vars["--green"]})` }} />
                <i style={{ background: `rgb(${t.vars["--amber"]})` }} />
                <i style={{ background: t.vars["--text"] }} />
              </span>
              {t.name}
            </button>
          ))}
        </div>
      </div>

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
