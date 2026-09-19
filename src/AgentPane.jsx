import { memo, useEffect, useRef, useState } from "react";
import usePaneDrag from "./usePaneDrag";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { homeDir, join } from "@tauri-apps/api/path";
import { Terminal as WtermTerminal } from "@wterm/react";
import { GhosttyCore } from "@wterm/ghostty";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  X,
  ArrowsOutLineHorizontal,
  ArrowClockwise,
  Minus,
  Play,
  Moon,
  PushPin,
} from "@phosphor-icons/react";
import ChatView from "./chat/ChatView";
import { formatBytes } from "./lib/resourceFormat";
import { createOutputBatcher } from "./lib/terminalOutput";
import { pasteAndSubmit } from "./lib/ptyPaste";
import { isTerminalReport } from "./lib/terminalReports";
import "@xterm/xterm/css/xterm.css";
import "@wterm/dom/css";

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function strToBytes(s) {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

const STATUS_LABEL = {
  working: "running",
  done: "done",
  input: "needs input",
  exited: "exited",
};

// Claude Code's /color palette → dot colors
const AGENT_COLORS = {
  red: "#f87171",
  blue: "#60a5fa",
  green: "#4ade80",
  yellow: "#facc15",
  purple: "#a78bfa",
  orange: "#fb923c",
  pink: "#f472b6",
  cyan: "#22d3ee",
};

// Claude Code exits on a quick double Ctrl+C. Swallow the repeat so a stray
// mash can't kill the agent; a single Ctrl+C (interrupt) still goes through.
// Applies only to Claude panes (sigintGuard prop) — terminal/run panes need
// repeated ^C to reach the process (e.g. stopping a stubborn dev server).
const SIGINT_GUARD_MS = 1500;


/**
 * wterm's DOM renderer ignores synchronized-output mode (DEC ?2026), so
 * Claude Code's mid-frame paints show through (wterm issue #57). Shim it:
 * buffer everything between BSU and ESU and flush each frame atomically.
 */
function createSyncFilter(write) {
  const PREFIX = "\x1b[?2026";
  const BSU = "\x1b[?2026h";
  const ESU = "\x1b[?2026l";
  let mode = false;
  let frame = "";
  let tail = "";
  let flushTimer = null;

  // longest partial marker at the end of s (full markers are caught by indexOf)
  const partialSuffixLen = (s) => {
    for (let k = Math.min(PREFIX.length, s.length); k > 0; k--) {
      if (s.endsWith(PREFIX.slice(0, k))) return k;
    }
    return 0;
  };

  return (bytes) => {
    let s = tail;
    tail = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    if (flushTimer) clearTimeout(flushTimer);

    while (s.length) {
      if (!mode) {
        const i = s.indexOf(BSU);
        if (i === -1) {
          const keep = partialSuffixLen(s);
          if (s.length - keep > 0) write(strToBytes(s.slice(0, s.length - keep)));
          tail = keep ? s.slice(s.length - keep) : "";
          s = "";
        } else {
          if (i > 0) write(strToBytes(s.slice(0, i)));
          s = s.slice(i + BSU.length);
          mode = true;
        }
      } else {
        const i = s.indexOf(ESU);
        if (i === -1) {
          const keep = partialSuffixLen(s);
          frame += s.slice(0, s.length - keep);
          tail = keep ? s.slice(s.length - keep) : "";
          s = "";
        } else {
          frame += s.slice(0, i);
          write(strToBytes(frame));
          frame = "";
          mode = false;
          s = s.slice(i + ESU.length);
        }
      }
    }

    // Safety valve: never hold a partial frame for long (lost ESU, etc.)
    if (mode && frame.length) {
      flushTimer = setTimeout(() => {
        write(strToBytes(frame));
        frame = "";
      }, 80);
    }
  };
}

const FALLBACK_STACK = '"SF Mono", Menlo, Consolas, monospace';
const FONT_STACK = `"FiraCode Nerd Font Mono", ${FALLBACK_STACK}`;

const IS_WINDOWS = navigator.userAgent.includes("Windows");

// File-path shapes in agent output: /abs/path, ~/path, ./rel, ../rel,
// src/App.jsx — with an optional :line[:col] suffix. Segments end on a
// non-dot so trailing sentence punctuation stays out of the link.
const FILE_PATH_RE =
  /(?:~|\.{1,2})?[\w.@%+-]*(?:\/[\w.@%+-]*[\w@%+-])+(?::\d+(?::\d+)?)?/;

// Also mounted by TerminalDock — dock tabs are the same terminal, minus the
// grid chrome.
export function XtermInner({
  id,
  cwd,
  initialData,
  register,
  sendData,
  onTitle,
  termTheme,
  copyOnSelect = true,
  visible = true,
  scrollback = 2000,
}) {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const outputRef = useRef(null);
  const gpuToggleRef = useRef(null);
  useEffect(() => {
    gpuToggleRef.current?.(visible);
    if (visible) outputRef.current?.flush();
  }, [visible]);
  useEffect(() => {
    if (termRef.current) termRef.current.options.scrollback = Math.max(500, Math.min(8000, scrollback));
  }, [scrollback]);
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const termThemeRef = useRef(termTheme);
  termThemeRef.current = termTheme;
  // live toggle without remounting the terminal
  const copyRef = useRef(copyOnSelect);
  copyRef.current = copyOnSelect;
  const [copyToast, setCopyToast] = useState(false);

  // Theme switches restyle the live terminal — no remount needed.
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
      // needed so a transparent theme bg (custom background image) works
      allowTransparency: true,
      cursorBlink: true,
      cursorInactiveStyle: "none",
      scrollback: Math.max(500, Math.min(8000, scrollback)),
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Windows: xterm maps Ctrl+V to the ^V control char (Linux-terminal
    // convention, paste = Ctrl+Shift+V), so the paste shortcut Windows
    // users expect does nothing. Intercept it: text in the clipboard →
    // normal (bracketed) paste; no text (e.g. an image) → forward ^V so
    // Claude Code's clipboard image paste still works.
    if (IS_WINDOWS) {
      term.attachCustomKeyEventHandler((ev) => {
        if (
          ev.type === "keydown" &&
          ev.ctrlKey &&
          !ev.shiftKey &&
          !ev.altKey &&
          !ev.metaKey &&
          ev.key.toLowerCase() === "v"
        ) {
          // Suppress the browser's native paste: returning false only skips
          // xterm's key handling, so WebView2 still fires a paste event that
          // xterm's textarea listener services — pasting a second copy on
          // top of the term.paste() below.
          ev.preventDefault();
          navigator.clipboard
            .readText()
            .then((text) => (text ? term.paste(text) : sendData("\x16")))
            .catch(() => sendData("\x16"));
          return false;
        }
        return true;
      });
    }
    // Clickable URLs and file paths — ctrl/⌘+click opens them (browser or
    // default app, which the OS brings to the foreground); plain clicks
    // stay free for selection.
    //
    // macOS quirk: WebKit turns ctrl+left-click into a right-click, so no
    // mouseup ever reaches xterm's linkifier and activate() never fires.
    // Track the hovered link and open it from the contextmenu event instead.
    const hovered = { open: null };
    const openLink = (uri) =>
      openUrl(uri).catch((err) => console.error("failed to open url", err));
    term.loadAddon(
      new WebLinksAddon(
        (ev, uri) => {
          if (ev.ctrlKey || ev.metaKey) openLink(uri);
        },
        {
          hover: (_ev, uri) => (hovered.open = () => openLink(uri)),
          leave: () => (hovered.open = null),
        },
      ),
    );
    // File paths open with the OS default app; :line[:col] suffixes are
    // stripped, relative paths resolve against the pane's cwd. Registered
    // after WebLinksAddon so URLs win where the two overlap.
    const openFile = async (raw) => {
      let p = raw.replace(/:\d+(?::\d+)?$/, "");
      try {
        if (p.startsWith("~/")) p = await join(await homeDir(), p.slice(2));
        else if (!p.startsWith("/")) p = await join(cwd, p);
        await openPath(p);
      } catch (err) {
        console.error("failed to open path", err);
      }
    };
    term.registerLinkProvider({
      // simple 1 char = 1 col mapping; fine for ASCII paths, skips the
      // wrapped-line stitching the URL addon does
      provideLinks(y, cb) {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) return cb(undefined);
        const text = line.translateToString(true);
        const rex = new RegExp(FILE_PATH_RE.source, "g");
        const links = [];
        let m;
        while ((m = rex.exec(text))) {
          const p = m[0];
          links.push({
            range: {
              start: { x: m.index + 1, y },
              end: { x: m.index + p.length, y },
            },
            text: p,
            activate: (ev) => {
              if (ev.ctrlKey || ev.metaKey) openFile(p);
            },
            hover: () => (hovered.open = () => openFile(p)),
            leave: () => (hovered.open = null),
          });
        }
        cb(links.length ? links : undefined);
      },
    });
    const onCtxMenu = (ev) => {
      if (!ev.ctrlKey || !hovered.open) return;
      ev.preventDefault();
      ev.stopPropagation();
      hovered.open();
    };
    const containerEl = containerRef.current;
    containerEl.addEventListener("contextmenu", onCtxMenu, true);
    // Highlight-to-copy, terminal style (Settings → Workspace toggle).
    // onSelectionChange fires on every drag tick, so debounce until the
    // selection settles; empty selections (plain clicks) must not clobber
    // the clipboard.
    let copyTimer = null;
    let toastTimer = null;
    term.onSelectionChange(() => {
      if (!copyRef.current || !term.getSelection()) return;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        const sel = term.getSelection();
        if (!sel) return;
        navigator.clipboard
          .writeText(sel)
          .then(() => {
            setCopyToast(true);
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => setCopyToast(false), 1300);
          })
          .catch(() => {});
      }, 250);
    });
    termRef.current = term;
    // Pane-nav hotkeys are intercepted app-wide in App.jsx (capture-phase
    // keydown with stopPropagation), so no custom key handler is needed here.
    term.open(containerRef.current);

    // GPU renderer — must load after open(). Without it xterm falls back to
    // its DOM renderer (blurry subpixel snapping, slow TUI repaints). On
    // context loss (driver reset, too many live contexts) dispose and let
    // xterm fall back to the DOM renderer on its own.
    let webgl = null;
    gpuToggleRef.current = (shown) => {
      term.options.cursorBlink = shown;
      if (!shown) { webgl?.dispose(); webgl = null; return; }
      if (webgl) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => { addon.dispose(); if (webgl === addon) webgl = null; });
        term.loadAddon(addon);
        webgl = addon;
      } catch { /* DOM renderer remains available */ }
    };
    gpuToggleRef.current(visibleRef.current);
    const output = createOutputBatcher((bytes) => term.write(bytes), () => visibleRef.current);
    outputRef.current = output;

    // Size the grid before replaying scrollback — otherwise initialData
    // reflows at xterm's default 80x24 and restores garbled.
    try {
      fit.fit();
    } catch {
      /* ignore mid-layout fit races */
    }

    // Re-measure glyphs once the webfont is ready; xterm caches cell
    // metrics at open() and would otherwise keep fallback-font widths.
    document.fonts.load('13px "FiraCode Nerd Font Mono"').then(() => {
      if (term.element && term.options.fontFamily !== FONT_STACK) {
        term.options.fontFamily = FONT_STACK;
        try {
          fit.fit();
        } catch {
          /* ignore mid-layout fit races */
        }
      }
    });

    if (initialData) term.write(b64ToBytes(initialData));

    term.onData(sendData);
    term.onResize(({ cols, rows }) => {
      invoke("resize_pane", { id, cols, rows }).catch(() => {});
    });
    term.onTitleChange(onTitle);

    // onResize only fires when dims change, and a single dropped resize_pane
    // (errors are swallowed broker-side too) leaves the pty permanently
    // desynced — Claude paints for the wrong width until the user manually
    // resizes. After each resize storm settles, resend current dims
    // unconditionally; the pty resize is idempotent.
    //
    // Project switches hide panes with display:none. Output written while
    // hidden lands in a 0x0 renderer, and on reveal fit() resolves to the
    // same cols/rows — no resize event, so xterm never repaints the stale
    // rows. On the hidden→visible edge, refresh the viewport AND flap the
    // pty one row (rows-1 → rows): the SIGWINCH pair makes a TUI whose
    // screen went bad while hidden repaint itself, same as a manual resize.
    let resyncTimer = null;
    let wasHidden = false;
    const ro = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      if (el.offsetWidth === 0 || el.offsetHeight === 0) {
        wasHidden = true;
        return;
      }
      try {
        fit.fit();
      } catch {
        /* ignore mid-layout fit races */
      }
      if (wasHidden) {
        wasHidden = false;
        term.refresh(0, term.rows - 1);
        invoke("resize_pane", {
          id,
          cols: term.cols,
          rows: Math.max(1, term.rows - 1),
        })
          .then(() =>
            invoke("resize_pane", { id, cols: term.cols, rows: term.rows }),
          )
          .catch(() => {});
      }
      clearTimeout(resyncTimer);
      resyncTimer = setTimeout(() => {
        // Re-fit once layout has settled: fit() above can throw (or compute
        // stale dims) mid-reflow, and if that was the storm's last RO tick
        // the grid stays too tall and the bottom rows clip. fit() is cheap
        // and a no-op when dims already match.
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
        invoke("resize_pane", { id, cols: term.cols, rows: term.rows }).catch(
          () => {},
        );
        term.refresh(0, term.rows - 1);
      }, 150);
    });
    ro.observe(containerRef.current);

    const unlisten = listen("pane-output", (e) => {
      if (e.payload.id === id) output.push(b64ToBytes(e.payload.data));
    });

    register({ focus: () => term.focus(), write: (d) => term.write(d) });

    return () => {
      register(null);
      clearTimeout(resyncTimer);
      clearTimeout(copyTimer);
      clearTimeout(toastTimer);
      ro.disconnect();
      containerEl.removeEventListener("contextmenu", onCtxMenu, true);
      unlisten.then((f) => f());
      output.dispose();
      outputRef.current = null;
      gpuToggleRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [id]);

  return (
    <>
      <div className="pane-term" ref={containerRef} />
      {copyToast && <div className="term-toast">Copied</div>}
    </>
  );
}

// Two wterm cores: the built-in zig core, or libghostty (full VT compliance,
// but upstream #78 residue). Sync-output and 256-col shims apply to both.
function WtermInner({
  id,
  ghostty,
  focused,
  visible = true,
  initialData,
  register,
  sendData,
  onTitle,
}) {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const outputRef = useRef(null);
  useEffect(() => { if (visible) outputRef.current?.flush(); }, [visible]);
  const [core, setCore] = useState(null);
  const termRef = useRef(null);
  const readyRef = useRef(false);
  const queueRef = useRef([]);
  const coreReady = !ghostty || core;

  // wterm ignores focus-tracking mode (issue #55), so Claude never hides its
  // drawn cursor in unfocused panes. Shim: watch for ?1004 and synthesize
  // the CSI I / CSI O focus reports from our own pane focus.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const focusModeRef = useRef(false);
  const scanTailRef = useRef("");

  const sendFocusReport = (inFocus) =>
    invoke("write_pane", { id, data: inFocus ? "\x1b[I" : "\x1b[O" }).catch(
      () => {},
    );

  useEffect(() => {
    if (focusModeRef.current) sendFocusReport(focused);
  }, [focused]);

  useEffect(() => {
    let alive = true;
    if (ghostty) {
      GhosttyCore.load({ wasmPath: "/ghostty-vt.wasm" })
        .then((c) => alive && setCore(c))
        .catch((err) => console.error("ghostty core failed to load", err));
    }
    return () => {
      alive = false;
      register(null);
    };
  }, [id, ghostty]);

  useEffect(() => {
    const write = (bytes) => {
      if (readyRef.current && termRef.current) termRef.current.write(bytes);
      else queueRef.current.push(bytes);
    };
    const output = createOutputBatcher(write, () => visibleRef.current);
    outputRef.current = output;
    const filter = createSyncFilter((bytes) => output.push(bytes));

    const scanFocusMode = (bytes) => {
      let s = scanTailRef.current;
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      if (s.includes("\x1b[?1004h")) {
        focusModeRef.current = true;
        sendFocusReport(focusedRef.current);
      }
      if (s.lastIndexOf("\x1b[?1004l") > s.lastIndexOf("\x1b[?1004h")) {
        focusModeRef.current = false;
      }
      scanTailRef.current = s.slice(-8);
    };

    // scrollback may already contain the mode-enable from before a reload
    if (initialData) scanFocusMode(b64ToBytes(initialData));

    const unlisten = listen("pane-output", (e) => {
      if (e.payload.id === id) {
        const bytes = b64ToBytes(e.payload.data);
        scanFocusMode(bytes);
        filter(bytes);
      }
    });
    return () => { output.dispose(); outputRef.current = null; unlisten.then((f) => f()); };
  }, [id]);

  // wterm swallows Ctrl+V and waits for a browser paste event that macOS
  // only fires for Cmd+V, so Claude Code's image paste never reaches the
  // pty. Send \x16 ourselves; Claude reads the image from the host
  // clipboard. Cmd+V still does a normal text paste.
  const handleKeyDownCapture = (ev) => {
    if (ev.ctrlKey && !ev.metaKey && ev.key === "v") {
      ev.preventDefault();
      ev.stopPropagation();
      sendData("\x16");
    }
  };

  return (
    <div className="pane-term wterm-host" onKeyDownCapture={handleKeyDownCapture}>
      {coreReady && (
        <WtermTerminal
          ref={(h) => {
            termRef.current = h;
            register(
              h && { focus: () => h.focus(), write: (d) => h.write(d) },
            );
          }}
          core={ghostty ? core : undefined}
          autoResize
          cursorBlink
          className="term"
          onReady={() => {
            readyRef.current = true;
            if (initialData) termRef.current?.write(b64ToBytes(initialData));
            for (const chunk of queueRef.current)
              termRef.current?.write(chunk);
            queueRef.current = [];
          }}
          onData={sendData}
          onTitle={onTitle}
          onResize={(cols, rows) => {
            if (cols < 2 || rows < 2) return;
            // wterm clamps its grid at 256 cols (issue #56); keep pty in sync
            invoke("resize_pane", {
              id,
              cols: Math.min(cols, 256),
              rows: Math.min(rows, 256),
            }).catch(() => {});
          }}
          onError={(err) => console.error(`pane ${id} wterm error`, err)}
        />
      )}
    </div>
  );
}


export default memo(function AgentPane({
  id,
  name,
  cwd,
  kind, // "run" = project run-command pane; "chat" = headless Claude; undefined = agent pane
  sigintGuard = false, // swallow rapid repeat Ctrl+C (Claude panes only)
  visible = true,
  scrollback = 2000,
  hibernated = false,
  team, // saved team name when this agent was started as part of one
  teamTabs, // focus-layout team: [{id, role, status}] for every member sharing this cell
  onTeamTab,
  resource,
  resourceBusy,
  onResourceAction,
  codex = false,
  claude = false, // Claude harness — enables the Term ⇄ Chat view toggle
  view = "term", // "term" | "chat" (read-along transcript view)
  onViewChange,
  initialLines, // chat panes: replayed stream-json lines from reattach
  hidden = false, // run pane hidden while its process keeps running
  command, // run panes: the command line (shown where agents show cwd)
  onHide,
  onRestart,
  onResumeRequest, // chat "/resume" → the app's searchable session picker
  status,
  focused,
  agentColor,
  engine = "xterm",
  termTheme,
  wordMod = "ctrl",
  copyOnSelect = true,
  initialData,
  size,
  gridCols = 3,
  onResize,
  onReorder,
  onRegister,
  onActivity,
  onTitle,
  onClose,
}) {
  const sectionRef = useRef(null);
  const lastSigintRef = useRef(0);
  const callbacksRef = useRef({});
  callbacksRef.current = { onActivity, onRegister, onTitle };
  const [dragOver, setDragOver] = useState(false);
  const { dragging, onHeadPointerDown } = usePaneDrag(sectionRef, id, onReorder);

  const w = Math.min(size?.w ?? 1, gridCols);
  // Every pane occupies one equal-height workspace row, including saved layouts.
  const h = 1;

  // Horizontal resizing keeps every pane in a single equal-height row.
  const startResize = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const grip = ev.currentTarget;
    const grid = sectionRef.current.parentElement;
    const cellW = grid.clientWidth / gridCols;
    const x0 = ev.clientX;
    const w0 = w;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const onMove = (e) => {
      onResize(id, {
        w: clamp(w0 + Math.round((e.clientX - x0) / cellW), 1, gridCols),
        h: 1,
      });
    };
    const onUp = (e) => {
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
    };
    // Capture the pointer so every move reaches the grip, even over the
    // terminal canvas or outside the window.
    grip.setPointerCapture(ev.pointerId);
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
    document.body.style.cursor = "col-resize";
  };

  // 1× → half → full width, then back around.
  const cycleSize = () => {
    const steps = [
      ...new Set([1, Math.max(1, Math.round(gridCols / 2)), gridCols]),
    ];
    const next = steps[(steps.indexOf(w) + 1) % steps.length];
    onResize(id, { w: next, h });
  };

  const sendData = (data) => {
    if (sigintGuard && data === "\x03") {
      const now = Date.now();
      if (now - lastSigintRef.current < SIGINT_GUARD_MS) return;
      lastSigintRef.current = now;
    }
    // a blurred terminal's focus-out report must not re-focus this pane
    if (!isTerminalReport(data)) callbacksRef.current.onActivity(id);
    invoke("write_pane", { id, data }).catch(() => {});
  };

  const shellQuote = (p) =>
    /^[\w./-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`;

  // OS file drops come via Tauri's native drag-drop event — WKWebView never
  // exposes real file paths to HTML5 dnd (which is also why dropping on the
  // chat view can't be handled by its own onDrop). Every pane gets the event;
  // each hit-tests the cursor against its own rect (positions are physical
  // px, getBoundingClientRect is CSS px, so scale by devicePixelRatio).
  //
  // Term view: paths paste into the pty, terminal-style. Chat view: images
  // stage in the composer (read to a data URL so they preview and send
  // exactly like a paste); other files land as quoted paths in the input.
  useEffect(() => {
    const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
    const inside = ({ x, y }) => {
      const el = sectionRef.current;
      if (!el) return false;
      const s = window.devicePixelRatio || 1;
      const r = el.getBoundingClientRect();
      return x / s >= r.left && x / s < r.right && y / s >= r.top && y / s < r.bottom;
    };
    const sub = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") {
        setDragOver(inside(payload.position));
      } else if (payload.type === "drop") {
        setDragOver(false);
        if (inside(payload.position) && payload.paths.length) {
          const chat = chatVisibleRef.current ? chatHandleRef.current : null;
          if (chat) {
            const rest = payload.paths.filter((p) => !IMG_EXT.test(p));
            for (const p of payload.paths.filter((p) => IMG_EXT.test(p))) {
              invoke("read_image_data_url", { path: p })
                .then((url) =>
                  chat.addImage?.({
                    url,
                    name: p.split(/[\\/]/).filter(Boolean).pop(),
                  }),
                )
                // unreadable/oversized image: at least hand over the path
                .catch(() => chat.insertText?.(shellQuote(p) + " "));
            }
            if (rest.length) {
              chat.insertText?.(rest.map(shellQuote).join(" ") + " ");
            }
          } else {
            sendData(payload.paths.map(shellQuote).join(" ") + " ");
          }
        }
      } else {
        setDragOver(false); // leave / cancelled
      }
    });
    return () => sub.then((f) => f());
  }, []);

  // Terminal and chat view can be mounted at once (chat overlays a hidden
  // terminal); publish one handle that routes focus to whichever is visible,
  // so app-level focus never types into a hidden pty.
  const termHandleRef = useRef(null);
  const chatHandleRef = useRef(null);
  const chatVisibleRef = useRef(false);

  const publishHandle = () => {
    const any = termHandleRef.current || chatHandleRef.current;
    callbacksRef.current.onRegister(
      id,
      any && {
        focus: () =>
          chatVisibleRef.current && chatHandleRef.current
            ? chatHandleRef.current.focus()
            : (termHandleRef.current ?? chatHandleRef.current)?.focus(),
        write: (d) => termHandleRef.current?.write?.(d),
        scrollIntoView: () =>
          sectionRef.current?.scrollIntoView({
            block: "nearest",
            behavior: "smooth",
          }),
      },
    );
  };

  const register = (handle) => {
    termHandleRef.current = handle;
    publishHandle();
  };

  const registerChat = (handle) => {
    chatHandleRef.current = handle;
    publishHandle();
  };

  const handleTitle = (title) => {
    // strip Claude Code's busy-glyph prefix from the session name
    const clean = title.replace(/^[✳✶✻✽·∗*✢\s]+/u, "").trim();
    if (clean) callbacksRef.current.onTitle(id, clean);
  };

  // Modifier + ←/→/Backspace → readline word editing (ESC b / ESC f /
  // ESC DEL — what zsh/Claude already bind, same bytes as option+key).
  // Configurable because remapped keyboards (e.g. Karabiner) may emit ⌘
  // where the user expects Ctrl.
  const WORD_SEQS = {
    ArrowLeft: "\x1bb", // backward-word
    ArrowRight: "\x1bf", // forward-word
    Backspace: "\x1b\x7f", // backward-kill-word
  };
  const onWordJumpKey = (ev) => {
    const held =
      wordMod === "ctrl"
        ? ev.ctrlKey && !ev.metaKey && !ev.altKey
        : wordMod === "meta"
          ? ev.metaKey && !ev.ctrlKey && !ev.altKey
          : false;
    if (!held) return;
    const seq = WORD_SEQS[ev.key];
    if (!seq) return;
    ev.preventDefault();
    ev.stopPropagation();
    sendData(seq);
  };

  const isWterm = engine.startsWith("wterm");
  const Inner = isWterm ? WtermInner : XtermInner;
  const isRun = kind === "run";
  const isChat = kind === "chat"; // headless — no pty, no terminal view
  const showToggle = (claude || codex) && !isRun && !isChat && !hibernated;
  const chatVisible = hibernated || isChat || (showToggle && view === "chat");
  chatVisibleRef.current = chatVisible;
  useEffect(() => {
    if (!focused) return;
    const frame = requestAnimationFrame(() => {
      (chatVisible ? chatHandleRef.current : termHandleRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [chatVisible, focused]);
  // once opened, chat stays mounted (hidden) across toggles — unmounting
  // would drop its store, losing pending echoes and scroll position
  const chatOpenedRef = useRef(false);
  if (chatVisible) chatOpenedRef.current = true;

  // Read-along composer: same bracketed-paste-then-Enter path as plan
  // feedback, so the text lands in the pty exactly like a user paste.
  const sendChatToPty = (text) => {
    callbacksRef.current.onActivity(id);
    pasteAndSubmit(id, text);
  };

  // Headless composer: plain text — the broker wraps it into a stream-json
  // user message on the harness's stdin.
  const sendChatToStream = (text) => {
    callbacksRef.current.onActivity(id);
    invoke("write_pane", { id, data: text }).catch(() => {});
  };

  return (
    <section
      ref={sectionRef}
      className={`pane status-${status} ${isRun ? "pane-run" : ""} ${focused ? "focused" : ""} ${dragOver ? "drag-over" : ""} ${dragging ? "dragging" : ""}`}
      // hidden panes stay mounted (same trick as inactive projects) so the
      // terminal keeps consuming output and reveal is instant
      style={{
        gridColumn: `span ${w}`,
        gridRow: `span ${h}`,
        display: hidden ? "none" : undefined,
      }}
      data-pane-id={id}
      onMouseDown={() => onActivity(id)}
      onKeyDownCapture={onWordJumpKey}
      // Suppress the browser menu over the terminal (right-click there is
      // xterm's domain), but keep it in the chat view — it's real DOM text,
      // and right-click → Copy on a selection is the whole point of it.
      onContextMenu={(ev) => {
        if (!ev.target.closest?.(".chat-view")) ev.preventDefault();
      }}
    >
      <header className="pane-head" onPointerDown={onHeadPointerDown}>
        <span
          className={`dot ${status}`}
          style={
            AGENT_COLORS[agentColor]
              ? { background: AGENT_COLORS[agentColor] }
              : undefined
          }
          title={AGENT_COLORS[agentColor] ? `/color ${agentColor}` : undefined}
        />
        {teamTabs ? (
          <div className="pane-team-tabs" role="tablist">
            {teamTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === id}
                className={`pane-team-tab${t.id === id ? " active" : ""} status-${t.status}`}
                title={t.role}
                onClick={(e) => {
                  e.stopPropagation();
                  if (t.id !== id) onTeamTab?.(t.id);
                }}
              >
                {t.id !== id && <span className={`dot ${t.status}`} />}
                {t.role}
              </button>
            ))}
          </div>
        ) : (
          <span className="pane-title" title={name}>
            {isRun && <Play size={10} weight="fill" className="pane-run-glyph" />}
            {name}
          </span>
        )}
        {team && <span className="pane-team" title={`Team: ${team}`}>{team}</span>}
        <span className="pane-status">{hibernated ? "hibernated" : STATUS_LABEL[status]}</span>
        {resource && !hibernated && <span className="pane-resource" title={`${resource.processes} processes · resident RAM; CPU is whole-machine share`}>
          {formatBytes(resource.resident_bytes)} · {(resource.cpu_percent ?? 0).toFixed(1)}%
        </span>}
        {resource && <button className={`pane-size${resource.pinned ? " pinned" : ""}`} title={resource.pinned ? "Unpin agent" : "Pin agent — keep alive"}
          aria-label="Keep agent alive" aria-pressed={!!resource.pinned} disabled={!!resourceBusy}
          onClick={(e) => { e.stopPropagation(); onResourceAction?.("pin", !resource.pinned); }}><PushPin size={14}/></button>}
        {resource && !hibernated && <button className="pane-size" title={resource.reason || "Hibernate agent — save session and stop its processes"}
          aria-label="Hibernate agent" disabled={!resource.eligible || !!resourceBusy}
          onClick={(e) => { e.stopPropagation(); onResourceAction?.("hibernate"); }}><Moon size={14}/></button>}
        <span className="pane-cwd" title={command ?? cwd}>
          {command ?? cwd}
        </span>
        {showToggle && (
          <div className="pane-view-toggle">
            <button
              className={!chatVisible ? "on" : ""}
              title="Terminal view"
              onClick={(ev) => {
                ev.stopPropagation();
                onViewChange?.(id, "term");
              }}
            >
              Term
            </button>
            <button
              className={chatVisible ? "on" : ""}
              title="Chat view — rendered transcript, native select/copy"
              onClick={(ev) => {
                ev.stopPropagation();
                onViewChange?.(id, "chat");
              }}
            >
              Chat
            </button>
          </div>
        )}
        {onRestart && (
          <button
            className="pane-size"
            aria-label={isRun ? "Restart command" : "Restart agent"}
            title={!isRun ? "Restart agent — starts a fresh session" :
              status === "exited"
                ? "Restart command"
                : "Restart command — kills the process and relaunches it"
            }
            onClick={(ev) => {
              ev.stopPropagation();
              onRestart?.();
            }}
          >
            <ArrowClockwise size={14} weight="bold" />
          </button>
        )}
        {isRun && (
          <button
            className="pane-size"
            title="Hide pane — process keeps running (bring back from the Run menu)"
            onClick={(ev) => {
              ev.stopPropagation();
              onHide?.(id);
            }}
          >
            <Minus size={14} weight="bold" />
          </button>
        )}
        <button
          className="pane-size"
          title={`Cycle width: 1 → half → full (now ${w}×${h})`}
          onClick={(ev) => {
            ev.stopPropagation();
            cycleSize();
          }}
        >
          <ArrowsOutLineHorizontal size={14} weight="bold" />
        </button>
        <button
          className="pane-close"
          title={isRun ? "Kill process and close pane" : "Kill agent and close pane"}
          onClick={(ev) => {
            ev.stopPropagation();
            onClose(id);
          }}
        >
          <X size={13} weight="bold" />
        </button>
      </header>
      {hibernated ? (
        <>
          <div className="pane-sleep-banner"><span>{resource?.can_resume === false ? "Session saved · recovery needs attention" : "Session saved · agent hibernated"}</span>
            <button className="btn-sm" disabled={!!resourceBusy || resource?.can_resume === false} title={resource?.reason || undefined}
              onClick={() => onResourceAction?.("resume")}>{resourceBusy || "Resume agent"}</button></div>
          <ChatView key={`sleep-${id}`} id={id} cwd={cwd} mode="transcript" readOnly visible={visible}/>
        </>
      ) : isChat ? (
        <ChatView
          id={id}
          cwd={cwd}
          mode="stream"
          visible={visible}
          initialLines={initialLines}
          onSend={sendChatToStream}
          onStop={(resubmit) =>
            invoke("interrupt_pane", { id, resubmit: !!resubmit }).catch((err) =>
              console.error("interrupt failed", err),
            )
          }
          onResume={onResumeRequest}
          // the desktop always has save_pasted_image, so headless panes can
          // take pasted/dropped images too — Claude reads them by path
          allowImages
          status={status}
          register={registerChat}
          trackTasks
        />
      ) : (
        <>
          {/* terminal stays mounted under the chat view so scrollback and
              the pty keep flowing; toggling back is instant and lossless */}
          <div className={`pane-inner${chatVisible ? " chat-hidden" : ""}`}>
            <Inner
              key={engine}
              id={id}
              cwd={cwd}
              ghostty={engine === "wterm-ghostty"}
              visible={visible && !chatVisible}
              scrollback={scrollback}
              focused={focused}
              termTheme={termTheme}
              copyOnSelect={copyOnSelect}
              initialData={initialData}
              register={register}
              sendData={sendData}
              onTitle={handleTitle}
            />
          </div>
          {chatOpenedRef.current && (
            <div className={`pane-inner${chatVisible ? "" : " chat-hidden"}`}>
              <ChatView
                id={id}
                cwd={cwd}
                mode="transcript"
                agent={codex ? "Codex" : "Claude"}
                visible={visible && chatVisible}
                onSend={sendChatToPty}
                onStop={(resubmit) =>
            invoke("interrupt_pane", { id, resubmit: !!resubmit }).catch((err) =>
              console.error("interrupt failed", err),
            )
          }
                onNeedsTerm={() => onViewChange?.(id, "term")}
                onResume={codex ? undefined : onResumeRequest}
                status={status}
                register={registerChat}
                trackTasks
              />
            </div>
          )}
        </>
      )}
      <div
        className="pane-grip e"
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => onResize(id, { w: 1, h: 1 })}
      />
    </section>
  );
});
