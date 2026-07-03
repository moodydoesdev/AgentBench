import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
} from "@/components/ui/context-menu";
import { Bell, CaretDown, GearSix, Plus, FileText, X } from "@phosphor-icons/react";
import { Popover } from "radix-ui";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import notifyWav from "./assets/notify.wav";
import Logo from "./components/Logo";
import CommandMenu from "./components/CommandMenu";
import PlanComposer from "./PlanComposer";
import { matchesHotkey } from "./lib/hotkey";
import { THEMES } from "./themes";

const ping = new Audio(notifyWav);

const IS_MAC = navigator.userAgent.includes("Mac");
const IS_WINDOWS = navigator.userAgent.includes("Windows");

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
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
  const [settings, setSettings] = useState(loadSettings);
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
  const renameInputRef = useRef(null);

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
    invoke("write_pane", {
      id: target.id,
      data: `\x1b[200~${text}\x1b[201~`,
    }).catch(() => {});
    setTimeout(() => {
      invoke("write_pane", { id: target.id, data: "\r" }).catch(() => {});
    }, 150);
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
        });
        target = {
          id,
          projectPath: activePathRef.current,
          label: `${harness.name} ${id}`,
        };
        setPanes((p) => [...p, target]);
        setStatuses((s) => ({ ...s, [id]: "working" }));
        await new Promise((r) => setTimeout(r, 1800));
      } catch (err) {
        console.error("failed to spawn agent for plan request", err);
        return;
      }
    }
    invoke("write_pane", {
      id: target.id,
      data: `\x1b[200~${text}\x1b[201~`,
    }).catch(() => {});
    setTimeout(() => {
      invoke("write_pane", { id: target.id, data: "\r" }).catch(() => {});
    }, 150);
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
        const live = await invoke("list_panes");
        if (live.length) {
          setInitialData(Object.fromEntries(live.map((p) => [p.id, p.buffer])));
          setPaneColors(
            Object.fromEntries(
              live.filter((p) => p.color).map((p) => [p.id, p.color]),
            ),
          );
          setPanes(
            live.map((p) => ({
              id: p.id,
              projectPath: p.cwd,
              label: `${getHarness(settingsRef.current, p.harness ?? "claude").name} ${p.id}`,
            })),
          );
          setStatuses(Object.fromEntries(live.map((p) => [p.id, "working"])));
        }

        const saved = await invoke("saved_panes");
        const restored = [];
        for (const s of saved) {
          try {
            // resolve against current settings; a deleted custom harness
            // falls back to Claude
            const harness = getHarness(settingsRef.current, s.harness ?? "claude");
            const id = await invoke("create_pane", {
              cwd: s.cwd,
              cols: 100,
              rows: 30,
              resume: s.session_id ?? null,
              theme: harness.claude
                ? getTheme(settingsRef.current.theme).claudeTheme ?? null
                : null,
              harness,
            });
            restored.push({
              id,
              projectPath: s.cwd,
              label: `${harness.name} ${id}`,
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
      const { id, kind } = e.payload;
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
      setStatuses((s) =>
        e.payload.id in s ? { ...s, [e.payload.id]: "exited" } : s,
      );
    });

    const unColor = listen("pane-color", (e) => {
      const { id, color } = e.payload;
      setPaneColors((c) => (c[id] === color ? c : { ...c, [id]: color }));
    });

    // The settings window persists to localStorage and broadcasts the full
    // settings object; adopt it so the grid re-themes live.
    const unSettings = listen("settings-changed", (e) => {
      setSettings(e.payload);
    });

    return () => {
      unEvent.then((f) => f());
      unPlan.then((f) => f());
      unExit.then((f) => f());
      unColor.then((f) => f());
      unSettings.then((f) => f());
    };
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
  const spawnAgent = async (dir, harnessId) => {
    if (!activePath) return;
    const harness = getHarness(
      settingsRef.current,
      harnessId ?? settingsRef.current.defaultHarness,
    );
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
      resume: null,
      // theme only means something to Claude's settings file
      theme: harness.claude
        ? getTheme(settingsRef.current.theme).claudeTheme ?? null
        : null,
      harness,
    });
    const pane = { id, projectPath: activePath, label: `${harness.name} ${id}` };
    setPanes((p) => {
      const inProject = p.filter((x) => x.projectPath === activePath);
      const pos = inProject.findIndex((x) => x.id === focusedRef.current);
      if (!dir || pos === -1) return [...p, pane];
      const cols = settingsRef.current.cols;
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

  // User touched the pane: acknowledge the done/input glow.
  const onActivity = (id) => {
    focusedRef.current = id;
    setFocusedId(id);
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
  const projectStatus = (path) => {
    const ss = panesRef.current
      .filter((p) => p.projectPath === path)
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
    const handle = termRefs.current.get(pane.id);
    handle?.focus();
    handle?.scrollIntoView?.();
  };

  const openNotification = (n) => {
    const pane = panesRef.current.find((p) => p.id === n.paneId);
    if (!pane) return; // agent closed since
    setNotifOpen(false);
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

  // ⌘1-9 focus agent N in active project · ⌘⇧1-9 switch project · ⌘` cycle agents
  useEffect(() => {
    const onKey = (e) => {
      const inProject = panesRef.current.filter(
        (p) => p.projectPath === activePath,
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
        const gridCols = settingsRef.current.cols;
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
          if (projects[digit - 1]) setActivePath(projects[digit - 1].path);
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
  const activePanes = panes.filter((p) => p.projectPath === activePath);

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
        id: "toggle-plans",
        label: showPlans ? "Hide plans panel" : "Show plans panel",
        action: () => setShowPlans((s) => !s),
      });
      cmds.push({
        id: "new-plan",
        label: "New plan…",
        action: () => setComposerOpen(true),
      });
    }
    cmds.push({ id: "add-project", label: "Add project…", action: addProject });
    cmds.push({ id: "settings", label: "Open Settings", action: openSettings });
    projects.forEach((p, i) => {
      if (p.path === activePath) return;
      cmds.push({
        id: `project-${p.path}`,
        group: "Project",
        label: p.name,
        hint: i < 9 ? `⌘⇧${i + 1}` : undefined,
        action: () => setActivePath(p.path),
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
    return cmds;
  }, [cmdMenuOpen, activeProject, activePath, projects, activePanes, titles, projectPlans, showPlans, settings.theme, settings.defaultHarness, settings.customHarnesses]);

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
          {activeProject && (
            <span className="agent-count" data-tauri-drag-region>
              {activeProject.name} · {activePanes.length} agent
              {activePanes.length === 1 ? "" : "s"}
            </span>
          )}
          {activeProject && (
            <button
              className={`btn-icon${showPlans ? " active" : ""}`}
              title={showPlans ? "Hide plans panel" : "Show plans panel"}
              onClick={() => setShowPlans((s) => !s)}
            >
              <FileText size={15} />
            </button>
          )}
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
                  <div className="notif-empty">Nothing yet. Agents report here when they finish.</div>
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
          {activeProject && (
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
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          {IS_WINDOWS && <WindowControls />}
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-head">Projects</div>
          <nav className="project-list">
            {projects.map((p, i) => {
              const st = projectStatus(p.path);
              const count = panes.filter(
                (pane) => pane.projectPath === p.path,
              ).length;
              return (
                <ContextMenu key={p.path}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={`project ${p.path === activePath ? "active" : ""} attn-${st}`}
                      title={p.path}
                      onClick={() => setActivePath(p.path)}
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
                      {i < 9 && (
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
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => removeProject(p.path)}
                    >
                      Remove project
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </nav>
          <button className="btn-add-project" onClick={addProject}>
            <Plus size={12} weight="bold" /> Add project
          </button>
        </aside>

        <div className="content">
          {!activeProject ? (
            <div className="empty">
              <div className="empty-inner">
                <div className="empty-glyph">▮▮▮</div>
                <h1>Agent workspace</h1>
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
                <div className="empty-glyph">▮▮▮</div>
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
            const projPanes = panes.filter((p) => p.projectPath === proj.path);
            if (projPanes.length === 0) return null;
            return (
              <main
                key={proj.path}
                className="grid"
                style={{
                  display: proj.path === activePath ? undefined : "none",
                  gridTemplateColumns: `repeat(${settings.cols}, minmax(0, 1fr))`,
                }}
              >
                {projPanes.map((p) => (
                  <AgentPane
                    key={p.id}
                    id={p.id}
                    name={titles[p.id] || p.label}
                    cwd={p.projectPath}
                    status={statuses[p.id] || "working"}
                    focused={focusedId === p.id}
                    agentColor={paneColors[p.id]}
                    engine={settings.engine}
                    termTheme={termTheme}
                    wordMod={settings.wordMod ?? "ctrl"}
                    initialData={initialData[p.id]}
                    size={paneSizes[p.id]}
                    gridCols={settings.cols}
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

          {/* scoped to its project: switching projects hides the overlay,
              switching back restores it */}
          {planView && planView.projectPath === activePath && (
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

        {activeProject && showPlans && (
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
                  No plans yet — ask an agent to plan something and it shows
                  up here.
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      <CommandMenu
        open={cmdMenuOpen}
        onOpenChange={setCmdMenuOpen}
        commands={commands}
      />

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
