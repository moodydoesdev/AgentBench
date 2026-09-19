// App-level background-work registry: the one place every pane's long-running
// work is visible together. Chat panes report their store's `activity` map
// (sub-agents from Task calls, background shells from run_in_background Bash —
// see chat/records.js trackToolStart), and the broker's `schedules` push
// contributes scheduled-prompt runs. The Background Tasks rail reads the
// merged list through useTasks().
//
// Frontend-only state by design: running entries rebuild from the live chat
// stores and the next `schedules` push after a reload; the finished list is
// ephemeral, like the notification bell.

import { useSyncExternalStore } from "react";
import { taskState } from "./taskState";

const chat = new Map(); // paneId -> { projectPath, items: Map(toolId -> row) }
let schedState = { schedules: [], runs: [] };
const runStatus = new Map(); // runId -> last seen status, to catch transitions
const finished = []; // newest first, capped
const FINISHED_CAP = 20;

const listeners = new Set();
let snapshot = null;
let tick = null;
let resources = new Map();
const dismissed = new Map();

function emit() {
  snapshot = null;
  for (const fn of listeners) fn();
}

function pushFinished(row) {
  finished.unshift({ ...row, endedAt: row.endedAt || Date.now() });
  if (finished.length > FINISHED_CAP) finished.length = FINISHED_CAP;
}

/** Called by ChatView on every store change; diffs cheaply and only emits
 *  when something actually started or finished. `activity` is the store's
 *  live Map — copied here, never retained. */
export function reportChatActivity(paneId, projectPath, activity) {
  let entry = chat.get(paneId);
  if (!entry) {
    entry = { projectPath, items: new Map() };
    chat.set(paneId, entry);
  }
  entry.projectPath = projectPath;
  let changed = false;

  for (const [toolId, act] of activity) {
    const prev = entry.items.get(toolId);
    if (!prev) {
      if (act.done) continue; // arrived already-finished (backfill) — not news
      entry.items.set(toolId, {
        key: `c:${paneId}:${toolId}`,
        kind: act.kind, // "agent" | "shell"
        label: act.label,
        detail: act.detail,
        msgKey: act.msgKey,
        toolId,
        bgId: act.bgId,
        paneId,
        projectPath,
        startedAt: act.startedAt || Date.now(),
        updatedAt: act.updatedAt || act.startedAt || Date.now(),
        output: act.output,
        done: false,
      });
      changed = true;
    } else {
      const updates = { bgId: act.bgId, label: act.label, detail: act.detail, output: act.output,
        updatedAt: act.updatedAt, failed: act.failed, endedAt: act.endedAt, done: act.done };
      const completed = !prev.done && act.done;
      if (Object.entries(updates).some(([key, value]) => prev[key] !== value)) {
        Object.assign(prev, updates);
        changed = true;
      }
      if (completed) pushFinished(prev);
    }
  }
  // entries gone from the store (session adoption reset it): retire quietly
  for (const [toolId, row] of entry.items) {
    if (!activity.has(toolId) && !row.done) {
      row.done = true;
      changed = true;
    }
  }
  if (changed) emit();
}

/** Pane closed — drop its running entries (its work died with the pty). */
export function removeChatPane(paneId) {
  if (chat.delete(paneId)) emit();
}

/** Full scheduler state from invoke("schedules") / the `schedules` event. */
export function setSchedules(state) {
  if (!state || !Array.isArray(state.runs)) return;
  // catch running → done/failed transitions for the finished list
  for (const run of state.runs) {
    const prev = runStatus.get(run.id);
    if (prev === "running" && run.status !== "running") {
      const sched = state.schedules?.find((s) => s.id === run.scheduleId);
      pushFinished({
        key: `s:${run.id}`,
        kind: "schedule",
        label: sched?.name ?? "scheduled run",
        detail: run.status === "failed" ? run.error || "failed" : undefined,
        failed: run.status === "failed",
        paneId: run.paneId,
        projectPath: sched?.cwd,
        run,
        schedule: sched,
      });
    }
    runStatus.set(run.id, run.status);
  }
  schedState = state;
  emit();
}

export function clearFinished() {
  if (!finished.length) return;
  finished.length = 0;
  emit();
}

export function setTaskResources(state) {
  if (!Array.isArray(state?.panes)) return;
  resources = new Map(state.panes.map((p) => [p.id, p]));
  emit();
}

export function clearUnconfirmed() {
  for (const row of getTasks().unconfirmed) dismissed.set(row.key, row.updatedAt || row.startedAt || 0);
  emit();
}

function buildSnapshot() {
  const running = [];
  for (const entry of chat.values()) {
    for (const row of entry.items.values()) {
      if (!row.done) running.push(row);
    }
  }
  for (const run of schedState.runs) {
    if (run.status !== "running") continue;
    const sched = schedState.schedules?.find((s) => s.id === run.scheduleId);
    running.push({
      key: `s:${run.id}`,
      kind: "schedule",
      label: sched?.name ?? "scheduled run",
      detail: sched?.prompt,
      paneId: run.paneId,
      projectPath: sched?.cwd,
      startedAt: run.startedAt || undefined, // broker stamps unix ms
      run,
      schedule: sched,
    });
  }
  running.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const recent = [], unconfirmed = [];
  for (const row of running) {
    const stamp = row.updatedAt || row.startedAt || 0;
    if (dismissed.has(row.key) && stamp <= dismissed.get(row.key)) continue;
    dismissed.delete(row.key);
    (taskState(row, Date.now(), resources.get(row.paneId)) === "unconfirmed" ? unconfirmed : recent).push(row);
  }
  return { running: recent, unconfirmed, finished: [...finished] };
}

function getTasks() {
  if (!snapshot) snapshot = buildSnapshot();
  return snapshot;
}

function subscribe(fn) {
  listeners.add(fn);
  if (tick === null) tick = setInterval(emit, 15000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size) { clearInterval(tick); tick = null; }
  };
}

export function useTasks() {
  return useSyncExternalStore(subscribe, getTasks);
}
