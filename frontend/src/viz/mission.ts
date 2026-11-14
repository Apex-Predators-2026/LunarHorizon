// Mission playback: what happens hour by hour after landing, from the site's hourly timeline and a
// plan (Scenario: site, landing time, duration, requirements). Pure functions, unit-tested.
//
// These numbers drive the playback display (streak counters, the moment a requirement breaks).
// The viability engine (backend/app/viability) stays authoritative for pass / fail; when a rescue
// result exists, the panel shows its verdict next to these.
import type { MissionRequirements, Scenario, TimelineStep } from '../types'
import { HOUR_MS, parseUtc } from './timeline'

export interface MissionHour {
  t: number // epoch ms
  dark: boolean | null // panels dark: visible solar disk below the plan's panel threshold; null = unknown
  blackout: boolean | null // no direct-to-Earth line of sight; null = unknown
  sunFraction: number | null
}

export interface Span {
  start: number // epoch ms of the first hour
  hours: number
}

export type MomentConstraint = 'battery_hours' | 'max_comms_gap_hours' | 'min_initial_sun_hours' | 'min_initial_comms_hours'
export type AverageConstraint = 'min_sunlight_fraction' | 'min_earth_visibility_fraction'

export interface MissionFailure {
  t: number // when it happens (epoch ms); whole-mission averages are reported at the end
  constraint: MomentConstraint | AverageConstraint
  message: string
}

export interface MissionTrack {
  start: number // landing (epoch ms)
  end: number // landing + duration
  hours: MissionHour[] // hourly, inside [start, end]
  darkStreak: number[] // per hour: consecutive dark hours up to and including it
  gapStreak: number[] // per hour: consecutive hours without Earth contact
  longestDark: Span | null
  longestBlackout: Span | null
  initialSunHours: number // continuous panel power from landing
  initialCommsHours: number // continuous Earth contact from landing
  sunlightFraction: number | null // mean visible solar disk over the known hours
  earthFraction: number | null // share of known hours with Earth in view
  unknownHours: number // hours where the data can't say (custom sites only)
  failures: MissionFailure[] // in time order; each requirement at most once
}

/** [landing, landing + duration] in epoch ms. */
export function missionWindow(s: Pick<Scenario, 'landing_utc' | 'duration_days'>): [number, number] {
  const start = parseUtc(s.landing_utc)
  return [start, start + s.duration_days * 24 * HOUR_MS]
}

/** Hours as "51 h" (below 100 h, so 51 vs 50 stays visible) or "4.2 days". */
export const fmtHours = (h: number) => (h < 100 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} days`)
const fmtH = fmtHours
const pct = (x: number) => `${Math.round(x * 100)}%`

/** Hour-by-hour mission track for a plan. `steps` = the site's hourly timeline covering the mission. */
export function missionTrack(steps: TimelineStep[], plan: Pick<Scenario, 'landing_utc' | 'duration_days' | 'requirements'>): MissionTrack {
  const [start, end] = missionWindow(plan)
  const req: MissionRequirements = plan.requirements
  const hours: MissionHour[] = steps
    .map((s) => {
      const f = s.sun.visible_fraction
      return {
        t: parseUtc(s.time_utc),
        dark: f === null ? null : f < req.panel_threshold,
        blackout: s.earth.visible === null ? null : !s.earth.visible,
        sunFraction: f,
      }
    })
    .filter((h) => h.t >= start && h.t <= end)
    .sort((a, b) => a.t - b.t)

  // Streaks: unknown hours end a streak without counting (never a pass or a fail).
  const streak = (bad: (h: MissionHour) => boolean | null) => {
    const out: number[] = []
    let run = 0
    let best: Span | null = null
    hours.forEach((h, i) => {
      run = bad(h) === true ? run + 1 : 0
      out.push(run)
      if (run > 0 && (!best || run > best.hours)) best = { start: hours[i - run + 1].t, hours: run }
    })
    return { out, best: best as Span | null }
  }
  const dark = streak((h) => h.dark)
  const gap = streak((h) => h.blackout)
  const initial = (good: (h: MissionHour) => boolean) => {
    let n = 0
    while (n < hours.length && good(hours[n])) n++
    return n
  }
  const initialSunHours = initial((h) => h.dark === false)
  const initialCommsHours = initial((h) => h.blackout === false)

  const failures: MissionFailure[] = []
  const firstOver = (streaks: number[], limit: number) => streaks.findIndex((n) => n > limit)
  const iDark = firstOver(dark.out, req.battery_hours)
  if (iDark >= 0) {
    failures.push({
      t: hours[iDark].t,
      constraint: 'battery_hours',
      message: `Panels dark for ${fmtH(dark.out[iDark])} in a row: the battery only lasts ${fmtH(req.battery_hours)}.`,
    })
  }
  const iGap = firstOver(gap.out, req.max_comms_gap_hours)
  if (iGap >= 0) {
    failures.push({
      t: hours[iGap].t,
      constraint: 'max_comms_gap_hours',
      message: `No contact with Earth for ${fmtH(gap.out[iGap])}: the plan allows at most ${fmtH(req.max_comms_gap_hours)}.`,
    })
  }
  if (hours.length && initialSunHours < req.min_initial_sun_hours && initialSunHours < hours.length) {
    failures.push({
      t: hours[initialSunHours].t,
      constraint: 'min_initial_sun_hours',
      message: `Sunlight after landing lasts only ${fmtH(initialSunHours)}: the plan needs ${fmtH(req.min_initial_sun_hours)}.`,
    })
  }
  if (hours.length && initialCommsHours < req.min_initial_comms_hours && initialCommsHours < hours.length) {
    failures.push({
      t: hours[initialCommsHours].t,
      constraint: 'min_initial_comms_hours',
      message: `Earth contact after landing lasts only ${fmtH(initialCommsHours)}: the plan needs ${fmtH(req.min_initial_comms_hours)}.`,
    })
  }

  const known = <T,>(xs: (T | null)[]) => xs.filter((x): x is T => x !== null)
  const fractions = known(hours.map((h) => h.sunFraction))
  const earth = known(hours.map((h) => h.blackout))
  const sunlightFraction = fractions.length ? fractions.reduce((a, b) => a + b, 0) / fractions.length : null
  const earthFraction = earth.length ? earth.filter((b) => !b).length / earth.length : null
  if (sunlightFraction !== null && sunlightFraction < req.min_sunlight_fraction) {
    failures.push({
      t: end,
      constraint: 'min_sunlight_fraction',
      message: `Average sunlight ${pct(sunlightFraction)} over the mission: the plan needs ${pct(req.min_sunlight_fraction)}.`,
    })
  }
  if (earthFraction !== null && earthFraction < req.min_earth_visibility_fraction) {
    failures.push({
      t: end,
      constraint: 'min_earth_visibility_fraction',
      message: `Earth in view ${pct(earthFraction)} of the mission: the plan needs ${pct(req.min_earth_visibility_fraction)}.`,
    })
  }
  failures.sort((a, b) => a.t - b.t)

  return {
    start,
    end,
    hours,
    darkStreak: dark.out,
    gapStreak: gap.out,
    longestDark: dark.best,
    longestBlackout: gap.best,
    initialSunHours,
    initialCommsHours,
    sunlightFraction,
    earthFraction,
    unknownHours: hours.filter((h) => h.dark === null || h.blackout === null).length,
    failures,
  }
}

/** The mission at time t: which day, how long the panels have been dark, how long without Earth. */
export function missionAt(track: MissionTrack, t: number) {
  const n = track.hours.length
  let i = n ? Math.floor((t - track.hours[0].t) / HOUR_MS) : -1
  i = Math.max(0, Math.min(n - 1, i))
  const days = (track.end - track.start) / (24 * HOUR_MS)
  return {
    day: Math.min(Math.ceil(days), Math.floor((t - track.start) / (24 * HOUR_MS)) + 1),
    totalDays: Math.ceil(days),
    progress: Math.max(0, Math.min(1, (t - track.start) / (track.end - track.start))),
    hour: n ? track.hours[i] : null,
    darkStreak: n ? track.darkStreak[i] : 0,
    gapStreak: n ? track.gapStreak[i] : 0,
  }
}
