// Fixed-window counter kept in memory (fine for the single backend instance).
export function createRateLimiter({ limit, windowMs, maxKeys = 10_000, now = Date.now }) {
  const windows = new Map(); // key -> { start, count }

  return function allow(key) {
    const t = now();
    let entry = windows.get(key);
    if (!entry || t - entry.start >= windowMs) {
      if (!entry && windows.size >= maxKeys) {
        // Keep memory bounded: drop the oldest key (Maps keep insertion order).
        windows.delete(windows.keys().next().value);
      }
      windows.delete(key);
      entry = { start: t, count: 0 };
      windows.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}
