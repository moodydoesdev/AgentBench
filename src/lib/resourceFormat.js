export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}
export function formatIdle(seconds) {
  if (!seconds) return 'Not idle';
  return seconds < 60 ? 'Idle <1m' : seconds < 3600 ? `Idle ${Math.floor(seconds / 60)}m`
    : `Idle ${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
