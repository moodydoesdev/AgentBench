// Workspace grid sizing.
//
// autoCols: column count from the actual grid width (so webview zoom and the
// plans/sidebar panels are naturally accounted for) — a pane needs ~560px to
// show a readable chat column. Given the visible pane count, panes are spread
// evenly over the rows they need instead of filling each row first, so four
// panes on a three-wide screen make a 2×2 grid rather than three narrow panes
// over one full-width one.
//
// packSpans: render-time span adjustment so every row sums to exactly the
// column count — a trailing pane stretches over the leftover cells instead of
// leaving a dead gap. The user's chosen sizes (paneSizes) are never mutated;
// this only widens what's drawn.
export function autoCols(width, count) {
  const max = Math.max(1, Math.min(4, Math.floor(width / 560)));
  if (!count) return max;
  const rows = Math.ceil(count / max);
  return Math.ceil(count / rows);
}

export function packSpans(panes, sizes, cols) {
  const out = {};
  let row = [];
  let used = 0;
  const flush = () => {
    if (!row.length) return;
    let extra = cols - used;
    // hand leftover cells out from the end of the row so the earlier panes
    // keep the width the user gave them
    for (let i = row.length - 1; extra > 0; i = (i - 1 + row.length) % row.length) {
      row[i].w += 1;
      extra -= 1;
    }
    for (const r of row) out[r.id] = r.w;
    row = [];
    used = 0;
  };
  for (const p of panes) {
    const w = Math.min(Math.max(sizes[p.id]?.w ?? 1, 1), cols);
    if (used + w > cols) flush();
    row.push({ id: p.id, w });
    used += w;
    if (used === cols) flush();
  }
  flush();
  return out;
}

// Applying an explicit row count resets old horizontal spans. Keep vertical
// sizing so changing the number of columns does not discard pane heights.
export function resetPaneWidths(sizes) {
  return Object.fromEntries(Object.entries(sizes).map(([id, size]) =>
    [id, { ...size, w: 1 }],
  ));
}
