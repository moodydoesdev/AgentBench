// A missing completion record is not evidence of a live process.
export function taskState(row, now = Date.now(), owner) {
  if (row.done) return 'finished';
  if (owner?.hibernated || owner?.processes === 0) return 'unconfirmed';
  if (row.kind === 'schedule') return 'recent';
  const updated = row.updatedAt || row.startedAt;
  return Number.isFinite(updated) && now - updated <= 120000 ? 'recent' : 'unconfirmed';
}
