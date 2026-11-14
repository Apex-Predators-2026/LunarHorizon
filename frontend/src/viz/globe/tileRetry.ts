// Retrying terrain tiles. A tile request that fails or takes too long is retried 1 s, 2 s, 4 s ...
// (at most 30 s) later, so one Moon Trek hiccup or a backend restart can't leave an area blurry
// for the rest of the session, and slow first downloads can't hold every connection (the backend
// keeps going and caches the data, so the retry is fast).

export const TILE_TIMEOUT_MS = 30_000
export const MAX_TILE_ATTEMPTS = 8

/** Wait before the next attempt after `failures` failed attempts. */
export const retryDelayMs = (failures: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1))
