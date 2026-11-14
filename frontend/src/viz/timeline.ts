// Pure helpers for time playback, the time strip and the polar sky plot.

export const HOUR_MS = 3_600_000

// ---- unknown-aware value helpers (null = terrain data missing in that direction) ----

/** Is any of the solar disk above the terrain? Uses the authoritative `visible` flag when present
 *  (the fraction can round to 0 for a thin sliver). Unknown counts as not visible. */
export const sunUp = (s: { visible?: boolean | null; visible_fraction: number | null }) =>
  s.visible ?? (s.visible_fraction !== null && s.visible_fraction > 0)

/** "73%", "<1%" for a visible sliver, or "unknown". */
export function fmtPct(fraction: number | null, visible?: boolean | null): string {
  if (fraction === null) return 'unknown'
  const p = Math.round(fraction * 100)
  return p === 0 && visible ? '<1%' : `${p}%`
}

/** "1.23°", "+1.23°" (signed), or "unknown". */
export const fmtDeg = (v: number | null, digits = 2, signed = false) =>
  v === null ? 'unknown' : `${signed && v >= 0 ? '+' : ''}${v.toFixed(digits)}°`

/** "2027-01-01T00:00Z" (or any ISO string) -> epoch ms. */
export const parseUtc = (iso: string) => Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)

/** epoch ms -> "2027-01-01T00:00Z" (minute precision, the backend's format). */
export const toIsoMinute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`

/** Round to the nearest whole hour (the data is hourly). */
export const roundHour = (ms: number) => Math.round(ms / HOUR_MS) * HOUR_MS

/**
 * The fixed-size window containing `t`. Windows are aligned to the start of the data, so playback
 * only refetches when it crosses into the next window.
 */
export function windowFor(t: number, dataStart: number, dataStop: number, days: number): [number, number] {
  const len = days * 24 * HOUR_MS
  const k = Math.max(0, Math.floor((Math.min(t, dataStop) - dataStart) / len))
  const a = dataStart + k * len
  return [a, Math.min(a + len, dataStop)]
}

/** Index of the sample nearest to t in an ascending array (binary search). -1 if empty. */
export function nearestIndex(times: number[], t: number): number {
  if (!times.length) return -1
  let lo = 0
  let hi = times.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t) ? lo - 1 : lo
}

/** Contiguous runs where flags[i] === value, as [start, end) index pairs. */
export function runs(flags: boolean[], value = true): [number, number][] {
  const out: [number, number][] = []
  let start = -1
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i] === value
    if (on && start < 0) start = i
    if (!on && start >= 0) {
      out.push([start, i])
      start = -1
    }
  }
  return out
}

/** Longest run where flags[i] === value, or null if there is none. */
export function longestRun(flags: boolean[], value = true): [number, number] | null {
  return runs(flags, value).reduce<[number, number] | null>((best, r) => (!best || r[1] - r[0] > best[1] - best[0] ? r : best), null)
}

/**
 * Elevation range for the sky plot [centre, rim], fitted to the site. Polar Sun and Earth stay
 * within a few degrees of the horizon, so a zenith-centred plot would squash everything onto the
 * rim. Anything below the rim is drawn on it.
 */
export function skyRange(
  horizonElevations: (number | null)[] | null | undefined,
  steps: { sun: { elevation_deg: number }; earth: { elevation_deg: number } }[],
): [number, number] {
  let hi = 0
  let lo = 0
  for (const e of horizonElevations ?? []) {
    if (e === null) continue // unknown direction
    hi = Math.max(hi, e)
    lo = Math.min(lo, e)
  }
  for (const s of steps) hi = Math.max(hi, s.sun.elevation_deg, s.earth.elevation_deg)
  return [Math.ceil(hi + 2), Math.max(-10, Math.floor(lo - 1.5))]
}

/**
 * Polar sky plot projection: azimuth clockwise from north (north up, east right), elevation mapped
 * linearly from `topEl` at the centre to `bottomEl` at the rim (radius R). Clamped to the rim.
 */
export function skyXY(azDeg: number, elDeg: number, R: number, topEl: number, bottomEl: number): [number, number] {
  const r = R * Math.min(1, Math.max(0, (topEl - elDeg) / (topEl - bottomEl)))
  const a = (azDeg * Math.PI) / 180
  return [r * Math.sin(a), -r * Math.cos(a)]
}
