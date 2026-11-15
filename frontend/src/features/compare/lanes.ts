// Unknown-aware state of the comparison's Sun and Earth lanes (SyncTimeline).
// Unknown time (terrain or ephemeris data missing; or hours past the end of the real data) is its own state:
// it is never drawn as darkness or a blackout, and never counted as either. The lanes start as "no data" and
// only time the engine knows is painted over it.
import type { CompareResult, TimelineColumns, Window } from './types'

export type Lane = 'sun' | 'earth'

/** A stretch of mission time, in hours after the evaluated landing. */
export interface HourSpan {
  start_hour: number
  end_hour: number
}

const UNKNOWN_KIND: Record<Lane, string> = { sun: 'sun_unknown', earth: 'earth_unknown' }

/** The engine's unknown windows for one lane (sun_unknown / earth_unknown). */
export function unknownWindows(r: CompareResult, lane: Lane): Window[] {
  return (r.unknown_windows ?? []).filter((w) => w.kind === UNKNOWN_KIND[lane])
}

/** Index runs [a, b) where pred(i) holds. */
function indexRuns(n: number, pred: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = []
  let start = -1
  for (let i = 0; i <= n; i++) {
    const on = i < n && pred(i)
    if (on && start < 0) start = i
    if (!on && start >= 0) {
      out.push([start, i])
      start = -1
    }
  }
  return out
}

const sunKnownAt = (tl: TimelineColumns, i: number) => tl.sun_visible_fraction[i] !== null && tl.sun_visible_fraction[i] !== undefined
const earthKnownAt = (tl: TimelineColumns, i: number) => tl.earth_visible[i] !== null && tl.earth_visible[i] !== undefined

/** Runs of samples whose Sun state is known (index ranges into the timeline columns). */
export function knownSunRuns(tl: TimelineColumns): [number, number][] {
  return indexRuns(tl.hour.length, (i) => sunKnownAt(tl, i))
}

/**
 * Where a lane's state is known. From the engine's own windows when it reported any (sunlight + darkness,
 * Earth visible + blackout), otherwise from the timeline samples (each covering half a step either side).
 */
export function knownSpans(r: CompareResult, lane: Lane): HourSpan[] {
  const windows = lane === 'sun' ? [...r.sun_windows, ...r.dark_windows] : [...r.earth_windows, ...r.blackout_windows]
  if (windows.length || unknownWindows(r, lane).length) return windows
  const tl = r.timeline
  if (!tl) return []
  const half = tl.step_hours / 2
  const known = lane === 'sun' ? (i: number) => sunKnownAt(tl, i) : (i: number) => earthKnownAt(tl, i)
  return indexRuns(tl.hour.length, known).map(([a, b]) => ({ start_hour: tl.hour[a] - half, end_hour: tl.hour[b - 1] + half }))
}

/** Known Earth visibility from the timeline (when the engine reported no windows): visible / blocked runs. */
export function timelineEarthRuns(tl: TimelineColumns, visible: boolean): HourSpan[] {
  const half = tl.step_hours / 2
  return indexRuns(tl.hour.length, (i) => tl.earth_visible[i] === visible).map(([a, b]) => ({
    start_hour: tl.hour[a] - half,
    end_hour: tl.hour[b - 1] + half,
  }))
}

export interface LaneCoverage {
  knownHours: number | null // null: not reported (e.g. never assessed)
  totalHours: number
  complete: boolean
}

/** Hours of the mission with a known state for this lane, as the backend reports them. */
export function laneCoverage(r: CompareResult, lane: Lane, durationDays: number): LaneCoverage {
  const total = (r.evaluated_duration_days ?? durationDays) * 24
  const known = lane === 'sun' ? r.sun_known_hours : r.earth_known_hours
  const k = known === undefined ? null : known
  return { knownHours: k, totalHours: total, complete: k !== null && k >= total - 1e-6 }
}

const WITHHELD_LABEL: Record<string, string> = { solar: 'Solar statistics', power: 'Power statistics', earth: 'Earth statistics' }

/** The backend's reasons for withheld statistics, one line per distinct reason (solar and power often share one). */
export function withheldNotes(r: CompareResult): { blocks: string; reason: string }[] {
  const byReason = new Map<string, string[]>()
  for (const [block, reason] of Object.entries(r.withheld ?? {})) {
    const list = byReason.get(reason) ?? []
    list.push(WITHHELD_LABEL[block] ?? block)
    byReason.set(reason, list)
  }
  return [...byReason].map(([reason, blocks]) => ({ blocks: blocks.join(' and '), reason }))
}
