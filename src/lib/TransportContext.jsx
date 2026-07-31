import { createContext, useContext } from "react";
import { tauriTransport } from "./transport";

/**
 * Which backend the chat components talk to. Unset means the desktop app, so
 * every existing caller keeps working untouched; the mobile shell wraps each
 * pane in the transport for the machine that owns it.
 */
const TransportContext = createContext(null);

let desktop = null;
function desktopTransport() {
  if (!desktop) desktop = tauriTransport();
  return desktop;
}

export function TransportProvider({ transport, children }) {
  return (
    <TransportContext.Provider value={transport}>
      {children}
    </TransportContext.Provider>
  );
}

export function useTransport() {
  return useContext(TransportContext) ?? desktopTransport();
}
