import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import AgentPane from "./AgentPane";
import ResourcePanel from "./resources/ResourcePanel";
import RemotePane from "./RemotePane";
import RemotePreviewPopover from "./RemotePreviewPopover";
import { groupPanes, loadGateways, saveGateways, useFleet } from "./lib/fleet";
import { reconcileRemoteDock, remoteScope } from "./lib/remoteDock";

// Lazy: keeps mdx/shiki out of the entry chunk until a plan is opened
const PlanOverlay = lazy(() => import("./plan/PlanOverlay.jsx"));
import WindowControls from "./components/WindowControls";
import { getTheme, terminalThemeFromVars, themeVars } from "./themes";
import {
  PROBEABLE,
  SETTINGS_KEY,
  getHarness,
  getHarnesses,
  harnessBin,
  loadSettings,
} from "./settings";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { Cpu, Bell, CalendarCheck, CaretDown, GearSix, Play, Plus, FileText, Pulse, TerminalWindow, Tray, X } from "@phosphor-icons/react";
import { Popover } from "radix-ui";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import RunCommandsDialog from "./RunCommandsDialog";
import TeamsDialog from "./teams/TeamsDialog";
import { missingSeats, normalizeTeams, seatFor } from "./teams/teams";
import SessionsDialog from "./SessionsDialog";
import SchedulesDialog from "./SchedulesDialog";
import TerminalDock from "./dock/TerminalDock";
import TaskRail from "./tasks/TaskRail";
import { setSchedules as feedTaskSchedules, setTaskResources, useTasks } from "./tasks/taskRegistry";
import notifyWav from "./assets/notify.wav";
import Logo, { LogoMark } from "./components/Logo";
import CommandMenu from "./components/CommandMenu";
import PlanComposer from "./PlanComposer";
import { matchesHotkey } from "./lib/hotkey";
import { applyUiScale, resolveUiScale, SCALE_STEPS } from "./lib/uiScale";
import { autoCols, packSpans, resetPaneWidths } from "./lib/gridLayout";
import { pasteAndSubmit } from "./lib/ptyPaste";
import { THEMES } from "./themes";

const ping = new Audio(notifyWav);

const IS_MAC = navigator.userAgent.includes("Mac");
const IS_WINDOWS = navigator.userAgent.includes("Windows");

// Preset swatches for per-project sidebar colors (context menu → Color).
const PROJECT_COLORS = [
  { name: "Red", value: "#f87171" },
  { name: "Orange", value: "#fb923c" },
  { name: "Amber", value: "#fbbf24" },
  { name: "Green", value: "#4ade80" },
  { name: "Teal", value: "#2dd4bf" },
  { name: "Blue", value: "#60a5fa" },
  { name: "Purple", value: "#a78bfa" },
  { name: "Pink", value: "#f472b6" },
];

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

// A harness spec carrying a team seat (see src/teams/teams.js seatFor); the
// broker turns the seat into --name/--model/--append-system-prompt.
function withSeat(harness, seat) {
  return seat ? { ...harness, team: seat } : harness;
}

function baseName(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function App() {
  const [projects, setProjects] = useState(() => loadJSON("agentbench.projects", []));
  const [activePath, setActivePath] = useState(
    () => localStorage.getItem("agentbench.active") || loadJSON("agentbench.projects", [])[0]?.path,
  );
  const [panes, setPanes] = useState([]); // {id, projectPath, label}
  const [planNonces, setPlanNonces] = useState({}); // plan path -> refresh counter
  const [planView, setPlanView] = useState(null); // {path, title, agentId} — full-window overlay
  const [freshPlans, setFreshPlans] = useState(() => new Set()); // paths updated while not viewed
  const [statuses, setStatuses] = useState({}); // id -> status
  const [initialData, setInitialData] = useState({}); // id -> base64 scrollback
  const [titles, setTitles] = useState({}); // id -> session name from OSC title
  const [paneColors, setPaneColors] = useState({}); // id -> /color choice
  const [paneSizes, setPaneSizes] = useState(() =>
    loadJSON("agentbench.paneSizes", {}),
  ); // id -> {w, h} grid spans
  const [paneViews, setPaneViews] = useState(() =>
    loadJSON("agentbench.paneViews", {}),
  ); // id -> "term" | "chat" (Claude panes' read-along toggle)
  const [chatLines, setChatLines] = useState({}); // id -> replayed stream-json lines
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => {
    if (loadSettings().cols) setPaneSizes((sizes) => resetPaneWidths(sizes));
  }, []);
  const [focusedId, setFocusedId] = useState(null);
  const [renaming, setRenaming] = useState(null); // project path being renamed
  const [showPlans, setShowPlans] = useState(
    () => localStorage.getItem("agentbench.showPlans") !== "false",
  );
  const [projectPlans, setProjectPlans] = useState({}); // projectPath -> [{path, slug, title, mtime}]
  const [composerOpen, setComposerOpen] = useState(false); // new-plan composer modal
  const [cmdMenuOpen, setCmdMenuOpen] = useState(false);
  const [notifs, setNotifs] = useState([]); // {key, paneId, kind, label, project, projectPath, ts, read}
  const [notifOpen, setNotifOpen] = useState(false);
  // Inbox: messaging-app-style list of finished chats, one entry per pane
  // (latest turn wins), with the agent's closing words as the snippet.
  // Persisted so finished work survives an app restart.
  const [inbox, setInbox] = useState(() => loadJSON("agentbench.inbox", []));
  const [runDialog, setRunDialog] = useState(null); // project path whose run commands are being edited
  const [teamsDialog, setTeamsDialog] = useState(null); // project path whose teams are being edited
  const [projectTeams, setProjectTeams] = useState({}); // project path → saved teams (.agentbench/teams.json)
  const [sessionsOpen, setSessionsOpen] = useState(false); // resume-session picker
  const [schedulesOpen, setSchedulesOpen] = useState(false); // scheduled prompts
  // Terminal dock: tabbed plain shells along the bottom, per project —
  // shells stop burning grid cells. Dock panes are ordinary broker panes
  // (harness "terminal") carrying a `dock: true` flag that routes them out
  // of the grid.
  const [dockOpen, setDockOpen] = useState(
    () => localStorage.getItem("agentbench.dockOpen") === "true",
  );
  const [dockHeight, setDockHeight] = useState(
    () => Number(localStorage.getItem("agentbench.dockHeight")) || 260,
  );
  const [dockExpanded, setDockExpanded] = useState(false);
  const [dockTabs, setDockTabs] = useState(() =>
    loadJSON("agentbench.dockTabs", {}),
  ); // dock scope (projectPath, or "url::cwd" remote) -> active dock pane id
  // Dock shells that live on linked benches: { [gatewayUrl]: [{ id,
  // projectPath, label }] }. Kept apart from `panes` because those are the
  // local broker's, and ids collide across brokers. Pane ids restart with the
  // bench's broker, so this is reconciled against its live pane list on
  // connect — the same contract the local dock's saved ids follow.
  const [remoteDock, setRemoteDock] = useState(() =>
    loadJSON("agentbench.remoteDock", {}),
  );
  const [tasksOpen, setTasksOpen] = useState(
    () => localStorage.getItem("agentbench.showTasks") === "true",
  ); // background-tasks rail
  const renameInputRef = useRef(null);

  // App-level background work (sub-agents, background shells, scheduled
  // runs) for the topbar badge + tasks rail.
  const { running: runningTasks } = useTasks();

  // Linked benches: other AgentBench installs this machine holds tokens for.
  // Same storage and fleet hook as the phone shell — the sidebar below the
  // local projects is, in effect, the phone's fleet view grown up.
  const [benches, setBenches] = useState(loadGateways);
  // SSH remote hosts are owned by Rust, not localStorage: their address is a
  // tunnel port that differs every launch, so the app asks for the live one
  // rather than remembering a stale one. They join the same fleet as the
  // manually paired benches, so everything downstream is unchanged.
  const [sshBenches, setSshBenches] = useState([]);
  const allBenches = useMemo(
    () => [...benches, ...sshBenches],
    [benches, sshBenches],
  );
  const { machines } = useFleet(allBenches);
  const [remoteSel, setRemoteSel] = useState(null); // { url, cwd } — selected remote project

  // Ask Rust for the SSH hosts and their current tunnel addresses.
  const refreshSshBenches = () =>
    invoke("remote_list")
      .then((list) =>
        setSshBenches(
          (Array.isArray(list) ? list : [])
            .filter((h) => h.url && h.token)
            .map((h) => ({
              url: h.url,
              token: h.token,
              machine: h.machine,
              name: h.machine || h.host,
              kind: "ssh",
            })),
        ),
      )
      .catch(() => {});

  // On launch, bring saved SSH hosts back up. Each one is a fresh tunnel and
  // a fresh local port, so this has to happen before they can be in the
  // fleet at all. Sequential on purpose: several ssh handshakes at once on a
  // cold start is a lot of noise for no gain, and a host that is simply off
  // should not hold up the others beyond its own timeout.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await invoke("remote_list").catch(() => []);
      for (const h of Array.isArray(saved) ? saved : []) {
        if (cancelled) return;
        if (h.connected) continue;
        // A host that is asleep or off just fails here; it stays saved and
        // can be reconnected from Settings.
        await invoke("remote_connect", { host: h.host }).catch(() => {});
        if (!cancelled) await refreshSshBenches();
      }
      if (!cancelled) await refreshSshBenches();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A bench unlinked in Settings while one of its projects is on screen must
  // not leave a dead selection behind.
  useEffect(() => {
    if (remoteSel && !machines.some((m) => m.url === remoteSel.url)) {
      setRemoteSel(null);
    }
  }, [machines, remoteSel]);

  // Remote dock tabs outlive a reload, but the panes behind them do not
  // outlive the bench's broker — ids restart from scratch there. Drop tabs
  // whose pane is gone, and only for a bench we can currently see: a
  // disconnected machine reports an empty pane list, which is stale, not
  // empty, and would otherwise wipe every tab on a dropped connection.
  useEffect(() => {
    setRemoteDock((cur) => reconcileRemoteDock(cur, machines));
  }, [machines]);

  const panesRef = useRef(panes);
  panesRef.current = panes;
  const titlesRef = useRef(titles);
  titlesRef.current = titles;
  // ref mirror so rapid key presses never read a stale focus id
  const focusedRef = useRef(null);
  focusedRef.current = focusedId;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const termRefs = useRef(new Map()); // pane id -> TerminalHandle
  // plan path -> publishing agent id, so feedback finds its way back to the
  // right agent even when the plan is reopened from the rail (list_plans
  // has no owner info; pane ids are session-scoped so a ref is the right home)
  const planOwners = useRef({});

  useEffect(() => {
    localStorage.setItem("agentbench.projects", JSON.stringify(projects));
    // Mirror to disk so the mobile gateway can name projects — localStorage
    // lives in this webview and no other process can read it. The file is
    // desktop-owned: the gateway only ever reads it.
    invoke("save_projects", { projects }).catch(() => {});
  }, [projects]);

  useEffect(() => {
    if (activePath) localStorage.setItem("agentbench.active", activePath);
  }, [activePath]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  // Effective theme vars — "auto" resolves to wallpaper-sampled vars.
  const activeVars = useMemo(
    () => themeVars(settings),
    [settings.theme, settings.autoThemeVars],
  );

  // Apply the color scheme as inline custom properties on <html> so it
  // overrides the :root fallbacks in styles.css. shadcn tokens are derived
  // from the theme's own palette.
  useEffect(() => {
    const vars = activeVars;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.style.setProperty("--background", vars["--panel"]);
    root.style.setProperty("--popover", vars["--panel-head"]);
    root.style.setProperty("--popover-foreground", vars["--text"]);
    root.style.setProperty("--accent", vars["--border"]);
    root.style.setProperty("--accent-foreground", vars["--text"]);
    root.style.setProperty("--muted-foreground", vars["--text-dim"]);
    root.style.setProperty("--foreground", vars["--text"]);
    root.style.setProperty(
      "--shadcn-border",
      `rgba(${vars["--hilite"]}, 0.1)`,
    );
  }, [activeVars]);

  // Custom background image: paint it on <body>, drop UI surfaces to
  // --surface-alpha so it shows through, optionally frost them with blur.
  useEffect(() => {
    const root = document.documentElement;
    const img = settings.bgImage;
    root.style.setProperty(
      "--bg-image",
      img ? `url("${convertFileSrc(img)}")` : "none",
    );
    root.style.setProperty(
      "--surface-alpha",
      String(img ? (settings.bgOverlay ?? 0.85) : 1),
    );
    document.body.classList.toggle("bg-image", !!img);
    document.body.classList.toggle(
      "bg-frosted",
      !!img && settings.bgFrosted !== false,
    );
    root.style.setProperty(
      "--head-alpha",
      String(img ? (settings.bgHeadOpacity ?? 1) : 1),
    );
    root.style.setProperty(
      "--frost-blur",
      `${settings.bgFrostBlur ?? 24}px`,
    );
  }, [
    settings.bgImage,
    settings.bgOverlay,
    settings.bgFrosted,
    settings.bgHeadOpacity,
    settings.bgFrostBlur,
  ]);

  const termTheme = useMemo(
    () => terminalThemeFromVars(activeVars, !!settings.bgImage),
    [activeVars, settings.bgImage],
  );

  useEffect(() => {
    localStorage.setItem("agentbench.paneSizes", JSON.stringify(paneSizes));
  }, [paneSizes]);

  useEffect(() => {
    localStorage.setItem("agentbench.paneViews", JSON.stringify(paneViews));
  }, [paneViews]);

  const savedDockIds = useRef(new Set(loadJSON("agentbench.dockPanes", [])));

  // Dock persistence. Membership is a plain id list — pane ids are stable
  // for the life of a broker run (the broker outlives frontend reloads), so
  // dock tabs survive an app relaunch; after a broker restart the saved-pane
  // restore path re-docks terminal-harness panes instead.
  useEffect(() => {
    localStorage.setItem(
      "agentbench.dockPanes",
      JSON.stringify(panes.filter((p) => p.dock).map((p) => p.id)),
    );
  }, [panes]);
  useEffect(() => {
    localStorage.setItem("agentbench.dockOpen", String(dockOpen));
  }, [dockOpen]);
  useEffect(() => {
    localStorage.setItem("agentbench.dockHeight", String(dockHeight));
  }, [dockHeight]);
  useEffect(() => {
    localStorage.setItem("agentbench.dockTabs", JSON.stringify(dockTabs));
  }, [dockTabs]);
  useEffect(() => {
    localStorage.setItem("agentbench.showTasks", String(tasksOpen));
  }, [tasksOpen]);
  useEffect(() => {
    localStorage.setItem("agentbench.remoteDock", JSON.stringify(remoteDock));
  }, [remoteDock]);
  const dockOpenRef = useRef(dockOpen);
  dockOpenRef.current = dockOpen;
  const dockTabsRef = useRef(dockTabs);
  dockTabsRef.current = dockTabs;
  const remoteDockRef = useRef(remoteDock);
  remoteDockRef.current = remoteDock;
  // Read by the Ctrl+T handler, which is registered once and would otherwise
  // close over the first render's values.
  const remoteSelRef = useRef(remoteSel);
  remoteSelRef.current = remoteSel;
  const machinesRef = useRef(machines);
  machinesRef.current = machines;

  const setPaneView = (id, view) =>
    setPaneViews((v) => (v[id] === view ? v : { ...v, [id]: view }));

  // OS file drops are handled natively (dragDropEnabled: true → Tauri's
  // onDragDropEvent in AgentPane). Belt-and-braces: block any HTML5 drop
  // that slips through so the webview never navigates to a dropped file.
  useEffect(() => {
    const block = (ev) => ev.preventDefault();
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  // Keep the bundled plan-authoring skill in ~/.claude/skills up to date so
  // agents know how to publish plans (Settings toggle to opt out).
  useEffect(() => {
    if (settingsRef.current.planSkillSync !== false) {
      invoke("sync_plan_skill").catch((e) =>
        console.error("plan skill sync failed", e),
      );
    }
  }, []);

  const refreshPlans = (project) => {
    if (!project) return;
    invoke("list_plans", { project })
      .then((list) => setProjectPlans((m) => ({ ...m, [project]: list })))
      .catch(() => {});
  };

  useEffect(() => {
    localStorage.setItem("agentbench.showPlans", String(showPlans));
  }, [showPlans]);

  // keep the plans rail fresh: on project switch + light poll while visible
  useEffect(() => {
    if (!showPlans || !activePath) return;
    refreshPlans(activePath);
    const t = setInterval(() => refreshPlans(activePath), 5000);
    return () => clearInterval(t);
  }, [showPlans, activePath]);

  // open a plan from the rail as a full-window overlay over the terminals
  const openPlan = (plan) => {
    setPlanView({
      path: plan.path,
      title: plan.title || plan.slug || "Plan",
      agentId: plan.agentId ?? planOwners.current[plan.path] ?? null,
      projectPath: activePath,
    });
    setFreshPlans((s) => {
      if (!s.has(plan.path)) return s;
      const next = new Set(s);
      next.delete(plan.path);
      return next;
    });
  };

  // route plan feedback to the publishing agent when known, else the
  // focused/first agent pane in the active project
  const sendPlanFeedback = (view, text) => {
    const agents = panesRef.current.filter(
      (p) => p.projectPath === activePathRef.current,
    );
    const ownerId = view.agentId ?? planOwners.current[view.path];
    const target =
      (ownerId != null && agents.find((a) => a.id === ownerId)) ||
      agents.find((a) => a.id === focusedRef.current) ||
      agents[0];
    if (!target) return;
    pasteAndSubmit(target.id, text);
  };

  // Composer submit: serialize the scoped brief as a [plan-request] and
  // paste it into the chosen agent's terminal — spawning a fresh pane first
  // when "New agent" was picked (with a boot delay so the paste lands in
  // claude, not the launching shell).
  const submitPlanRequest = async (draft) => {
    setComposerOpen(false);
    const lines = [`[plan-request] ${draft.title.trim()}`];
    if (draft.scope.trim()) lines.push("Scope:", draft.scope.trim());
    if (draft.constraints.trim())
      lines.push("Constraints:", draft.constraints.trim());
    if (draft.outOfScope.trim())
      lines.push("Out of scope:", draft.outOfScope.trim());
    lines.push(
      "Use the agentbench-plan skill: explore the code first, publish the visual plan, then wait for my review before implementing.",
    );
    const text = lines.join("\n");

    let target = panesRef.current.find((p) => p.id === draft.agentId);
    if (!target) {
      try {
        // plan requests always spawn Claude — the agentbench-plan skill is
        // Claude-only for now
        const harness = getHarness(settingsRef.current, "claude");
        const id = await invoke("create_pane", {
          cwd: activePathRef.current,
          cols: 100,
          rows: 30,
          resume: null,
          theme: getTheme(settingsRef.current.theme).claudeTheme ?? null,
          harness,
          shell: settingsRef.current.shell?.trim() || null,
        });
        target = {
          id,
          projectPath: activePathRef.current,
          label: `${harness.name} ${id}`,
          claude: true,
        };
        setPanes((p) => [...p, target]);
        setStatuses((s) => ({ ...s, [id]: "working" }));
        await new Promise((r) => setTimeout(r, 1800));
      } catch (err) {
        console.error("failed to spawn agent for plan request", err);
        return;
      }
    }
    pasteAndSubmit(target.id, text);
    focusAgent(target);
  };

  // Engine switches remount every terminal — refresh scrollback from the
  // backend so the new engine repaints the current screen.
  const engineRef = useRef(settings.engine);
  useEffect(() => {
    if (engineRef.current === settings.engine) return;
    engineRef.current = settings.engine;
    invoke("list_panes")
      .then((live) =>
        setInitialData(Object.fromEntries(live.map((p) => [p.id, p.buffer]))),
      )
      .catch(() => {});
  }, [settings.engine]);

  // Reattach to panes that survived a frontend reload (ptys live in Rust),
  // then restore agents from the previous app run via `claude --resume`.
  useEffect(() => {
    (async () => {
      try {
        // dock membership from the previous frontend run (same broker, so
        // pane ids still match)
        const dockIds = savedDockIds.current;
        const live = await invoke("list_panes");
        if (live.length) {
          setInitialData(Object.fromEntries(live.map((p) => [p.id, p.buffer])));
          setPaneColors(
            Object.fromEntries(
              live.filter((p) => p.color).map((p) => [p.id, p.color]),
            ),
          );
          setChatLines(
            Object.fromEntries(
              live.filter((p) => p.kind === "chat").map((p) => [p.id, p.lines ?? []]),
            ),
          );
          setPanes(
            live.map((p) =>
              // run panes reattach as run panes — getHarness would fall back
              // to Claude for the unknown "run:*" id and mislabel them
              (p.harness ?? "").startsWith("run:")
                ? {
                    id: p.id,
                    projectPath: p.cwd,
                    label: p.harness.slice(4) || "run",
                    kind: "run",
                    dock: true,
                  }
                : p.kind === "chat"
                  ? {
                      id: p.id,
                      projectPath: p.cwd,
                      label: `Claude Chat ${p.id}`,
                      kind: "chat",
                      hibernated: !!p.hibernated,
                    }
                  : {
                      id: p.id,
                      projectPath: p.cwd,
                      label: p.team?.role ?? `${getHarness(settingsRef.current, p.harness ?? "claude").name} ${p.id}`,
                      hibernated: !!p.hibernated,
                      claude: !!getHarness(settingsRef.current, p.harness ?? "claude").claude,
                      harness: withSeat(getHarness(settingsRef.current, p.harness ?? "claude"), p.team),
                      team: p.team ?? undefined,
                      // reattached dock shells go back to the dock
                      dock: p.harness === "terminal" || dockIds.has(p.id) || undefined,
                    },
            ),
          );
          setStatuses(Object.fromEntries(live.map((p) => [p.id, p.hibernated ? "hibernated" : "working"])));
        }

        const saved = await invoke("saved_panes");
        const restored = [];
        for (const s of saved) {
          // never auto-restart dev servers on app relaunch (and getHarness
          // would silently resurrect them as Claude agents)
          if ((s.harness ?? "").startsWith("run:")) continue;
          try {
            if (s.harness === "claude-chat") {
              const id = await invoke("create_chat_pane", {
                cwd: s.cwd,
                resume: s.session_id ?? null,
                shell: settingsRef.current.shell?.trim() || null,
              });
              if (s.pinned) await invoke("resource_pin", { id, pinned: true });
              restored.push({
                id,
                projectPath: s.cwd,
                label: `Claude Chat ${id}`,
                kind: "chat",
              });
              continue;
            }
            // resolve against current settings; a deleted custom harness
            // falls back to Claude
            const harness = withSeat(getHarness(settingsRef.current, s.harness ?? "claude"), s.team);
            const id = await invoke("create_pane", {
              cwd: s.cwd,
              cols: 100,
              rows: 30,
              resume: s.session_id ?? null,
              theme: harness.claude
                ? getTheme(settingsRef.current.theme).claudeTheme ?? null
                : null,
              harness,
              shell: settingsRef.current.shell?.trim() || null,
            });
            if (s.pinned) await invoke("resource_pin", { id, pinned: true });
            restored.push({
              id,
              projectPath: s.cwd,
              label: s.team?.role ?? `${harness.name} ${id}`,
              claude: !!harness.claude,
              harness,
              team: s.team ?? undefined,
              // after a broker restart the old dock ids mean nothing; plain
              // shells belong in the dock, not the agent grid
              dock: harness.id === "terminal" || undefined,
            });
          } catch (err) {
            console.error("failed to restore pane in", s.cwd, err);
          }
        }
        if (restored.length) {
          setPanes((p) => [...p, ...restored]);
          setStatuses((st) => ({
            ...st,
            ...Object.fromEntries(restored.map((r) => [r.id, "working"])),
          }));
        }

        // Pane ids restart per broker run; stale per-pane view choices from
        // a previous run would shadow Settings' default view on recycled ids.
        const liveIds = new Set([...live.map((p) => p.id), ...restored.map((r) => r.id)]);
        setPaneViews((v) => {
          const next = Object.fromEntries(
            Object.entries(v).filter(([k]) => liveIds.has(Number(k))),
          );
          return Object.keys(next).length === Object.keys(v).length ? v : next;
        });

        const allCwds = [...live.map((p) => p.cwd), ...restored.map((r) => r.projectPath)];
        if (allCwds.length) {
          setProjects((ps) => {
            const known = new Set(ps.map((x) => x.path));
            const add = [...new Set(allCwds)]
              .filter((c) => !known.has(c))
              .map((c) => ({ path: c, name: baseName(c) }));
            return add.length ? [...ps, ...add] : ps;
          });
        }
      } catch (err) {
        console.error("restore failed", err);
      }
    })();
  }, []);

  useEffect(() => {
    isPermissionGranted().then((ok) => {
      if (!ok) requestPermission().catch(() => {});
    });

    const unEvent = listen("agent-event", (e) => {
      const { id, kind, cwd, sid } = e.payload;
      const status = kind === "done" ? "done" : "input";
      setStatuses((s) => (id in s ? { ...s, [id]: status } : s));
      const pane = panesRef.current.find((p) => p.id === id);
      const label = titlesRef.current[id] || pane?.label || `Agent ${id}`;
      setNotifs((list) =>
        [
          {
            key: `${id}-${Date.now()}`,
            paneId: id,
            kind,
            label,
            project: pane ? baseName(pane.projectPath) : "",
            projectPath: pane?.projectPath,
            ts: Date.now(),
            read: false,
          },
          ...list,
        ].slice(0, 30),
      );
      // Inbox entry: one per pane, newest turn replaces the old one.
      const entry = {
        key: `${id}-${Date.now()}`,
        paneId: id,
        kind,
        label,
        project: pane ? baseName(pane.projectPath) : "",
        projectPath: pane?.projectPath,
        ts: Date.now(),
        read: false,
        snippet: null,
        sid: sid ?? null,
      };
      setInbox((list) => [entry, ...list.filter((n) => n.paneId !== id)].slice(0, 50));
      // "What did it say" — the agent's closing words, read from the
      // transcript once it has flushed. Brokers that predate the cwd/sid
      // fields just keep the generic snippet.
      if (kind === "done" && cwd && sid) {
        setTimeout(() => {
          invoke("session_tail", { project: cwd, sid })
            .then((text) => {
              if (!text) return;
              setInbox((list) =>
                list.map((n) =>
                  n.paneId === id && n.sid === sid ? { ...n, snippet: text } : n,
                ),
              );
            })
            .catch(() => {});
        }, 400);
      }
      const cfg = settingsRef.current;
      if (cfg.sound) {
        ping.volume = cfg.volume ?? 0.8;
        ping.currentTime = 0;
        ping.play().catch(() => {});
      }
      if (cfg.osNotify && !document.hasFocus()) {
        sendNotification({
          title: pane ? `${label} · ${baseName(pane.projectPath)}` : label,
          body: kind === "done" ? "Finished its turn." : "Waiting for your input.",
        });
      }
    });

    // Agent published (or updated) a plan: open the full-window plan view
    // when it belongs to the active project, else badge it in the rail.
    const unPlan = listen("plan-ready", (e) => {
      const { id: agentId, path, title } = e.payload;
      if (agentId != null) planOwners.current[path] = agentId;
      setPlanNonces((n) => ({ ...n, [path]: (n[path] ?? 0) + 1 }));
      refreshPlans(activePathRef.current);
      const agent = panesRef.current.find((p) => p.id === agentId);
      if (!agent || agent.projectPath === activePathRef.current) {
        setShowPlans(true); // surface the plans rail so the new tab is visible
        setPlanView({
          path,
          title: title || "Plan",
          agentId,
          projectPath: agent?.projectPath ?? activePathRef.current,
        });
        setFreshPlans((s) => {
          if (!s.has(path)) return s;
          const next = new Set(s);
          next.delete(path);
          return next;
        });
      } else {
        setFreshPlans((s) => new Set(s).add(path));
      }
      // Always ding for a finished plan, even if turn-end pings are muted.
      const cfg = settingsRef.current;
      ping.volume = cfg.volume ?? 0.8;
      ping.currentTime = 0;
      ping.play().catch(() => {});
    });

    const unExit = listen("pane-exit", (e) => {
      // a dock shell whose process exits just closes its tab — no exited
      // corpse to clean up, matching how terminal apps behave
      if (panesRef.current.some((p) => p.id === e.payload.id && p.dock && p.kind !== "run")) {
        setPanes((ps) => ps.filter((p) => p.id !== e.payload.id));
        setStatuses(({ [e.payload.id]: _gone, ...rest }) => rest);
        return;
      }
      setStatuses((s) =>
        e.payload.id in s && s[e.payload.id] !== "hibernated" ? { ...s, [e.payload.id]: "exited" } : s,
      );
      // a run pane that dies while hidden surfaces its crash logs instead of
      // staying invisible behind a green dot
      setPanes((ps) =>
        ps.some((p) => p.id === e.payload.id && p.hidden)
          ? ps.map((p) =>
              p.id === e.payload.id ? { ...p, hidden: false } : p,
            )
          : ps,
      );
    });

    // A scheduled run's pane is spawned broker-side — no create call went
    // through this app, so adopt it into the grid (and its project into the
    // sidebar) the moment the broker announces it.
    const unSchedRun = listen("schedule-run", (e) => {
      const { paneId, cwd, name } = e.payload;
      setPanes((ps) =>
        ps.some((p) => p.id === paneId)
          ? ps
          : [...ps, { id: paneId, projectPath: cwd, label: `${name} · run`, kind: "chat" }],
      );
      setStatuses((s) => ({ ...s, [paneId]: "working" }));
      setProjects((ps) =>
        ps.some((x) => x.path === cwd) ? ps : [...ps, { path: cwd, name: baseName(cwd) }],
      );
    });

    const unColor = listen("pane-color", (e) => {
      const { id, color } = e.payload;
      setPaneColors((c) => (c[id] === color ? c : { ...c, [id]: color }));
    });

    // The settings window persists to localStorage and broadcasts the full
    // settings object; adopt it so the grid re-themes live.
    const unSettings = listen("settings-changed", (e) => {
      if (e.payload.cols && e.payload.cols !== settingsRef.current.cols) {
        setPaneSizes((sizes) => resetPaneWidths(sizes));
      }
      setSettings(e.payload);
    });

    // Linked benches are edited in the settings window (shared localStorage);
    // reload our copy so sockets open/close without an app restart.
    const unBenches = listen("benches-changed", () => {
      setBenches(loadGateways());
      refreshSshBenches();
    });

    // Feed the background-tasks registry: full scheduler state now, then on
    // every broker push (the broker broadcasts, UIs never poll).
    invoke("schedules")
      .then((s) => feedTaskSchedules(s))
      .catch(() => {});
    const unSchedState = listen("schedules", (e) => feedTaskSchedules(e.payload));

    return () => {
      unSchedState.then((f) => f());
      unEvent.then((f) => f());
      unPlan.then((f) => f());
      unExit.then((f) => f());
      unSchedRun.then((f) => f());
      unColor.then((f) => f());
      unSettings.then((f) => f());
      unBenches.then((f) => f());
    };
  }, []);

  // A bench that linked *to us* leaves its reverse credentials with our
  // gateway (gateway-links.json). Merge them in at launch so the machine
  // appears without anyone opening Settings here.
  useEffect(() => {
    invoke("gateway_links")
      .then((links) => {
        if (!Array.isArray(links) || !links.length) return;
        setBenches((cur) => {
          let next = cur;
          for (const l of links) {
            if (!l?.url || !l?.token) continue;
            const known = cur.find((b) => b.url === l.url);
            if (known?.token === l.token) continue;
            next = [
              ...next.filter((b) => b.url !== l.url),
              { url: l.url, token: l.token, machine: l.machine, name: l.machine, kind: "bench" },
            ];
          }
          if (next !== cur) saveGateways(next);
          return next;
        });
      })
      .catch(() => {});
  }, []);

  // Settings live in their own window, pre-spawned hidden at startup so
  // opening is instant and never flashes white; closing it only hides it.
  const spawnSettingsWindow = () =>
    new WebviewWindow("settings", {
      url: "index.html?window=settings",
      title: "Settings",
      width: 1560,
      height: 910,
      minWidth: 640,
      minHeight: 440,
      dragDropEnabled: false,
      visible: false,
      backgroundColor: "#08080b", // matches index.html; kills the white flash
      // match the main window's chrome: overlay traffic lights on mac,
      // custom caption buttons on windows
      ...(IS_MAC && {
        titleBarStyle: "Overlay",
        hiddenTitle: true,
        trafficLightPosition: { x: 14, y: 20 },
      }),
      ...(IS_WINDOWS && { decorations: false }),
    });

  useEffect(() => {
    WebviewWindow.getByLabel("settings").then((w) => {
      if (!w) spawnSettingsWindow();
    });
    // the hidden settings window would keep the app alive after the main
    // window closes — take it down with us
    const unClose = getCurrentWindow().onCloseRequested(() => {
      WebviewWindow.getByLabel("settings")
        .then((w) => w?.destroy())
        .catch(() => {});
    });
    return () => {
      unClose.then((f) => f());
    };
  }, []);

  const openSettings = async () => {
    const w = (await WebviewWindow.getByLabel("settings")) ?? spawnSettingsWindow();
    w.show().catch(() => {});
    w.setFocus().catch(() => {});
  };

  const addProject = async () => {
    const dir = await open({ directory: true, title: "Add a project folder" });
    if (!dir) return;
    setProjects((ps) =>
      ps.some((p) => p.path === dir) ? ps : [...ps, { path: dir, name: baseName(dir) }],
    );
    setActivePath(dir);
    setRemoteSel(null);
  };

  const removeProject = (path) => {
    for (const pane of panesRef.current.filter((p) => p.projectPath === path)) {
      invoke("kill_pane", { id: pane.id }).catch(() => {});
    }
    setPanes((p) => p.filter((pane) => pane.projectPath !== path));
    setProjects((ps) => {
      const next = ps.filter((p) => p.path !== path);
      if (path === activePath) setActivePath(next[0]?.path);
      return next;
    });
  };

  const updateProject = (path, patch) =>
    setProjects((ps) => ps.map((p) => (p.path === path ? { ...p, ...patch } : p)));

  // Hiding only tucks a project into the sidebar's "Hidden" group — its panes
  // keep running. Hiding the active one hops to the next visible project.
  const setProjectHidden = (path, hidden) => {
    setProjects((ps) => {
      const next = ps.map((p) => (p.path === path ? { ...p, hidden: hidden || undefined } : p));
      if (hidden && path === activePath) {
        const fallback = next.find((p) => !p.hidden);
        if (fallback) setActivePath(fallback.path);
      }
      return next;
    });
    if (!hidden) {
      setActivePath(path);
      setRemoteSel(null);
    }
  };

  // Move `from` so it lands just before/after `to` in the stored order.
  const moveProject = (from, to, after) => {
    if (from === to) return;
    setProjects((ps) => {
      const item = ps.find((p) => p.path === from);
      if (!item) return ps;
      const rest = ps.filter((p) => p.path !== from);
      const idx = rest.findIndex((p) => p.path === to);
      if (idx < 0) return ps;
      rest.splice(after ? idx + 1 : idx, 0, item);
      return rest;
    });
  };

  // Pointer-driven sidebar reorder (HTML5 DnD is unreliable in the webview
  // with native file drops enabled — same reasoning as usePaneDrag).
  const [projDrag, setProjDrag] = useState(null); // {path, over, after}
  const projDragClickGuard = useRef(false);
  const onProjectPointerDown = (ev, path) => {
    if (ev.button !== 0 || renaming === path) return;
    const y0 = ev.clientY;
    const x0 = ev.clientX;
    let started = false;
    let drop = null;
    const onMove = (e) => {
      if (!started) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 5) return;
        started = true;
        document.body.style.cursor = "grabbing";
      }
      const row = document
        .elementsFromPoint(e.clientX, e.clientY)
        .map((n) => n.closest?.("[data-project-path]"))
        .find(Boolean);
      if (row) {
        const r = row.getBoundingClientRect();
        drop = {
          over: row.dataset.projectPath,
          after: e.clientY > r.top + r.height / 2,
        };
      }
      setProjDrag({ path, ...(drop ?? {}) });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!started) return;
      document.body.style.cursor = "";
      setProjDrag(null);
      // swallow the click that follows the drag's pointerup
      projDragClickGuard.current = true;
      setTimeout(() => (projDragClickGuard.current = false), 0);
      if (drop && drop.over !== path) moveProject(path, drop.over, drop.after);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const [showHiddenProjects, setShowHiddenProjects] = useState(
    () => localStorage.getItem("agentbench.showHiddenProjects") === "1",
  );
  useEffect(() => {
    localStorage.setItem("agentbench.showHiddenProjects", showHiddenProjects ? "1" : "0");
  }, [showHiddenProjects]);

  // Run a project command (Settings-free: commands live on the project entry).
  // A run pane is just a pane with an ad-hoc harness spec — the broker already
  // launches arbitrary command lines through the login shell, so logs, exit
  // tracking and kill-on-close all reuse the agent pipeline.
  const runCommand = async (project, cmd, { restart = false } = {}) => {
    if (!cmd?.command?.trim()) return;
    const existing = panesRef.current.find(
      (p) =>
        p.kind === "run" && p.projectPath === project.path && p.label === cmd.name,
    );
    if (existing && statuses[existing.id] !== "exited") {
      if (!restart) {
        // Already running: reveal its terminal tab.
        setDockOpen(true);
        setDockTabs((tabs) => ({ ...tabs, [project.path]: existing.id }));
        if (existing.hidden) {
          setPanes((ps) =>
            ps.map((x) => (x.id === existing.id ? { ...x, hidden: false } : x)),
          );
        }
        setTimeout(() => focusAgent(existing), existing.hidden ? 50 : 0);
        return;
      }
      // restart of a live pane: kill first so the relaunch doesn't fight the
      // old process for ports/locks (kill_pane tears the pty down with it)
      await invoke("kill_pane", { id: existing.id }).catch(() => {});
    }
    try {
      const id = await invoke("create_pane", {
        cwd: project.path,
        cols: 100,
        rows: 30,
        resume: null,
        theme: null,
        // "run:" prefix marks the pane across broker reattach/persist; the
        // restore path skips these so dev servers never auto-resurrect.
        // interactive: run through -i shell so .zshrc aliases (pa, etc) work
        harness: { id: `run:${cmd.name}`, command: cmd.command, interactive: true },
        shell: settingsRef.current.shell?.trim() || null,
      });
      const pane = {
        id,
        projectPath: project.path,
        label: cmd.name,
        kind: "run",
        dock: true,
        command: cmd.command,
      };
      setPanes((ps) =>
        // restarting an exited run pane replaces it in place (keeps grid slot)
        existing ? ps.map((x) => (x.id === existing.id ? pane : x)) : [...ps, pane],
      );
      setStatuses((s) => {
        const next = { ...s, [id]: "working" };
        if (existing) delete next[existing.id];
        return next;
      });
      setDockOpen(true);
      setDockTabs((tabs) => ({ ...tabs, [project.path]: id }));
      setTimeout(() => focusAgent(pane), 30);
    } catch (err) {
      console.error("failed to run command", err);
    }
  };

  // Hide keeps the process running; the Run caret (green dot) brings it back.
  const hideRun = (id) =>
    setPanes((ps) => ps.map((p) => (p.id === id ? { ...p, hidden: true } : p)));

  const restartRun = (pane) => {
    const project = projects.find((pr) => pr.path === pane.projectPath);
    // reattached panes lose the command line; recover it from the project entry
    const command =
      pane.command ??
      project?.commands?.find((c) => c.name === pane.label)?.command;
    if (!command) {
      setRunDialog(pane.projectPath);
      return;
    }
    runCommand(
      { path: pane.projectPath },
      { name: pane.label, command },
      { restart: true },
    );
  };

  const [resources, setResources] = useState(null);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [resourceError, setResourceError] = useState(null);
  const [resourceBusy, setResourceBusy] = useState({});
  const resourceBusyRef = useRef(new Set());
  const [pageVisible, setPageVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const change = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  const applyHibernated = (id) => {
    setPanes((ps) => ps.map((p) => p.id === id ? { ...p, hibernated: true } : p));
    setStatuses((s) => ({ ...s, [id]: "hibernated" }));
  };
  const applyResumed = async ({ old_id, id }) => {
    // Install replay data before mounting the replacement terminal/chat.
    try {
      const ps = await invoke("list_panes");
      const p = ps.find((p) => p.id === id);
      if (p) {
        setInitialData((d) => ({ ...d, [id]: p.buffer }));
        setChatLines((d) => ({ ...d, [id]: p.lines ?? [] }));
      }
    } catch { /* live output still attaches if replay is unavailable */ }
    setPanes((ps) => ps.map((p) => p.id === old_id ? { ...p, id, hibernated: false } : p));
    const move = (state) => {
      if (!(old_id in state)) return state;
      const { [old_id]: value, ...rest } = state;
      return { ...rest, [id]: value };
    };
    setPaneSizes(move); setPaneViews(move); setTitles(move);
    setStatuses((s) => { const { [old_id]: _, ...rest } = s; return { ...rest, [id]: "working" }; });
    setFocusedId((focused) => focused === old_id ? id : focused);
  };
  useEffect(() => {
    let alive = true;
    const subscriptions = [
      listen("resources", (e) => { if (alive) { setResources(e.payload.state); setTaskResources(e.payload.state); } }),
      listen("pane-hibernated", (e) => { if (alive) applyHibernated(e.payload.id); }),
      listen("pane-resumed", (e) => { if (alive) applyResumed(e.payload); }),
      listen("resource-error", (e) => { if (alive) setResourceError(e.payload.message); }),
      listen("open-resources", () => { if (alive) setResourcesOpen(true); }),
    ];
    Promise.all(subscriptions).then(() => invoke("resource_state"))
      .then((s) => { if (alive) { setResources(s); setTaskResources(s); } })
      .catch(() => { if (alive) setResourceError("Resource management needs the updated broker. Rebuild and restart the broker to enable it."); });
    return () => { alive = false; subscriptions.forEach((s) => s.then((off) => off())); };
  }, []);
  const resourceAction = async (action, id, pinned) => {
    if (resourceBusyRef.current.has(id)) return;
    resourceBusyRef.current.add(id);
    setResourceBusy((s) => ({ ...s, [id]: action === "resume" ? "Resuming…" : action === "hibernate" ? "Hibernating…" : "Saving…" }));
    setResourceError(null);
    try {
      if (action === "pin") {
        await invoke("resource_pin", { id, pinned });
        setResources((s) => s && ({ ...s, panes: s.panes.map((p) => p.id === id ? { ...p, pinned } : p) }));
      } else {
        const result = await invoke(action === "resume" ? "resume_hibernated" : "hibernate_pane", { id });
        // Events synchronize other windows; the response also covers a lost event.
        if (action === "resume") await applyResumed(result); else applyHibernated(id);
      }
    } catch (err) { setResourceError(String(err)); setResourcesOpen(true); }
    finally {
      resourceBusyRef.current.delete(id);
      setResourceBusy(({ [id]: _, ...rest }) => rest);
    }
  };
  const saveResourcePolicy = async (policy) => {
    await invoke("resource_policy", { policy });
    setResources((s) => ({ ...s, policy }));
  };

  const restartingAgents = useRef(new Set());
  const restartAgent = async (pane) => {
    if (restartingAgents.current.has(pane.id)) return;
    restartingAgents.current.add(pane.id);
    try {
      const harness = pane.harness ?? getHarness(settingsRef.current, "claude");
      await invoke("kill_pane", { id: pane.id });
      const shell = settingsRef.current.shell?.trim() || null;
      const id = pane.kind === "chat"
        ? await invoke("create_chat_pane", { cwd: pane.projectPath, resume: null, shell })
        : await invoke("create_pane", {
            cwd: pane.projectPath, cols: 100, rows: 30, resume: null, shell, harness,
            theme: harness.claude ? getTheme(settingsRef.current.theme).claudeTheme ?? null : null,
          });
      setPanes((ps) => ps.map((p) => p.id === pane.id
        ? { ...p, id, label: pane.team?.role ?? `${pane.kind === "chat" ? "Claude Chat" : harness.name} ${id}` } : p));
      const move = (state) => {
        const { [pane.id]: value, ...rest } = state;
        return value === undefined ? rest : { ...rest, [id]: value };
      };
      setPaneSizes(move);
      setPaneViews(move);
      setStatuses((s) => ({ ...s, [id]: "working" }));
      setFocusedId(id);
    } catch (err) {
      console.error("agent restart failed", err);
      window.alert(`Could not restart agent: ${err}`);
    } finally {
      restartingAgents.current.delete(pane.id);
    }
  };

  // Which harness binaries exist on PATH (Set of bin names); null = unprobed.
  // Probed at startup and when the harness dropdown opens, so freshly
  // installed agents lose their badge without an app restart.
  const [harnessAvail, setHarnessAvail] = useState(null);
  const harnessMissing = (h) =>
    harnessAvail != null &&
    PROBEABLE.test(harnessBin(h)) &&
    !harnessAvail.has(harnessBin(h));
  const refreshHarnessAvail = () => {
    const bins = [
      ...new Set(
        getHarnesses(settingsRef.current)
          .map(harnessBin)
          .filter((b) => PROBEABLE.test(b)),
      ),
    ];
    if (!bins.length) return;
    invoke("check_binaries", { bins })
      .then((found) => setHarnessAvail(new Set(found)))
      .catch(() => {});
  };
  useEffect(refreshHarnessAvail, []);

  // Spawn an agent; with a direction, insert it so it lands beside/above/
  // below the focused pane in the grid (Ghostty-style directional splits).
  // Row math mirrors the arrow-key nav: index ± grid columns.
  const spawnAgent = async (dir, harnessId, resume = null) => {
    if (!activePath) return;
    const harness = getHarness(
      settingsRef.current,
      // resuming only makes sense for Claude sessions; force the Claude
      // harness so a non-Claude default doesn't get a --resume it can't use
      resume ? "claude" : harnessId ?? settingsRef.current.defaultHarness,
    );
    if (harness.id === "terminal") return spawnDockTerm();
    // missing binary would exec into "command not found" and the pane dies —
    // route to Settings → Agents instead
    if (harnessMissing(harness)) {
      openSettings();
      return;
    }
    const id = await invoke("create_pane", {
      cwd: activePath,
      cols: 100,
      rows: 30,
      resume,
      // theme only means something to Claude's settings file
      theme: harness.claude
        ? getTheme(settingsRef.current.theme).claudeTheme ?? null
        : null,
      harness,
      shell: settingsRef.current.shell?.trim() || null,
    });
    const pane = {
      id,
      projectPath: activePath,
      label: `${harness.name} ${id}`,
      claude: !!harness.claude,
      harness,
    };
    setPanes((p) => {
      const inProject = p.filter(
        (x) => x.projectPath === activePath && !x.dock,
      );
      const pos = inProject.findIndex((x) => x.id === focusedRef.current);
      if (!dir || pos === -1) return [...p, pane];
      const cols = effColsRef.current;
      // Inserting at/before `pos` shifts the anchor to pos+1, hence the
      // +1 in `up` so the new pane sits directly above where it ends up.
      const want = {
        left: pos,
        right: pos + 1,
        up: pos + 1 - cols,
        down: pos + cols,
      }[dir];
      const insertPos = Math.max(0, Math.min(inProject.length, want));
      const globalIdx =
        insertPos >= inProject.length
          ? p.indexOf(inProject[inProject.length - 1]) + 1
          : p.indexOf(inProject[insertPos]);
      const next = [...p];
      next.splice(globalIdx, 0, pane);
      return next;
    });
    setStatuses((s) => ({ ...s, [id]: "working" }));
    if (dir) focusAgent(pane);
  };
  const addAgent = () => spawnAgent();

  const loadTeams = (path) =>
    invoke("list_teams", { project: path })
      .then((raw) => setProjectTeams((t) => ({ ...t, [path]: normalizeTeams(raw) })))
      .catch(() => setProjectTeams((t) => ({ ...t, [path]: [] })));
  useEffect(() => {
    if (activePath) loadTeams(activePath);
  }, [activePath]);

  // Start every role of a saved team that isn't already running in the
  // project. Each agent is its own pane; the seat gives it its name, model
  // and team prompt at launch.
  const launchingTeams = useRef(new Set());
  const launchTeam = async (projectPath, team) => {
    const key = `${projectPath}\0${team.id}`;
    if (launchingTeams.current.has(key)) return;
    launchingTeams.current.add(key);
    const inProject = panesRef.current.filter((p) => p.projectPath === projectPath);
    const todo = missingSeats(team, inProject);
    const nameOf = (id) => getHarness(settingsRef.current, id).name;
    const started = [];
    const failed = [];
    try {
      for (const agent of todo) {
        const base = getHarness(settingsRef.current, agent.harness);
        if (base.id !== agent.harness) {
          failed.push(`${agent.role}: agent type "${agent.harness}" isn't set up`);
          continue;
        }
        if (harnessMissing(base)) {
          failed.push(`${agent.role}: ${base.name} isn't installed`);
          continue;
        }
        const seat = seatFor(team, agent, nameOf);
        const harness = withSeat(base, seat);
        try {
          const id = await invoke("create_pane", {
            cwd: projectPath,
            cols: 100,
            rows: 30,
            resume: null,
            theme: harness.claude ? getTheme(settingsRef.current.theme).claudeTheme ?? null : null,
            harness,
            shell: settingsRef.current.shell?.trim() || null,
          });
          started.push({ id, projectPath, label: agent.role, claude: !!harness.claude, harness, team: seat });
        } catch (err) {
          failed.push(`${agent.role}: ${err}`);
        }
      }
    } finally {
      launchingTeams.current.delete(key);
    }
    if (started.length) {
      // keep teammates next to each other: after the team's running panes,
      // else at the end
      setPanes((ps) => {
        let at = -1;
        ps.forEach((p, i) => { if (p.projectPath === projectPath && p.team?.team_id === team.id) at = i; });
        if (at === -1) return [...ps, ...started];
        return [...ps.slice(0, at + 1), ...started, ...ps.slice(at + 1)];
      });
      setStatuses((st) => ({ ...st, ...Object.fromEntries(started.map((p) => [p.id, "working"])) }));
      setActivePath(projectPath);
    }
    if (failed.length) window.alert(`Some agents in "${team.name}" didn't start:\n\n${failed.join("\n")}`);
    else if (!todo.length) {
      const first = inProject.find((p) => p.team?.team_id === team.id);
      if (first) { setActivePath(projectPath); focusAgent(first); }
    }
  };

  // "focus" teams share one grid cell: the selected member shows, the rest
  // ride along as header tabs. Remember the selection per team, and follow
  // focus so a notification/hotkey jump to a tucked member brings it up.
  const [teamFocus, setTeamFocus] = useState({}); // `${projectPath}\0${teamId}` -> pane id
  useEffect(() => {
    const p = panesRef.current.find((x) => x.id === focusedId);
    if (!p?.team) return;
    const key = `${p.projectPath}\0${p.team.team_id}`;
    setTeamFocus((m) => (m[key] === p.id ? m : { ...m, [key]: p.id }));
  }, [focusedId]);

  const stopTeam = (projectPath, teamId) => {
    for (const p of panesRef.current) {
      if (p.projectPath === projectPath && p.team?.team_id === teamId) onClose(p.id);
    }
  };

  // Headless Claude pane: stream-json over pipes, rendered as chat — no
  // terminal at all. Suits fire-and-forget workers; interactive affordances
  // (plan mode UI, dialogs) need a regular Claude pane.
  const spawnChatAgent = async () => {
    if (!activePath) return;
    try {
      const id = await invoke("create_chat_pane", {
        cwd: activePath,
        resume: null,
        shell: settingsRef.current.shell?.trim() || null,
      });
      const pane = {
        id,
        projectPath: activePath,
        label: `Claude Chat ${id}`,
        kind: "chat",
      };
      setPanes((p) => [...p, pane]);
      setStatuses((s) => ({ ...s, [id]: "working" }));
      focusAgent(pane);
    } catch (err) {
      console.error("failed to spawn chat agent", err);
    }
  };

  // New agent in a project on a linked bench — the same wire call the phone
  // makes, so the remote broker gets an identical harness spec. No local
  // state to update: the pane arrives through the machine's pane-list push.
  const spawnRemoteAgent = (m, cwd, harnessId) => {
    const harness = getHarness(
      settingsRef.current,
      harnessId ?? settingsRef.current.defaultHarness,
    );
    return m.transport
      ?.invoke("create_pane", {
        cwd,
        cols: 100,
        rows: 30,
        resume: null,
        // theme only means something to Claude's settings file
        theme: harness.claude
          ? getTheme(settingsRef.current.theme).claudeTheme ?? null
          : null,
        harness: {
          id: harness.id,
          command: harness.command,
          resume: harness.resume ?? null,
          claude: !!harness.claude,
          interactive: !!harness.interactive,
        },
      })
      .catch((err) => console.error("remote spawn failed", err));
  };

  // Focusing a terminal acknowledges its pending notifications.
  const markNotifsRead = (id) => {
    setNotifs((list) =>
      list.some((n) => n.paneId === id && !n.read)
        ? list.map((n) => (n.paneId === id && !n.read ? { ...n, read: true } : n))
        : list,
    );
    setInbox((list) =>
      list.some((n) => n.paneId === id && !n.read)
        ? list.map((n) => (n.paneId === id && !n.read ? { ...n, read: true } : n))
        : list,
    );
  };

  useEffect(() => {
    localStorage.setItem("agentbench.inbox", JSON.stringify(inbox));
  }, [inbox]);

  const dismissInbox = (key) => setInbox((list) => list.filter((n) => n.key !== key));

  const openInboxItem = (n) => {
    setInbox((list) =>
      list.map((x) => (x.key === n.key ? { ...x, read: true } : x)),
    );
    const pane = panesRef.current.find((p) => p.id === n.paneId);
    if (!pane) return; // agent closed since — the entry stays until cleared
    setRemoteSel(null);
    if (pane.projectPath !== activePathRef.current) {
      setActivePath(pane.projectPath);
      setTimeout(() => focusAgent(pane), 50);
    } else {
      focusAgent(pane);
    }
  };

  // User touched the pane: acknowledge the done/input glow.
  const onActivity = (id) => {
    focusedRef.current = id;
    setFocusedId(id);
    markNotifsRead(id);
    setStatuses((s) =>
      s[id] === "done" || s[id] === "input" ? { ...s, [id]: "working" } : s,
    );
  };

  const registerTerm = (id, handle) => {
    if (handle) termRefs.current.set(id, handle);
    else termRefs.current.delete(id);
  };

  const onTitle = (id, title) => {
    setTitles((t) => (t[id] === title ? t : { ...t, [id]: title }));
  };

  const onClose = (id) => {
    // plan panes are just documents — nothing to kill
    if (typeof id === "number") invoke("kill_pane", { id }).catch(() => {});
    setPanes((p) => p.filter((pane) => pane.id !== id));
    setStatuses(({ [id]: _gone, ...rest }) => rest);
    setPaneSizes(({ [id]: _gone, ...rest }) => rest);
    setPaneViews(({ [id]: _gone, ...rest }) => rest);
    setChatLines(({ [id]: _gone, ...rest }) => rest);
  };

  // Drag-drop reorder: move dragged pane to the drop target's slot.
  const reorderPane = (dragId, targetId) => {
    if (dragId === targetId) return;
    setPanes((p) => {
      const from = p.findIndex((x) => x.id === dragId);
      const to = p.findIndex((x) => x.id === targetId);
      if (from === -1 || to === -1) return p;
      const next = [...p];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const resizePane = (id, size) => {
    setPaneSizes((s) => {
      const cur = s[id];
      if (cur?.w === size.w && cur?.h === size.h) return s;
      return { ...s, [id]: size };
    });
  };

  // Aggregate a project's pane statuses for its sidebar dot. input > done > working.
  // Dock shells are excluded — an idle shell reports "working" forever and
  // would pin every project dot green.
  const projectStatus = (path) => {
    const ss = panesRef.current
      .filter((p) => p.projectPath === path && !p.dock)
      .map((p) => statuses[p.id]);
    if (ss.includes("input")) return "input";
    if (ss.includes("done")) return "done";
    if (ss.includes("working")) return "working";
    return ss.length ? "exited" : "idle";
  };

  const focusAgent = (pane) => {
    if (!pane) return;
    focusedRef.current = pane.id;
    setFocusedId(pane.id);
    markNotifsRead(pane.id);
    const reveal = () => {
      const handle = termRefs.current.get(pane.id);
      handle?.focus();
      handle?.scrollIntoView?.();
    };
    if (pane.team) {
      // a tucked focus-team member must be swapped in before it can take focus
      const key = `${pane.projectPath}\0${pane.team.team_id}`;
      setTeamFocus((m) => (m[key] === pane.id ? m : { ...m, [key]: pane.id }));
      requestAnimationFrame(reveal);
    } else reveal();
  };

  // Open a scheduled run: focus its pane while it still exists, otherwise
  // resume the recorded session into a fresh headless pane — either way the
  // run lands in the grid as a normal chat you can read and reply to.
  const openScheduleRun = async (run, schedule) => {
    setSchedulesOpen(false);
    const live = panesRef.current.find((p) => p.id === run.paneId);
    if (live) {
      setRemoteSel(null);
      if (live.projectPath !== activePathRef.current) {
        setActivePath(live.projectPath);
        setTimeout(() => focusAgent(live), 50);
      } else {
        focusAgent(live);
      }
      return;
    }
    const cwd = schedule?.cwd;
    if (!run.sessionId || !cwd) return;
    try {
      const id = await invoke("create_chat_pane", {
        cwd,
        resume: run.sessionId,
        shell: settingsRef.current.shell?.trim() || null,
      });
      const pane = { id, projectPath: cwd, label: `${schedule.name} · run`, kind: "chat" };
      setPanes((p) => [...p, pane]);
      setStatuses((s) => ({ ...s, [id]: "working" }));
      setRemoteSel(null);
      if (cwd !== activePathRef.current) setActivePath(cwd);
      setTimeout(() => focusAgent(pane), 50);
    } catch (err) {
      console.error("failed to open scheduled run", err);
    }
  };

  // ── terminal dock ─────────────────────────────────────────────────────
  const spawnDockTerm = async () => {
    const path = activePathRef.current;
    if (!path) return;
    try {
      const harness = getHarness(settingsRef.current, "terminal");
      const id = await invoke("create_pane", {
        cwd: path,
        cols: 100,
        rows: 30,
        resume: null,
        theme: null,
        harness,
        shell: settingsRef.current.shell?.trim() || null,
      });
      const n =
        panesRef.current.filter((p) => p.dock && p.projectPath === path).length + 1;
      const pane = { id, projectPath: path, label: `Terminal ${n}`, dock: true };
      setPanes((p) => [...p, pane]);
      setStatuses((s) => ({ ...s, [id]: "working" }));
      setDockTabs((t) => ({ ...t, [path]: id }));
      setDockOpen(true);
      setTimeout(() => focusAgent(pane), 60);
    } catch (err) {
      console.error("failed to open dock terminal", err);
    }
  };

  const closeDockTerm = (id) => {
    const path = panesRef.current.find((p) => p.id === id)?.projectPath;
    const next = panesRef.current.filter(
      (p) => p.dock && p.projectPath === path && p.id !== id,
    );
    onClose(id);
    if (path) {
      setDockTabs((t) => ({ ...t, [path]: next[next.length - 1]?.id }));
      if (next.length) setTimeout(() => focusAgent(next[next.length - 1]), 30);
    }
  };

  const selectDockTab = (path, id) => {
    setDockTabs((t) => (t[path] === id ? t : { ...t, [path]: id }));
    const pane = panesRef.current.find((p) => p.id === id);
    if (pane) setTimeout(() => focusAgent(pane), 30);
  };

  const spawnRemoteDockTerm = async (m, cwd) => {
    if (!m?.transport || !cwd) return;
    const harness = getHarness(settingsRef.current, "terminal");
    try {
      const id = await m.transport.invoke("create_pane", {
        cwd,
        cols: 100,
        rows: 30,
        resume: null,
        theme: null,
        harness: {
          id: harness.id,
          command: harness.command,
          resume: harness.resume ?? null,
          claude: !!harness.claude,
          interactive: !!harness.interactive,
        },
      });
      const n =
        (remoteDockRef.current[m.url] ?? []).filter((p) => p.projectPath === cwd)
          .length + 1;
      setRemoteDock((d) => ({
        ...d,
        [m.url]: [
          ...(d[m.url] ?? []),
          { id, projectPath: cwd, label: `Terminal ${n}` },
        ],
      }));
      setDockTabs((t) => ({ ...t, [remoteScope(m.url, cwd)]: id }));
      setDockOpen(true);
    } catch (err) {
      console.error("remote dock terminal failed", err);
    }
  };

  const closeRemoteDockTerm = (m, id) => {
    m?.transport?.invoke("kill_pane", { id }).catch(() => {});
    setRemoteDock((d) => ({
      ...d,
      [m.url]: (d[m.url] ?? []).filter((p) => p.id !== id),
    }));
  };

  // Ctrl+T / Ctrl+` / topbar button. Opening with no shells yet spawns the first one.
  const toggleDock = () => {
    if (dockOpenRef.current) {
      setDockOpen(false);
      return;
    }
    // Looking at a linked bench: the dock on screen is that bench's, so the
    // toggle has to act on it rather than on the local project's.
    const sel = remoteSelRef.current;
    if (sel) {
      const m = machinesRef.current.find((x) => x.url === sel.url);
      if (!m) return;
      const tabs = (remoteDockRef.current[m.url] ?? []).filter(
        (p) => p.projectPath === sel.cwd,
      );
      if (!tabs.length) {
        spawnRemoteDockTerm(m, sel.cwd); // opens the dock itself
        return;
      }
      setDockOpen(true);
      return;
    }
    const path = activePathRef.current;
    if (!path) return;
    const tabs = panesRef.current.filter((p) => p.dock && p.projectPath === path);
    if (!tabs.length) {
      spawnDockTerm(); // opens the dock itself
      return;
    }
    setDockOpen(true);
    const target =
      tabs.find((p) => p.id === dockTabsRef.current[path]) ?? tabs[0];
    setTimeout(() => focusAgent(target), 60);
  };

  // Background-tasks rail row → the thing that owns the work.
  const openTask = (row) => {
    if (row.kind === "schedule" && row.run) {
      openScheduleRun(row.run, row.schedule);
      return;
    }
    const pane = panesRef.current.find((p) => p.id === row.paneId);
    if (!pane) return;
    setRemoteSel(null);
    if (pane.dock) {
      setDockOpen(true);
      setDockTabs((t) => ({ ...t, [pane.projectPath]: pane.id }));
    }
    if (pane.projectPath !== activePathRef.current) {
      setActivePath(pane.projectPath);
      setTimeout(() => focusAgent(pane), 50);
    } else {
      focusAgent(pane);
    }
  };

  const openNotification = (n) => {
    const pane = panesRef.current.find((p) => p.id === n.paneId);
    if (!pane) return; // agent closed since
    setNotifOpen(false);
    setRemoteSel(null); // notifications are local panes; surface the local grid
    if (pane.projectPath !== activePathRef.current) {
      setActivePath(pane.projectPath);
      // pane mounts on next render; focus after it exists
      setTimeout(() => focusAgent(pane), 50);
    } else {
      focusAgent(pane);
    }
  };

  // Command menu hotkey (configurable in Settings → Hotkeys). Capture
  // phase so the terminals never see the keystroke.
  useEffect(() => {
    const onKey = (e) => {
      if (!matchesHotkey(e, settingsRef.current.commandMenuKey)) return;
      e.preventDefault();
      e.stopPropagation();
      setCmdMenuOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Auto grid columns track the real content-area width (so the sidebar,
  // plans pane, and webview zoom are all naturally accounted for).
  // settings.cols = 0 means auto; a nonzero value pins the count.
  const contentRef = useRef(null);
  const [gridW, setGridW] = useState(() => window.innerWidth);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setGridW(el.clientWidth));
    ro.observe(el);
    setGridW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const effCols = settings.cols || autoCols(gridW);
  const effColsRef = useRef(effCols);
  effColsRef.current = effCols;

  // UI scale (webview zoom). Re-applied on resize because dragging a
  // maximized window to another display resizes it — that's the moment the
  // auto scale should re-evaluate against the new screen.
  useEffect(() => {
    applyUiScale(settings.uiScale);
    const onResize = () => applyUiScale(settingsRef.current.uiScale);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [settings.uiScale]);

  // ⌘/Ctrl +/− nudge the scale, ⌘/Ctrl 0 back to auto. Capture phase so
  // the terminals never see the keystroke.
  useEffect(() => {
    const onKey = (e) => {
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      if (!["=", "+", "-", "0"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const s = settingsRef.current;
      let uiScale = 0;
      if (e.key !== "0") {
        const cur = resolveUiScale(s.uiScale);
        let i = SCALE_STEPS.reduce(
          (best, v, idx) =>
            Math.abs(v - cur) < Math.abs(SCALE_STEPS[best] - cur) ? idx : best,
          0,
        );
        i += e.key === "-" ? -1 : 1;
        uiScale = SCALE_STEPS[Math.max(0, Math.min(SCALE_STEPS.length - 1, i))];
      }
      const next = { ...s, uiScale };
      setSettings(next);
      // settings window keeps live state while preloaded — let it adopt
      emit("settings-changed", next).catch(() => {});
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // ⌘1-9 focus agent N in active project · ⌘⇧1-9 switch project · ⌘` cycle agents
  useEffect(() => {
    const onKey = (e) => {
      // Ctrl+T toggles the bottom terminal dock; keep Ctrl+` as an alias.
      // Capture before terminal widgets and the agent-cycle shortcut.
      if (
        (e.key.toLowerCase() === "t" || e.code === "Backquote") &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) toggleDock();
        return;
      }
      // dock shells are outside the grid — ⌘1-9 / arrows / ⌘` skip them
      const inProject = panesRef.current.filter(
        (p) => p.projectPath === activePath && !p.dock,
      );

      // Pane navigation: user-chosen modifier + arrows (Settings), plus
      // vim-style ⌘H/J/K/L (Cmd only — Ctrl+H/J/K/L are real terminal
      // control characters). Runs in the capture phase and stops
      // propagation so the keystroke never reaches the focused terminal.
      const navMod = settingsRef.current.navMod;
      const modHeld =
        navMod === "ctrl"
          ? e.ctrlKey && !e.metaKey && !e.altKey
          : navMod === "alt"
            ? e.altKey && !e.metaKey && !e.ctrlKey
            : navMod === "meta"
              ? e.metaKey && !e.ctrlKey && !e.altKey
              : false;
      const VIM = { h: "ArrowLeft", j: "ArrowDown", k: "ArrowUp", l: "ArrowRight" };
      const navKey =
        modHeld && e.key.startsWith("Arrow")
          ? e.key
          : e.metaKey
            ? VIM[e.key.toLowerCase()]
            : undefined;
      if (navKey && inProject.length) {
        e.preventDefault();
        e.stopPropagation();
        const idx = inProject.findIndex((p) => p.id === focusedRef.current);
        if (idx === -1) {
          focusAgent(inProject[0]);
          return;
        }
        const gridCols = effColsRef.current;
        const step = {
          ArrowLeft: -1,
          ArrowRight: 1,
          ArrowUp: -gridCols,
          ArrowDown: gridCols,
        }[navKey];
        const next = idx + step;
        if (next >= 0 && next < inProject.length) focusAgent(inProject[next]);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const digit = e.code.startsWith("Digit") ? Number(e.code.slice(5)) : null;
      if (digit >= 1 && digit <= 9) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          const shown = projects.filter((p) => !p.hidden);
          if (shown[digit - 1]) {
            setActivePath(shown[digit - 1].path);
            setRemoteSel(null);
          }
        } else {
          focusAgent(inProject[digit - 1]);
        }
      } else if (e.code === "Backquote") {
        e.preventDefault();
        e.stopPropagation();
        if (inProject.length === 0) return;
        const cur = inProject.findIndex((p) => p.id === focusedRef.current);
        const step = e.shiftKey ? -1 : 1;
        const next =
          inProject[(cur + step + inProject.length) % inProject.length];
        focusAgent(next);
      }
    };
    // capture phase: handle nav keys before the terminal widgets see them
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [projects, activePath]);

  const renameProject = (path, name) => {
    const clean = name.trim();
    if (clean) {
      setProjects((ps) =>
        ps.map((p) => (p.path === path ? { ...p, name: clean } : p)),
      );
    }
    setRenaming(null);
  };

  // WebKit doesn't blur inputs when clicking non-focusable elements, so
  // commit the rename ourselves on any outside interaction.
  useEffect(() => {
    if (!renaming) return;
    const commit = (e) => {
      if (e.target === renameInputRef.current) return;
      renameProject(renaming, renameInputRef.current?.value ?? "");
    };
    window.addEventListener("mousedown", commit, true);
    return () => window.removeEventListener("mousedown", commit, true);
  }, [renaming]);

  const activeProject = projects.find((p) => p.path === activePath);
  // grid panes only — dock shells live in the TerminalDock below the grid
  const activePanes = panes.filter(
    (p) => p.projectPath === activePath && !p.dock,
  );

  // Flat action list for the command menu; rebuilt on open so it always
  // reflects the current projects/agents/plans.
  const commands = useMemo(() => {
    if (!cmdMenuOpen) return [];
    const cmds = [];
    if (activeProject) {
      cmds.push({ id: "new-agent", label: "New Agent", action: addAgent });
      for (const h of getHarnesses(settings)) {
        const missing = harnessMissing(h);
        cmds.push({
          id: `new-agent-${h.id}`,
          group: "New Agent",
          label: h.name,
          hint: missing
            ? "install in Settings…"
            : h.id === (settings.defaultHarness ?? "claude")
              ? "default"
              : undefined,
          action: () => (missing ? openSettings() : spawnAgent(undefined, h.id)),
        });
      }
      cmds.push({
        id: "new-agent-claude-chat",
        group: "New Agent",
        label: "Claude (Chat)",
        hint: "headless — chat UI, no terminal",
        action: spawnChatAgent,
      });
      if (activePanes.length > 0) {
        for (const dir of ["left", "right", "up", "down"]) {
          cmds.push({
            id: `new-agent-${dir}`,
            label: `New Agent ${dir[0].toUpperCase()}${dir.slice(1)}`,
            action: () => spawnAgent(dir),
          });
        }
      }
      cmds.push({
        id: "resume-session",
        label: "Resume previous session…",
        hint: "reopen a past Claude conversation",
        action: () => setSessionsOpen(true),
      });
      cmds.push({
        id: "toggle-plans",
        label: showPlans ? "Hide plans panel" : "Show plans panel",
        action: () => setShowPlans((s) => !s),
      });
      cmds.push({
        id: "new-terminal",
        label: "New terminal",
        hint: "shell tab in the dock",
        action: spawnDockTerm,
      });
      cmds.push({
        id: "toggle-dock",
        label: dockOpen ? "Hide terminal dock" : "Show terminal dock",
        hint: "Ctrl+T",
        action: toggleDock,
      });
      cmds.push({
        id: "new-plan",
        label: "New plan…",
        action: () => setComposerOpen(true),
      });
      for (const c of activeProject.commands ?? []) {
        cmds.push({
          id: `run-${c.id}`,
          group: "Run",
          label: c.name,
          hint: c.command,
          action: () => runCommand(activeProject, c),
        });
      }
      cmds.push({
        id: "edit-run-commands",
        label: "Run commands…",
        action: () => setRunDialog(activePath),
      });
      cmds.push({
        id: "edit-teams",
        label: "Teams…",
        hint: "saved agent setups for this project",
        action: () => setTeamsDialog(activePath),
      });
      for (const t of projectTeams[activePath] ?? []) {
        const running = activePanes.filter((p) => p.team?.team_id === t.id).length;
        const missing = missingSeats(t, activePanes).length;
        cmds.push({
          id: `team-start-${t.id}`,
          group: "Teams",
          label: running ? `Start missing: ${t.name}` : `Start team: ${t.name}`,
          hint: missing ? `${missing} of ${t.agents.length} agents` : "all running — focus",
          action: () => launchTeam(activePath, t),
        });
        if (running) {
          cmds.push({
            id: `team-stop-${t.id}`,
            group: "Teams",
            label: `Stop team: ${t.name}`,
            hint: `kills ${running} agent${running === 1 ? "" : "s"}`,
            action: () => stopTeam(activePath, t.id),
          });
        }
      }
    }
    cmds.push({ id: "add-project", label: "Add project…", action: addProject });
    cmds.push({ id: "settings", label: "Open Settings", action: openSettings });
    cmds.push({
      id: "restart-broker",
      label: "Restart broker",
      hint: "stops all agents — sessions resume",
      action: async () => {
        try {
          await invoke("shutdown_broker");
        } catch {
          /* already down */
        }
        const { relaunch } = await import("@tauri-apps/plugin-process");
        relaunch().catch(() => {});
      },
    });
    projects.filter((p) => !p.hidden).concat(projects.filter((p) => p.hidden)).forEach((p, i) => {
      if (p.path === activePath) return;
      cmds.push({
        id: `project-${p.path}`,
        group: "Project",
        label: p.hidden ? `${p.name} (hidden)` : p.name,
        hint: i < 9 && !p.hidden ? `⌘⇧${i + 1}` : undefined,
        action: () => {
          setActivePath(p.path);
          setRemoteSel(null);
        },
      });
    });
    activePanes.forEach((p, i) => {
      cmds.push({
        id: `agent-${p.id}`,
        group: "Agent",
        label: titles[p.id] || p.label,
        hint: i < 9 ? `⌘${i + 1}` : undefined,
        action: () => focusAgent(p),
      });
    });
    for (const pl of projectPlans[activePath] ?? []) {
      cmds.push({
        id: `plan-${pl.path}`,
        group: "Plan",
        label: pl.title || pl.slug,
        action: () => openPlan(pl),
      });
    }
    for (const [id, t] of Object.entries(THEMES)) {
      cmds.push({
        id: `theme-${id}`,
        group: "Theme",
        label: t.name,
        hint: settings.theme === id ? "current" : undefined,
        action: () => setSettings((s) => ({ ...s, theme: id })),
      });
    }
    cmds.push({
      id: "schedules",
      label: "Schedules…",
      hint: "recurring prompts with reviewable runs",
      action: () => setSchedulesOpen(true),
    });
    cmds.push({
      id: "toggle-tasks",
      label: tasksOpen ? "Hide background tasks" : "Show background tasks",
      hint: "agents · shells · scheduled runs",
      action: () => setTasksOpen((o) => !o),
    });
    return cmds;
  }, [cmdMenuOpen, activeProject, activePath, projects, activePanes, titles, projectPlans, projectTeams, showPlans, dockOpen, tasksOpen, settings.theme, settings.defaultHarness, settings.customHarnesses]);

  return (
    <div className="app">
      <header
        className={`topbar${IS_MAC ? " mac" : ""}`}
        data-tauri-drag-region
      >
        <div className="brand" data-tauri-drag-region>
          <Logo className="brand-logo" aria-label="AgentBench" />
        </div>
        <div className="topbar-right" data-tauri-drag-region>
          {activeProject && !remoteSel && (
            <span className="agent-count" data-tauri-drag-region>
              {activeProject.name} · {activePanes.length} agent
              {activePanes.length === 1 ? "" : "s"}
            </span>
          )}
          {activeProject && !remoteSel && (
            <button
              className={`btn-icon${showPlans ? " active" : ""}`}
              title={showPlans ? "Hide plans panel" : "Show plans panel"}
              onClick={() => setShowPlans((s) => !s)}
            >
              <FileText size={15} />
            </button>
          )}
          <button
            className="btn-icon"
            title="Schedules — recurring prompts"
            onClick={() => setSchedulesOpen(true)}
          >
            <CalendarCheck size={15} />
          </button>
          <button className={`btn-icon${resourcesOpen ? " active" : ""}`} title="Agent resources" onClick={() => setResourcesOpen((open) => !open)}><Cpu size={15}/></button>
          {(activeProject || remoteSel) && (
            <button
              className={`btn-icon${dockOpen ? " active" : ""}`}
              title="Terminal dock (Ctrl+T)"
              onClick={toggleDock}
            >
              <TerminalWindow size={15} />
            </button>
          )}
          <button
            className={`btn-icon task-btn${tasksOpen ? " active" : ""}`}
            title="Background tasks — agents, shells and scheduled runs"
            onClick={() => setTasksOpen((o) => !o)}
          >
            <Pulse size={15} />
            {runningTasks.length > 0 && (
              <span className="notif-badge task-badge">
                {runningTasks.length > 9 ? "9+" : runningTasks.length}
              </span>
            )}
          </button>
          <Popover.Root
            open={notifOpen}
            onOpenChange={(o) => {
              setNotifOpen(o);
              if (o) setNotifs((l) => l.map((n) => (n.read ? n : { ...n, read: true })));
            }}
          >
            <Popover.Trigger asChild>
              <button className="btn-icon notif-bell" title="Notifications">
                <Bell size={15} />
                {(() => {
                  const unread = notifs.filter((n) => !n.read).length;
                  return unread > 0 ? (
                    <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>
                  ) : null;
                })()}
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className="notif-pop" align="end" sideOffset={8}>
                <div className="notif-head">
                  <span>Recent activity</span>
                  {notifs.length > 0 && (
                    <button className="notif-clear" onClick={() => setNotifs([])}>
                      Clear
                    </button>
                  )}
                </div>
                {notifs.length === 0 ? (
                  <div className="notif-empty">
                    <LogoMark className="notif-empty-mark" aria-hidden="true" />
                    Nothing yet. Agents report here when they finish.
                  </div>
                ) : (
                  notifs.map((n) => {
                    const alive = panes.some((p) => p.id === n.paneId);
                    return (
                      <button
                        key={n.key}
                        className={`notif-item${alive ? "" : " stale"}`}
                        onClick={() => openNotification(n)}
                        title={alive ? "Go to agent" : "Agent closed"}
                      >
                        <span className={`notif-dot ${n.kind === "done" ? "done" : "input"}`} />
                        <span className="notif-body">
                          <span className="notif-title">
                            {n.label}
                            {n.project ? ` · ${n.project}` : ""}
                          </span>
                          <span className="notif-sub">
                            {n.kind === "done" ? "Finished its turn" : "Waiting for your input"} ·{" "}
                            {timeAgo(n.ts)}
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <button className="btn-icon" title="Settings" onClick={openSettings}>
            <GearSix size={15} />
          </button>
          {activeProject &&
            !remoteSel &&
            ((activeProject.commands?.length ?? 0) === 0 ? (
              <button
                className="btn-new"
                title="Set up run commands for this project"
                onClick={() => setRunDialog(activePath)}
              >
                <Play size={13} weight="fill" /> Run…
              </button>
            ) : (
              <div className="btn-new-split">
                <button
                  className="btn-new"
                  title={activeProject.commands[0].command}
                  onClick={() => runCommand(activeProject, activeProject.commands[0])}
                >
                  <Play size={13} weight="fill" /> Run {activeProject.commands[0].name}
                  {activePanes.some(
                    (p) => p.kind === "run" && p.hidden && statuses[p.id] !== "exited",
                  ) && <span className="run-dot" />}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="btn-new btn-new-caret" title="Run a different command">
                      <CaretDown size={11} weight="bold" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[200px]">
                    {activeProject.commands.map((c) => {
                      const pane = activePanes.find(
                        (p) => p.kind === "run" && p.label === c.name,
                      );
                      const st = pane ? statuses[pane.id] : null;
                      const hint =
                        pane && st !== "exited"
                          ? pane.hidden
                            ? "running — show"
                            : "running"
                          : c.command;
                      return (
                        <DropdownMenuItem
                          key={c.id}
                          onSelect={() => runCommand(activeProject, c)}
                        >
                          {c.name}
                          <span className="ml-auto text-xs opacity-50">{hint}</span>
                        </DropdownMenuItem>
                      );
                    })}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setRunDialog(activePath)}>
                      Edit commands…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          {activeProject && !remoteSel && (
            <div className="btn-new-split">
              <button className="btn-new" onClick={addAgent}>
                <Plus size={13} weight="bold" /> New{" "}
                {getHarness(settings, settings.defaultHarness).name}
              </button>
              <DropdownMenu onOpenChange={(o) => o && refreshHarnessAvail()}>
                <DropdownMenuTrigger asChild>
                  <button className="btn-new btn-new-caret" title="Spawn a different agent">
                    <CaretDown size={11} weight="bold" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[190px]">
                  {getHarnesses(settings).map((h) => {
                    const missing = harnessMissing(h);
                    return (
                      <DropdownMenuItem
                        key={h.id}
                        // spawning a missing binary just kills the pane —
                        // send the user to Settings → Agents to install it
                        onSelect={() =>
                          missing ? openSettings() : spawnAgent(undefined, h.id)
                        }
                      >
                        {h.name}
                        {missing ? (
                          <span className="ml-auto text-xs opacity-50">
                            install in Settings…
                          </span>
                        ) : (
                          h.id === (settings.defaultHarness ?? "claude") && (
                            <span className="ml-auto text-xs opacity-50">
                              default
                            </span>
                          )
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={spawnChatAgent}>
                    Claude (Chat)
                    <span className="ml-auto text-xs opacity-50">headless</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setSessionsOpen(true)}>
                    Resume session…
                    <span className="ml-auto text-xs opacity-50">--resume</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          {IS_WINDOWS && <WindowControls />}
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          {/* Inbox — finished chats surface here like messages, newest first;
              clear them once acted on. Snippets are the agent's closing words. */}
          <div className="inbox">
            <div className="sidebar-head inbox-head">
              <Tray size={12} weight="bold" />
              <span>Inbox</span>
              {(() => {
                const unread = inbox.filter((n) => !n.read).length;
                return unread > 0 ? (
                  <span className="inbox-badge">{unread > 9 ? "9+" : unread}</span>
                ) : null;
              })()}
              {inbox.length > 0 && (
                <button
                  className="inbox-clear"
                  title="Clear the inbox"
                  onClick={() => setInbox([])}
                >
                  Clear
                </button>
              )}
            </div>
            {inbox.length > 0 && (
              <div className="inbox-list">
                {inbox.map((n) => {
                  const alive = panes.some((p) => p.id === n.paneId);
                  return (
                    <div
                      key={n.key}
                      className={`inbox-item${n.read ? "" : " unread"}${alive ? "" : " stale"}`}
                      title={alive ? "Go to agent" : "Agent closed"}
                      onClick={() => openInboxItem(n)}
                    >
                      <span
                        className={`inbox-dot ${n.kind === "done" ? "done" : "input"}`}
                      />
                      <span className="inbox-body">
                        <span className="inbox-title">
                          <span className="inbox-name">{n.label}</span>
                          <span className="inbox-time">{timeAgo(n.ts)}</span>
                        </span>
                        <span className="inbox-snippet">
                          {n.snippet ??
                            (n.kind === "done"
                              ? "Finished its turn."
                              : "Waiting for your input.")}
                        </span>
                        {n.project && (
                          <span className="inbox-proj">{n.project}</span>
                        )}
                      </span>
                      <button
                        className="inbox-x"
                        title="Clear from inbox"
                        aria-label="Clear from inbox"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          dismissInbox(n.key);
                        }}
                      >
                        <X size={10} weight="bold" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="sidebar-head">Projects</div>
          {/* one scroll container for local projects AND bench sections, so
              linked machines sit right under the local list instead of being
              pushed to the sidebar's bottom by a stretched project list */}
          <div className="sidebar-scroll">
          <nav className="project-list">
            {(() => {
            const shownProjects = projects.filter((p) => !p.hidden);
            const hiddenProjects = projects.filter((p) => p.hidden);
            const hiddenAttn = hiddenProjects
              .map((p) => projectStatus(p.path))
              .find((st) => st === "input" || st === "done");
            const renderProject = (p, i) => {
              const st = projectStatus(p.path);
              const count = panes.filter(
                (pane) => pane.projectPath === p.path,
              ).length;
              return (
                <ContextMenu key={p.path}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={`project ${p.path === activePath ? "active" : ""} attn-${st} ${p.color ? "colored" : ""} ${p.hidden ? "is-hidden" : ""} ${projDrag?.path === p.path ? "dragging" : ""} ${projDrag?.over === p.path && projDrag.path !== p.path ? (projDrag.after ? "drop-after" : "drop-before") : ""}`}
                      style={p.color ? { "--proj-color": p.color } : undefined}
                      title={p.path}
                      data-project-path={p.path}
                      onPointerDown={(ev) => onProjectPointerDown(ev, p.path)}
                      onClick={() => {
                        if (projDragClickGuard.current) return;
                        setActivePath(p.path);
                        setRemoteSel(null);
                      }}
                    >
                      <span className={`dot ${st}`} />
                      {renaming === p.path ? (
                        <input
                          ref={renameInputRef}
                          className="project-rename"
                          defaultValue=""
                          placeholder={p.name}
                          autoFocus
                          spellCheck={false}
                          onKeyDown={(ev) => {
                            ev.stopPropagation();
                            if (ev.key === "Enter")
                              renameProject(p.path, ev.target.value);
                            if (ev.key === "Escape") setRenaming(null);
                          }}
                        />
                      ) : (
                        <span className="project-name">{p.name}</span>
                      )}
                      {count > 0 && (
                        <span className="project-count">{count}</span>
                      )}
                      {!p.hidden && i < 9 && (
                        <span className="project-key">⌘⇧{i + 1}</span>
                      )}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent
                    className="min-w-[180px]"
                    onCloseAutoFocus={(ev) => {
                      // let the rename input keep focus instead of the trigger
                      if (renameInputRef.current) {
                        ev.preventDefault();
                        renameInputRef.current.focus();
                      }
                    }}
                  >
                    <ContextMenuItem onSelect={() => setRenaming(p.path)}>
                      Rename
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => revealItemInDir(p.path).catch(() => {})}
                    >
                      Reveal in Finder
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => setRunDialog(p.path)}>
                      Run commands…
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => setTeamsDialog(p.path)}>
                      Teams…
                    </ContextMenuItem>
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>Color</ContextMenuSubTrigger>
                      <ContextMenuSubContent className="min-w-[140px]">
                        {PROJECT_COLORS.map((c) => (
                          <ContextMenuItem
                            key={c.value}
                            onSelect={() =>
                              updateProject(p.path, { color: c.value })
                            }
                          >
                            <span
                              className="color-swatch"
                              style={{ background: c.value }}
                            />
                            {c.name}
                            {p.color === c.value && (
                              <span className="ml-auto text-xs opacity-50">
                                ✓
                              </span>
                            )}
                          </ContextMenuItem>
                        ))}
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          onSelect={() =>
                            updateProject(p.path, { color: undefined })
                          }
                        >
                          <span className="color-swatch color-swatch-none" />
                          Default
                        </ContextMenuItem>
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onSelect={() => setProjectHidden(p.path, !p.hidden)}
                    >
                      {p.hidden ? "Show in sidebar" : "Hide from sidebar"}
                    </ContextMenuItem>
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => removeProject(p.path)}
                    >
                      Remove project
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            };
            return (
              <>
                {shownProjects.map(renderProject)}
                {hiddenProjects.length > 0 && (
                  <>
                    <button
                      type="button"
                      className={`hidden-projects-toggle ${showHiddenProjects ? "open" : ""}`}
                      onClick={() => setShowHiddenProjects((v) => !v)}
                      title={showHiddenProjects ? "Collapse hidden projects" : "Show hidden projects"}
                    >
                      <CaretDown size={10} weight="bold" className="hidden-projects-caret" />
                      Hidden · {hiddenProjects.length}
                      {!showHiddenProjects && hiddenAttn && (
                        <span className={`dot ${hiddenAttn}`} />
                      )}
                    </button>
                    {showHiddenProjects && hiddenProjects.map(renderProject)}
                  </>
                )}
              </>
            );
            })()}
          </nav>

          {/* Linked benches: one section per machine, its projects grouped
              from the fleet snapshot exactly like the phone's fleet tab. */}
          {machines.map((m) => {
            const groups = groupPanes(m);
            const label = m.machine ?? m.name ?? baseName(m.url);
            return (
              <div className="bench" key={m.url}>
                <div className="sidebar-head bench-head" title={m.url}>
                  <span className={`bench-dot${m.connected ? " on" : ""}`} />
                  {label}
                </div>
                <nav className="project-list">
                  {groups.map((g) => {
                    const on = remoteSel?.url === m.url && remoteSel?.cwd === g.cwd;
                    return (
                      <div
                        key={g.cwd}
                        className={`project remote ${on ? "active" : ""} attn-${g.status}`}
                        title={`${g.cwd} — on ${label}`}
                        onClick={() => setRemoteSel({ url: m.url, cwd: g.cwd })}
                      >
                        <span className={`dot ${g.status}`} />
                        <span className="project-name">{g.name}</span>
                        {g.panes.length > 0 && (
                          <span className="project-count">{g.panes.length}</span>
                        )}
                      </div>
                    );
                  })}
                  {groups.length === 0 && (
                    <div className="bench-empty">
                      {m.connected ? "no projects yet" : "connecting…"}
                    </div>
                  )}
                </nav>
              </div>
            );
          })}
          </div>

          <button className="btn-add-project" onClick={addProject}>
            <Plus size={12} weight="bold" /> Add project
          </button>
        </aside>

        <div className="content" ref={contentRef}>
          {resources && ["warning", "critical"].includes(resources.pressure) && (
            <div className="resource-pressure" role="status">
              Memory pressure is {resources.pressure}.
              <button className="btn-sm" onClick={() => setResourcesOpen(true)}>Review idle agents</button>
            </div>
          )}
          {resourcesOpen && <ResourcePanel state={resources} panes={panes} titles={titles}
            error={resourceError} busy={resourceBusy} onAction={resourceAction} onPolicy={saveResourcePolicy}
            onClose={() => setResourcesOpen(false)} onFocus={(p) => { if (p) { setActivePath(p.projectPath); focusAgent(p); } }}/>}
          {remoteSel ? null : !activeProject ? (
            <div className="empty">
              <div className="empty-inner">
                <Logo className="empty-logo" aria-label="AgentBench" />
                <p>
                  Add a project folder, then spawn coding agents inside it. When
                  an agent finishes or needs you, its pane glows and you hear a
                  ping.
                </p>
                <button className="btn-new big" onClick={addProject}>
                  <Plus size={15} weight="bold" /> Add project
                </button>
              </div>
            </div>
          ) : activePanes.length === 0 ? (
            <div className="empty">
              <div className="empty-inner">
                <LogoMark className="empty-mark" aria-hidden="true" />
                <h1>{activeProject.name}</h1>
                <p className="empty-path">{activeProject.path}</p>
                <button className="btn-new big" onClick={addAgent}>
                  <Plus size={15} weight="bold" /> New Agent
                </button>
              </div>
            </div>
          ) : null}

          {/* All panes stay mounted so terminals and ptys survive project
              switches; inactive projects are just hidden. */}
          {projects.map((proj) => {
            const projPanes = panes.filter(
              (p) => p.projectPath === proj.path && !p.dock,
            );
            if (projPanes.length === 0) return null;
            // Group "focus"-layout team members: only the selected one takes
            // a cell, the others stay mounted but tucked behind its tabs.
            const teamGroups = {};
            for (const p of projPanes) {
              if (!p.team?.team_id) continue;
              const saved = projectTeams[proj.path]?.find((t) => t.id === p.team.team_id);
              if ((saved?.layout ?? "focus") !== "focus") continue;
              (teamGroups[p.team.team_id] ??= { saved, members: [] }).members.push(p);
            }
            const tucked = new Set();
            const tabsFor = {};
            for (const [teamId, { saved, members }] of Object.entries(teamGroups)) {
              if (members.length < 2) continue;
              const picked = teamFocus[`${proj.path}\0${teamId}`];
              const shown =
                members.find((m) => m.id === picked) ??
                members.find((m) => m.team.role === saved?.defaultTarget) ??
                members.find((m) => /manager|lead/i.test(m.team.role)) ??
                members[0];
              const tabs = members.map((m) => ({
                id: m.id,
                role: m.team.role,
                status: statuses[m.id] || "working",
              }));
              for (const m of members) {
                if (m.id !== shown.id) tucked.add(m.id);
                tabsFor[m.id] = tabs;
              }
            }
            const isHidden = (p) => p.hidden || tucked.has(p.id);
            // hidden panes take no grid cell, so pack only the visible ones
            const packed = packSpans(
              projPanes.filter((p) => !isHidden(p)),
              paneSizes,
              effCols,
            );
            return (
              <main
                key={proj.path}
                className="grid"
                style={{
                  display:
                    proj.path === activePath && !remoteSel ? undefined : "none",
                  gridTemplateColumns: `repeat(${effCols}, minmax(0, 1fr))`,
                }}
              >
                {projPanes.map((p) => (
                  <AgentPane
                    key={p.id}
                    id={p.id}
                    kind={p.kind}
                    hibernated={!!p.hibernated}
                    visible={pageVisible && proj.path === activePath && !remoteSel && !isHidden(p)}
                    scrollback={settings.terminalScrollback ?? 2000}
                    resource={resources?.panes?.find((r) => r.id === p.id)}
                    resourceBusy={resourceBusy[p.id]}
                    onResourceAction={(action, pinned) => resourceAction(action, p.id, pinned)}
                    sigintGuard={!!p.harness?.claude || !!p.claude}
                    claude={!!p.claude}
                    codex={p.harness?.id === "codex"}
                    view={paneViews[p.id] ?? settings.defaultPaneView ?? "chat"}
                    onViewChange={setPaneView}
                    initialLines={chatLines[p.id]}
                    hidden={isHidden(p)}
                    teamTabs={tabsFor[p.id]}
                    onTeamTab={(tabId) => {
                      const target = panesRef.current.find((x) => x.id === tabId);
                      if (target) focusAgent(target);
                    }}
                    command={p.command}
                    onHide={hideRun}
                    onRestart={p.hibernated ? undefined : () => p.kind === "run" ? restartRun(p) : restartAgent(p)}
                    onResumeRequest={() => setSessionsOpen(true)}
                    name={p.team?.role ?? (titles[p.id] || p.label)}
                    team={p.team?.team}
                    cwd={p.projectPath}
                    status={statuses[p.id] || "working"}
                    focused={focusedId === p.id}
                    agentColor={paneColors[p.id]}
                    engine={settings.engine}
                    termTheme={termTheme}
                    wordMod={settings.wordMod ?? "ctrl"}
                    copyOnSelect={settings.copyOnSelect !== false}
                    initialData={initialData[p.id]}
                    size={{ h: 1, w: packed[p.id] ?? 1 }}
                    gridCols={effCols}
                    onResize={resizePane}
                    onReorder={reorderPane}
                    onRegister={registerTerm}
                    onActivity={onActivity}
                    onTitle={onTitle}
                    onClose={onClose}
                  />
                ))}
              </main>
            );
          })}

          {/* Selected remote project: its panes render here, each driven by
              the owning machine's transport. Unlike local grids these unmount
              on switch-away — they rebuild from pane_buffer on reopen, the
              same trade the phone makes. */}
          {remoteSel &&
            (() => {
              const m = machines.find((x) => x.url === remoteSel.url);
              if (!m) return null;
              const group = groupPanes(m).find((g) => g.cwd === remoteSel.cwd);
              const projName = group?.name ?? baseName(remoteSel.cwd);
              const label = m.machine ?? m.name ?? baseName(m.url);
              const remoteDockIds = new Set(
                (remoteDock[m.url] ?? []).map((p) => p.id),
              );
              return (
                <div className="remote-view">
                  <div className="remote-bar">
                    <span className="remote-bar-name" title={remoteSel.cwd}>
                      {projName} · {label}
                      {!m.connected && " · disconnected"}
                    </span>
                    <span className="remote-bar-spacer" />
                    <RemotePreviewPopover
                      machine={m}
                      project={{ cwd: remoteSel.cwd, name: projName }}
                    />
                    {/* same split button as the local header; the missing-
                        binary badge is skipped because we can only probe the
                        local PATH, not {label}'s */}
                    <div className="btn-new-split">
                      <button
                        className="btn-new"
                        disabled={!m.connected}
                        title={`Start a new agent in ${projName} on ${label}`}
                        onClick={() => spawnRemoteAgent(m, remoteSel.cwd)}
                      >
                        <Plus size={13} weight="bold" /> New{" "}
                        {getHarness(settings, settings.defaultHarness).name}
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className="btn-new btn-new-caret"
                            disabled={!m.connected}
                            title="Spawn a different agent"
                          >
                            <CaretDown size={11} weight="bold" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[190px]">
                          {getHarnesses(settings).map((h) => (
                            <DropdownMenuItem
                              key={h.id}
                              onSelect={() =>
                                spawnRemoteAgent(m, remoteSel.cwd, h.id)
                              }
                            >
                              {h.name}
                              {h.id === (settings.defaultHarness ?? "claude") && (
                                <span className="ml-auto text-xs opacity-50">
                                  default
                                </span>
                              )}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() =>
                              m.transport
                                ?.invoke("create_chat_pane", { cwd: remoteSel.cwd })
                                .catch((err) =>
                                  console.error("remote spawn failed", err),
                                )
                            }
                          >
                            Claude (Chat)
                            <span className="ml-auto text-xs opacity-50">
                              headless
                            </span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  <main
                    className="grid remote-grid"
                    style={{
                      gridTemplateColumns: `repeat(${effCols}, minmax(0, 1fr))`,
                    }}
                  >
                    {(() => {
                      // Dock shells are ordinary panes on that broker, so the
                      // grid has to skip the ones the dock is showing.
                      const rp = (group?.panes ?? []).filter(
                        (p) => !remoteDockIds.has(p.id),
                      );
                      const rPacked = packSpans(rp, {}, effCols);
                      return rp.map((p) => (
                        <RemotePane
                          key={`${m.url}:${p.id}`}
                          machine={m}
                          pane={p}
                          status={p.status}
                          termTheme={termTheme}
                          defaultView={settings.defaultPaneView ?? "chat"}
                          span={rPacked[p.id] ?? 1}
                        />
                      ));
                    })()}
                  </main>
                  {(group?.panes ?? []).filter((p) => !remoteDockIds.has(p.id))
                    .length === 0 && (
                    <div className="empty">
                      <div className="empty-inner">
                        <LogoMark className="empty-mark" aria-hidden="true" />
                        <h1>{projName}</h1>
                        <p className="empty-path">
                          {remoteSel.cwd} — on {label}
                        </p>
                        <button
                          className="btn-new big"
                          disabled={!m.connected}
                          onClick={() => spawnRemoteAgent(m, remoteSel.cwd)}
                        >
                          <Plus size={15} weight="bold" /> New Agent on {label}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

          {/* Terminal dock — always mounted so its shells' terminals and
              ptys survive project switches and dock toggles; hidden with
              display:none like everything else that must stay alive. */}
          <TerminalDock
            panes={panes.filter((p) => p.dock)}
            activePath={activePath}
            visible={!remoteSel && !!activeProject}
            open={dockOpen}
            height={dockHeight}
            expanded={dockExpanded}
            activeTabs={dockTabs}
            focusedId={focusedId}
            titles={titles}
            statuses={statuses}
            termTheme={termTheme}
            copyOnSelect={settings.copyOnSelect !== false}
            initialData={initialData}
            onSelectTab={selectDockTab}
            onNewTerm={spawnDockTerm}
            onCloseTerm={closeDockTerm}
            scrollback={settings.terminalScrollback ?? 2000}
            pageVisible={pageVisible}
            onRestart={restartRun}
            onToggleExpand={() => setDockExpanded((x) => !x)}
            onHeightChange={setDockHeight}
            onRegister={registerTerm}
            onActivity={onActivity}
            onTitle={onTitle}
          />

          {/* One dock per linked bench, all kept mounted for the same reason
              the local one is: a shell on a VM must not die because you
              looked at another project. Each drives its bench's socket, so
              the tab strip is the same component end to end. */}
          {machines.map((m) => {
            // No socket yet: bail rather than let the transport prop fall
            // back to its local default, which would aim this bench's dock
            // at the local broker — where the same pane ids mean other panes.
            if (!m.transport) return null;
            const cwd = remoteSel?.url === m.url ? remoteSel.cwd : null;
            return (
              <TerminalDock
                key={`dock:${m.url}`}
                panes={remoteDock[m.url] ?? []}
                activePath={cwd}
                scope={cwd ? remoteScope(m.url, cwd) : null}
                transport={m.transport}
                visible={!!cwd}
                open={dockOpen}
                height={dockHeight}
                expanded={dockExpanded}
                activeTabs={dockTabs}
                focusedId={null}
                titles={m.titles ?? {}}
                statuses={m.statuses ?? {}}
                termTheme={termTheme}
                copyOnSelect={settings.copyOnSelect !== false}
                scrollback={settings.terminalScrollback ?? 2000}
                pageVisible={pageVisible}
                // No cached scrollback for a remote pane — XtermInner pulls
                // it from the bench over pane_buffer instead.
                initialData={{}}
                onSelectTab={(sc, id) =>
                  setDockTabs((t) => (t[sc] === id ? t : { ...t, [sc]: id }))
                }
                onNewTerm={() => spawnRemoteDockTerm(m, cwd)}
                onCloseTerm={(id) => closeRemoteDockTerm(m, id)}
                // Remote panes are not in the local focus registry, and run
                // panes have no remote restart path yet.
                onRestart={() => {}}
                onToggleExpand={() => setDockExpanded((x) => !x)}
                onHeightChange={setDockHeight}
                onRegister={() => {}}
                onActivity={() => {}}
                onTitle={() => {}}
              />
            );
          })}

          {/* scoped to its project: switching projects hides the overlay,
              switching back restores it */}
          {planView && planView.projectPath === activePath && !remoteSel && (
            <Suspense fallback={null}>
              <PlanOverlay
                path={planView.path}
                title={planView.title}
                refreshNonce={planNonces[planView.path] ?? 0}
                onClose={() => setPlanView(null)}
                onSend={(text) => {
                  // back to the terminals to watch the agent act on it
                  sendPlanFeedback(planView, text);
                  setPlanView(null);
                }}
              />
            </Suspense>
          )}
        </div>

        {activeProject && showPlans && !remoteSel && (
          <aside className="plan-rail">
            <div className="plan-rail-head">
              <FileText size={13} />
              <span className="plan-rail-head-label">Plans</span>
              <button
                className="btn-icon"
                title="New plan — write a scoped brief for an agent"
                onClick={() => setComposerOpen(true)}
              >
                <Plus size={12} weight="bold" />
              </button>
              <button
                className="btn-icon"
                title="Hide plans"
                onClick={() => setShowPlans(false)}
              >
                <X size={12} weight="bold" />
              </button>
            </div>
            <div className="plan-rail-list">
              {(projectPlans[activePath] ?? []).map((pl) => {
                const isOpen = planView?.path === pl.path;
                const isFresh = freshPlans.has(pl.path);
                return (
                  <button
                    key={pl.path}
                    className={`plan-rail-item ${isOpen ? "open" : ""}`}
                    title={pl.path}
                    onClick={() => openPlan(pl)}
                  >
                    <span className="plan-rail-title">
                      {isFresh && <span className="plan-rail-fresh" />}
                      {pl.title || pl.slug}
                    </span>
                    <span className="plan-rail-sub">
                      {pl.slug}
                      {isOpen ? " · open" : isFresh ? " · updated" : ""}
                    </span>
                  </button>
                );
              })}
              {(projectPlans[activePath] ?? []).length === 0 && (
                <div className="plan-rail-empty">
                  <LogoMark className="rail-empty-mark" aria-hidden="true" />
                  No plans yet — ask an agent to plan something and it shows
                  up here.
                </div>
              )}
            </div>
          </aside>
        )}

        {tasksOpen && (
          <TaskRail
            panes={panes}
            titles={titles}
            onOpenTask={openTask}
            onClose={() => setTasksOpen(false)}
          />
        )}
      </div>

      <CommandMenu
        open={cmdMenuOpen}
        onOpenChange={setCmdMenuOpen}
        commands={commands}
      />

      {runDialog && (
        <RunCommandsDialog
          project={projects.find((p) => p.path === runDialog)}
          onClose={() => setRunDialog(null)}
          onSave={(commands) => {
            updateProject(runDialog, { commands });
            setRunDialog(null);
          }}
        />
      )}

      {teamsDialog && projects.some((p) => p.path === teamsDialog) && (
        <TeamsDialog
          project={projects.find((p) => p.path === teamsDialog)}
          panes={panes.filter((p) => p.projectPath === teamsDialog)}
          titles={titles}
          harnesses={getHarnesses(settings).filter((h) => h.id !== "terminal")}
          onClose={() => setTeamsDialog(null)}
          onSaved={() => loadTeams(teamsDialog)}
          onLaunch={(team) => launchTeam(teamsDialog, team)}
          onStop={(team) => stopTeam(teamsDialog, team.id)}
        />
      )}

      {schedulesOpen && (
        <SchedulesDialog
          projects={projects}
          livePaneIds={panes.map((p) => p.id)}
          onClose={() => setSchedulesOpen(false)}
          onOpenRun={openScheduleRun}
        />
      )}

      {sessionsOpen && activeProject && (
        <SessionsDialog
          project={activeProject}
          onClose={() => setSessionsOpen(false)}
          onResume={(sid) => {
            setSessionsOpen(false);
            spawnAgent(undefined, "claude", sid);
          }}
        />
      )}

      {composerOpen && activeProject && (
        <PlanComposer
          project={activePath}
          agents={activePanes.map((p) => ({
            id: p.id,
            label: titles[p.id] || p.label,
            status: statuses[p.id] || "working",
          }))}
          defaultAgentId={
            activePanes.some((p) => p.id === focusedId)
              ? focusedId
              : activePanes[0]?.id
          }
          onClose={() => setComposerOpen(false)}
          onSubmit={submitPlanRequest}
        />
      )}
    </div>
  );
}
