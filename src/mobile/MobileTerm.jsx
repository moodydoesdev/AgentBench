import { useMemo, useRef } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowElbowDownLeft,
  ClipboardText,
} from "@phosphor-icons/react";
import { XtermInner } from "../AgentPane";
import { getTheme, terminalThemeFromVars } from "../themes";
import { loadThemeId } from "./theme";

/**
 * The pane's real terminal on a phone: the same xterm the desktop and browser
 * bench use, driving the pty over the gateway socket — plus a key bar for
 * what a phone keyboard lacks (Esc, Tab, arrows, Ctrl-C), which is exactly
 * what Claude's menus, permission prompts and pickers need.
 *
 * While this tab is on screen the pty takes the phone's width (Claude reflows
 * cleanly); the desktop takes its size back the moment its pane is touched.
 * Lazy-loaded: xterm is heavy and most visits never open a terminal.
 */

const KEYS = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "⇧Tab", data: "\x1b[Z", title: "Shift-Tab (Claude: cycle mode)" },
  { icon: ArrowUp, data: "\x1b[A", title: "Up" },
  { icon: ArrowDown, data: "\x1b[B", title: "Down" },
  { icon: ArrowLeft, data: "\x1b[D", title: "Left" },
  { icon: ArrowRight, data: "\x1b[C", title: "Right" },
  { label: "^C", data: "\x03", title: "Ctrl-C" },
  { icon: ArrowElbowDownLeft, data: "\r", title: "Enter" },
];

export default function MobileTerm({ transport, pane, visible }) {
  const handle = useRef(null);
  const termTheme = useMemo(() => terminalThemeFromVars(getTheme(loadThemeId()).vars), []);
  const send = (data) => transport.invoke("write_pane", { id: pane.paneId, data }).catch(() => {});
  const paste = () =>
    navigator.clipboard
      ?.readText()
      .then((t) => t && send(`\x1b[200~${t}\x1b[201~`))
      .catch(() => {});
  return (
    <div className="mob-term">
      <div className="mob-term-screen">
        <XtermInner
          id={pane.paneId}
          cwd={pane.cwd}
          transport={transport}
          visible={visible}
          termTheme={termTheme}
          copyOnSelect={false}
          register={(h) => (handle.current = h)}
          sendData={send}
          onTitle={() => {}}
        />
      </div>
      <div className="mob-term-keys" role="toolbar" aria-label="Terminal keys">
        {KEYS.map((k) => (
          <button
            key={k.title ?? k.label}
            className="mob-term-key"
            title={k.title ?? k.label}
            aria-label={k.title ?? k.label}
            // pointerdown + preventDefault: the key lands without stealing
            // focus, so the on-screen keyboard stays up
            onPointerDown={(ev) => {
              ev.preventDefault();
              send(k.data);
              navigator.vibrate?.(8);
            }}
          >
            {k.icon ? <k.icon size={16} weight="bold" /> : k.label}
          </button>
        ))}
        <button
          className="mob-term-key"
          title="Paste"
          aria-label="Paste"
          onPointerDown={(ev) => {
            ev.preventDefault();
            paste();
          }}
        >
          <ClipboardText size={16} />
        </button>
      </div>
    </div>
  );
}
