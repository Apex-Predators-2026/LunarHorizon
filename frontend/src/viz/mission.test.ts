import { describe, expect, it } from 'vitest'
import { DEFAULT_REQUIREMENTS, type MissionRequirements, type TimelineStep } from '../types'
import { missionAt, missionTrack, missionWindow } from './mission'
import { HOUR_MS, toIsoMinute } from './timeline'

const T0 = Date.UTC(2027, 0, 10)

/** Hourly steps from T0: `sun` / `earth` strings, one char per hour: L/D (lit/dark), Y/N (Earth yes/no), ? unknown. */
function steps(sun: string, earth: string): TimelineStep[] {
  return [...sun].map((c, i) => ({
    time_utc: toIsoMinute(T0 + i * HOUR_MS),
    sun: { azimuth_deg: 0, elevation_deg: 1, horizon_deg: 0, visible_fraction: c === '?' ? null : c === 'L' ? 1 : 0 },
    earth: {
      azimuth_deg: 0,
      elevation_deg: 1,
      horizon_deg: 0,
      visible: earth[i] === '?' ? null : earth[i] === 'Y',
      margin_deg: 1,
    },
  }))
}

const plan = (hours: number, req: Partial<MissionRequirements> = {}) => ({
  landing_utc: toIsoMinute(T0),
  duration_days: hours / 24,
  requirements: { ...DEFAULT_REQUIREMENTS, min_sunlight_fraction: 0, min_earth_visibility_fraction: 0, min_initial_sun_hours: 0, min_initial_comms_hours: 0, ...req },
})

describe('missionTrack', () => {
  it('counts streaks and finds the moment the battery runs out', () => {
    //            hour: 0123456789
    const s = steps('LLDDDDLDDD', 'YYYYYYYYYY')
    const t = missionTrack(s, plan(9, { battery_hours: 3 }))
    expect(t.darkStreak).toEqual([0, 0, 1, 2, 3, 4, 0, 1, 2, 3])
    expect(t.longestDark).toEqual({ start: T0 + 2 * HOUR_MS, hours: 4 })
    expect(t.failures).toHaveLength(1)
    expect(t.failures[0]).toMatchObject({ constraint: 'battery_hours', t: T0 + 5 * HOUR_MS }) // the 4th dark hour
    expect(t.failures[0].message).toMatch(/4 h in a row.*3 h/)
  })

  it('finds communication blackouts and short starts', () => {
    const s = steps('LDLLLLLLLL', 'YYNNNNNYYY')
    const t = missionTrack(s, plan(9, { max_comms_gap_hours: 4, min_initial_sun_hours: 3, min_initial_comms_hours: 2 }))
    expect(t.initialSunHours).toBe(1)
    expect(t.initialCommsHours).toBe(2) // exactly enough: no failure
    expect(t.failures.map((f) => [f.constraint, (f.t - T0) / HOUR_MS])).toEqual([
      ['min_initial_sun_hours', 1],
      ['max_comms_gap_hours', 6],
    ])
    expect(t.longestBlackout).toEqual({ start: T0 + 2 * HOUR_MS, hours: 5 })
  })

  it('never counts unknown hours as dark or lit', () => {
    const s = steps('DD??DD', 'YY??YY')
    const t = missionTrack(s, plan(5, { battery_hours: 3 }))
    expect(t.darkStreak).toEqual([1, 2, 0, 0, 1, 2]) // unknown breaks the streak, no false failure
    expect(t.unknownHours).toBe(2)
    expect(t.failures).toEqual([])
  })

  it('reports whole-mission averages at the end, and clips steps to the mission window', () => {
    const s = steps('DDLLDDDDDDDDDDDD', 'NNYYNNNNNNNNNNNN')
    const t = missionTrack(s, plan(3, { min_sunlight_fraction: 0.6, min_earth_visibility_fraction: 0.6, battery_hours: 100 }))
    expect(t.hours).toHaveLength(4) // hours 0..3 only
    expect(t.sunlightFraction).toBeCloseTo(0.5)
    expect(t.failures.map((f) => f.constraint)).toEqual(['min_sunlight_fraction', 'min_earth_visibility_fraction'])
    expect(t.failures.every((f) => f.t === missionWindow(plan(3)).at(1))).toBe(true)
  })
})

describe('missionAt', () => {
  it('gives the mission day, progress and streaks at a time', () => {
    const s = steps('L'.repeat(24) + 'D'.repeat(25), 'Y'.repeat(49))
    const t = missionTrack(s, plan(48))
    const m = missionAt(t, T0 + 30 * HOUR_MS)
    expect(m).toMatchObject({ day: 2, totalDays: 2, darkStreak: 7, gapStreak: 0 })
    expect(m.progress).toBeCloseTo(30 / 48)
    expect(missionAt(t, T0 + 48 * HOUR_MS).day).toBe(2) // the very end is still the last day
  })
})
