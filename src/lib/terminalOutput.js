// Hidden panes still parse every byte, but do not schedule work for every
// PTY chunk. Flush early at 64 KiB; never drop bytes or break VT state.
export function createOutputBatcher(write, isVisible, timers = globalThis) {
  let chunks = [], bytes = 0, timer = null, disposed = false;
  const flush = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (!bytes || disposed) return;
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    chunks = []; bytes = 0;
    write(combined);
  };
  return {
    push(chunk) {
      if (disposed) return;
      chunks.push(chunk); bytes += chunk.length;
      if (isVisible() || bytes >= 65536) flush();
      else if (timer === null) timer = timers.setTimeout(flush, 1000);
    },
    flush,
    dispose() { disposed = true; if (timer !== null) timers.clearTimeout(timer); chunks = []; bytes = 0; },
  };
}
