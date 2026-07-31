/**
 * The mobile shell's model of "which machines am I connected to".
 *
 * Every AgentBench workstation runs its own gateway and issues its own device
 * token, so a phone holds a list of them and one live socket each. Machines
 * are independent on purpose: revoking this phone on one must not touch
 * another, and one being offline must not stop the others rendering.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { wsTransport } from "../lib/transport";

const STORE_KEY = "agentbench.gateways";

/** Protocol version this shell was built against; see the gateway's hello. */
export const CLIENT_PROTOCOL = 1;

export function loadGateways() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((g) => g?.url && g?.token) : [];
  } catch {
    return [];
  }
}

export function saveGateways(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
}

/**
 * Opens one connection per enabled gateway and keeps a merged view of the
 * fleet. Each entry exposes its own transport, so a pane's chat is always
 * driven by the machine that actually owns it.
 */
export function useFleet(gateways) {
  const [conns, setConns] = useState({}); // url -> connection state
  const transports = useRef(new Map());

  useEffect(() => {
    const live = transports.current;
    const wanted = new Map(
      gateways.filter((g) => g.enabled !== false).map((g) => [g.url, g]),
    );

    // drop connections for machines that were removed or disabled
    for (const [url, t] of live) {
      if (!wanted.has(url)) {
        t.close();
        live.delete(url);
        setConns((c) => {
          const next = { ...c };
          delete next[url];
          return next;
        });
      }
    }

    for (const [url, g] of wanted) {
      if (live.has(url)) continue;
      const patch = (fields) =>
        setConns((c) => ({ ...c, [url]: { ...(c[url] ?? {}), url, name: g.name, ...fields } }));
      patch({ connected: false, panes: [], statuses: {}, asks: [], projects: [] });
      const t = wsTransport({
        url,
        token: g.token,
        onStatus: (s) => {
          const hello = s.hello;
          patch({
            connected: s.connected,
            error: s.error,
            ...(hello
              ? {
                  machine: hello.machine,
                  protocolVersion: hello.protocolVersion,
                  brokerConnected: hello.brokerConnected,
                  panes: hello.panes ?? [],
                  statuses: hello.statuses ?? {},
                  asks: hello.asks ?? [],
                  projects: hello.projects ?? [],
                }
              : {}),
          });
        },
      });
      live.set(url, t);

      // Live status: fold events into the same shape the hello snapshot gave
      // us, so a screen never has to care whether a fact arrived in the
      // snapshot or the stream.
      t.listen("agent-event", ({ payload }) =>
        patch2(setConns, url, (c) => ({
          statuses: {
            ...c.statuses,
            [payload.id]: payload.kind === "done" ? "done" : "input",
          },
        })),
      );
      t.listen("pane-exit", ({ payload }) =>
        patch2(setConns, url, (c) => ({
          statuses: { ...c.statuses, [payload.id]: "exited" },
          asks: (c.asks ?? []).filter((a) => a.id !== payload.id),
          panes: (c.panes ?? []).filter((p) => p.id !== payload.id),
        })),
      );
      t.listen("ask", ({ payload }) =>
        patch2(setConns, url, (c) => ({
          statuses: { ...c.statuses, [payload.id]: "input" },
          asks: [...(c.asks ?? []).filter((a) => a.id !== payload.id), payload],
        })),
      );
      t.listen("turn", ({ payload }) =>
        patch2(setConns, url, (c) =>
          payload.active
            ? {
                statuses: { ...c.statuses, [payload.id]: "working" },
                asks: (c.asks ?? []).filter((a) => a.id !== payload.id),
              }
            : {},
        ),
      );
      // A pane that appears while we are connected (spawned on the desktop)
      // should show up without waiting for a reconnect.
      t.listen("hello", () => {});
    }

    return () => {};
  }, [gateways]);

  // tear everything down when the shell unmounts
  useEffect(() => {
    const live = transports.current;
    return () => {
      for (const [, t] of live) t.close();
      live.clear();
    };
  }, []);

  const machines = useMemo(
    () =>
      gateways
        .filter((g) => g.enabled !== false)
        .map((g) => ({
          ...g,
          ...(conns[g.url] ?? { connected: false, panes: [], statuses: {}, asks: [] }),
          transport: transports.current.get(g.url) ?? null,
        })),
    [gateways, conns],
  );

  const refresh = () => {
    for (const [, t] of transports.current) t.reconnectNow?.();
  };

  return { machines, refresh };
}

function patch2(setConns, url, fn) {
  setConns((c) => {
    const cur = c[url] ?? {};
    return { ...c, [url]: { ...cur, ...fn(cur) } };
  });
}

/** Rollup for a project row: needs-input outranks done outranks working. */
export function rollupStatus(statuses) {
  if (statuses.includes("input")) return "input";
  if (statuses.includes("working")) return "working";
  if (statuses.includes("done")) return "done";
  return statuses[0] ?? "exited";
}

/**
 * Group a machine's panes by project, newest project first.
 *
 * Registered projects with nothing running are included: they are exactly the
 * ones you want to start an agent in, and leaving them out meant a project
 * became invisible from the phone the moment its last agent exited.
 */
export function groupPanes(machine) {
  const byCwd = new Map();
  for (const pane of machine.panes ?? []) {
    const list = byCwd.get(pane.cwd) ?? [];
    list.push({ ...pane, status: machine.statuses?.[pane.id] ?? "working" });
    byCwd.set(pane.cwd, list);
  }
  const named = new Map(
    (machine.projects ?? []).map((p) => [p.path, p.name || baseName(p.path)]),
  );
  for (const project of machine.projects ?? []) {
    if (!byCwd.has(project.path)) byCwd.set(project.path, []);
  }
  return [...byCwd.entries()]
    .map(([cwd, panes]) => ({
      cwd,
      name: named.get(cwd) ?? baseName(cwd),
      panes,
      status: panes.length ? rollupStatus(panes.map((p) => p.status)) : "idle",
    }))
    .sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name));
}

const rank = (s) => ({ input: 0, working: 1, done: 2, exited: 3, idle: 4 })[s] ?? 5;

export function baseName(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() ?? p;
}
