// Bytes a terminal emulator sends on its own, not because the user typed:
// focus in/out reports (DECSET 1004 — Claude Code turns these on), OSC
// replies (color queries), cursor position reports and device attributes.
// Mirrors the broker's filter in resources::input. Counting these as user
// activity made a background terminal's blur report ("\x1b[O") refocus its
// own pane, stealing focus from whatever was just clicked.
export function isTerminalReport(data) {
  return (
    data === "" ||
    data === "\x1b[I" ||
    data === "\x1b[O" ||
    data.startsWith("\x1b]") ||
    /^\x1b\[\d+;\d+R$/.test(data) ||
    /^\x1b\[[?>][\d;]*c$/.test(data)
  );
}
