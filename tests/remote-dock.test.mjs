import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileRemoteDock, remoteScope } from "../src/lib/remoteDock.js";

const vm = "http://vm:8473";
const other = "http://other:8473";

test("scope keys separate benches that share a cwd", () => {
  assert.notEqual(remoteScope(vm, "/srv/app"), remoteScope(other, "/srv/app"));
});

test("drops tabs whose pane died on a connected bench", () => {
  const cur = { [vm]: [{ id: 1 }, { id: 2 }] };
  const next = reconcileRemoteDock(cur, [
    { url: vm, connected: true, panes: [{ id: 2 }] },
  ]);
  assert.deepEqual(next[vm], [{ id: 2 }]);
});

test("keeps every tab while a bench is disconnected", () => {
  // The pane list of a dropped bench is stale, not empty. Pruning here would
  // wipe the user's terminals on every network blip.
  const cur = { [vm]: [{ id: 1 }, { id: 2 }] };
  const next = reconcileRemoteDock(cur, [
    { url: vm, connected: false, panes: [] },
  ]);
  assert.deepEqual(next[vm], [{ id: 1 }, { id: 2 }]);
});

test("keeps tabs for a bench that is not in the fleet at all", () => {
  const cur = { [vm]: [{ id: 1 }] };
  assert.deepEqual(reconcileRemoteDock(cur, [])[vm], [{ id: 1 }]);
});

test("returns the same object when nothing changed", () => {
  // Identity matters: this feeds a setState updater, and a fresh object every
  // time would re-render on every fleet tick.
  const cur = { [vm]: [{ id: 1 }] };
  const machines = [{ url: vm, connected: true, panes: [{ id: 1 }] }];
  assert.equal(reconcileRemoteDock(cur, machines), cur);
});

test("prunes one bench without touching another", () => {
  const cur = { [vm]: [{ id: 1 }, { id: 2 }], [other]: [{ id: 1 }] };
  const next = reconcileRemoteDock(cur, [
    { url: vm, connected: true, panes: [{ id: 1 }] },
    { url: other, connected: false, panes: [] },
  ]);
  assert.deepEqual(next[vm], [{ id: 1 }]);
  assert.deepEqual(next[other], [{ id: 1 }]);
});

test("survives a bench with no pane list", () => {
  const cur = { [vm]: [{ id: 1 }] };
  const next = reconcileRemoteDock(cur, [{ url: vm, connected: true }]);
  assert.deepEqual(next[vm], []);
});
