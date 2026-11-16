/** Wait before retry n (0-based) of the site list while the backend is unreachable: 2, 4, 8, 16 s, then every 30 s. */
export function sitesRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt))
}
