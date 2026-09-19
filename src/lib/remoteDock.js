// Dock shells that live on linked benches.
//
// The local dock stores membership as a list of pane ids and reconciles it
// against the broker's live panes on reattach. Remote docks need the same
// thing per bench, with one extra hazard: a disconnected bench reports an
// empty pane list, and treating that as "every tab is gone" would wipe the
// user's terminals every time a laptop lid closed.

/// Dock scope key for a bench's project. Two benches can have the same cwd,
/// and pane ids come from different brokers, so the url has to be in the key.
export function remoteScope(url, cwd) {
  return `${url}::${cwd}`;
}

/**
 * Drop dock entries whose pane no longer exists on the bench.
 *
 * Only benches that are currently connected are pruned — for anything else
 * the pane list is stale rather than authoritative. Returns the original
 * object when nothing changed, so it can be used directly in a setState
 * updater without causing a render loop.
 *
 * @param current {Record<string, Array<{id:number}>>} url -> dock panes
 * @param machines {Array<{url:string, connected?:boolean, panes?:Array<{id:number}>}>}
 */
export function reconcileRemoteDock(current, machines) {
  let changed = false;
  const next = {};
  for (const [url, list] of Object.entries(current ?? {})) {
    const machine = (machines ?? []).find((m) => m.url === url);
    if (!machine?.connected) {
      next[url] = list;
      continue;
    }
    const live = new Set((machine.panes ?? []).map((p) => p.id));
    const kept = list.filter((p) => live.has(p.id));
    if (kept.length !== list.length) changed = true;
    next[url] = kept;
  }
  return changed ? next : current;
}
