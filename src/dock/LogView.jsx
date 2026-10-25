import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@/lib/ipc";
import { FALLBACK_STACK, FONT_STACK } from "../AgentPane";

// How often a live output file is re-read while its tab is on screen.
const POLL_MS = 600;

/**
 * Read-only terminal for command output in the dock: either following a
 * Claude Code background task's live output file (`path`), or showing a
 * finished command's output (`text`). A real xterm, so colours, progress
 * bars and scrollback behave the way they did when the command ran.
 */
export default function LogView({ path, text, visible, termTheme }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const [state, setState] = useState(path ? "following" : null);

  useEffect(() => {
    const term = new Xterm({
      fontSize: 13,
      fontFamily: document.fonts.check('13px "FiraCode Nerd Font Mono"') ? FONT_STACK : FALLBACK_STACK,
      theme: termTheme,
      allowTransparency: true,
      disableStdin: true,
      cursorInactiveStyle: "none",
      cursorStyle: "bar",
      // Output files hold bare \n; a terminal needs \r\n to return the cursor.
      convertEol: true,
      scrollback: 20000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    if (text != null) term.write(text);
    const ro = new ResizeObserver(() => {
      const el = hostRef.current;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* mid-layout */
      }
    });
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // the terminal is built once; text/path never change for a tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = termTheme;
  }, [termTheme]);

  // Follow the file while the tab is showing; offset survives hide/show.
  const offsetRef = useRef(0);
  const quietRef = useRef(0);
  useEffect(() => {
    if (!path || !visible) return;
    let dead = false;
    let timer = null;
    const poll = async () => {
      try {
        const r = await invoke("tail_output", { path, offset: offsetRef.current });
        if (dead) return;
        if (r.restarted) termRef.current?.reset();
        if (r.data) {
          termRef.current?.write(r.data);
          quietRef.current = 0;
          setState("following");
        } else if (++quietRef.current * POLL_MS > 10_000) {
          setState("quiet");
        }
        offsetRef.current = r.offset;
      } catch (err) {
        if (!dead) setState(`unreadable: ${err}`);
      }
      if (!dead) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [path, visible]);

  return (
    <div className="log-view">
      <div className="log-view-term" ref={hostRef} />
      {state && (
        <div className={`log-view-state ${state.startsWith("unreadable") ? "error" : state}`}>
          {state === "following"
            ? "following live output"
            : state === "quiet"
              ? "no new output for a while — the task may have finished"
              : state}
        </div>
      )}
    </div>
  );
}
