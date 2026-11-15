// Retrying terrain tiles. A tile request that fails or takes too long is retried 1 s, 2 s, 4 s ...
// (at most 30 s) later, and never given up for good: one Moon Trek hiccup or a backend restart can't
// leave an area blurry for the rest of the session (a failed tile keeps its parent drawn). Slow first
// downloads can't hold every connection either (the backend keeps going and caches the data, so the
// retry is fast). When the backend answers again after an outage, or the browser comes back online,
// waiting tiles are retried at once (TileTree).

export const TILE_TIMEOUT_MS = 30_000
/** A download for a tile the view hasn't wanted for this long is cancelled (not a failure). */
export const STALE_REQUEST_MS = 1500

/** Wait before the next attempt after `failures` failed attempts. */
export const retryDelayMs = (failures: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1))
