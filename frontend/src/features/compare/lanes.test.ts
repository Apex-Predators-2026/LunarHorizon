import { describe, expect, it } from 'vitest'
import { knownSpans, knownSunRuns, laneCoverage, timelineEarthRuns, unknownWindows, withheldNotes } from './lanes'
import type { CompareResult, TimelineColumns, Window } from './types'

const win = (start: number, end: number, kind?: string): Window => ({
  start_hour: start,
  end_hour: end,
  duration_hours: end - start,
  start_utc: `h${start}`,
  end_utc: `h${end}`,
  open_start: false,
  open_end: false,
  kind,
})

const timeline = (sun: (number | null)[], earth: (boolean | null)[]): TimelineColumns => ({
  step_hours: 1,
  hour: sun.map((_, i) => i + 0.5),
  time_utc: sun.map((_, i) => `t${i}`),
  sun_elevation_deg: sun.map(() => 1),
  sun_azimuth_deg: sun.map(() => 0),
  sun_horizon_deg: sun.map(() => 0),
  sun_visible_fraction: sun,
  earth_elevation_deg: earth.map(() => 1),
  earth_azimuth_deg: earth.map(() => 0),
  earth_horizon_deg: earth.map(() => 0),
  earth_visible: earth,
  incidence_factor: sun.map(() => null),
})

const result = (over: Partial<CompareResult>): CompareResult =>
  ({
    key: 'A',
    status: 'ok',
    message: null,
    data_kind: 'real',
    data_source: 'test',
    site_context: null,
    science_context: null,
    viability: null,
    ranking: null,
    assessment: null,
    solar: null,
    earth: null,
    power: null,
    sun_windows: [],
    dark_windows: [],
    earth_windows: [],
    blackout_windows: [],
    events: [],
    timeline: null,
    ...over,
  }) as CompareResult

describe('comparison lanes: unknown is its own state', () => {
  it('splits the Sun shape at unknown samples instead of bridging them', () => {
    expect(knownSunRuns(timeline([0.5, 1, null, null, 0, 0.2], [true, true, true, true, true, true]))).toEqual([
      [0, 2],
      [4, 6],
    ])
  })

  it('takes known time from the engine windows, leaving unknown windows out of it', () => {
    const r = result({
      sun_windows: [win(0, 10)],
      dark_windows: [win(14, 20)],
      unknown_windows: [win(10, 14, 'sun_unknown'), win(3, 5, 'earth_unknown')],
    })
    expect(knownSpans(r, 'sun').map((s) => [s.start_hour, s.end_hour])).toEqual([[0, 10], [14, 20]])
    expect(unknownWindows(r, 'sun').map((w) => w.start_hour)).toEqual([10])
    expect(unknownWindows(r, 'earth').map((w) => w.start_hour)).toEqual([3])
  })

  it('falls back to the timeline samples when the engine reported no windows (never assessed)', () => {
    const r = result({ timeline: timeline([0.4, null, 0], [true, null, false]) })
    expect(knownSpans(r, 'sun')).toEqual([{ start_hour: 0, end_hour: 1 }, { start_hour: 2, end_hour: 3 }])
    expect(timelineEarthRuns(r.timeline!, true)).toEqual([{ start_hour: 0, end_hour: 1 }])
    expect(timelineEarthRuns(r.timeline!, false)).toEqual([{ start_hour: 2, end_hour: 3 }])
  })

  it('reports coverage hours from the backend, and null (not 0) when it reported none', () => {
    const r = result({ sun_known_hours: 150, earth_known_hours: 168, evaluated_duration_days: 7 })
    expect(laneCoverage(r, 'sun', 7)).toEqual({ knownHours: 150, totalHours: 168, complete: false })
    expect(laneCoverage(r, 'earth', 7).complete).toBe(true)
    expect(laneCoverage(result({}), 'sun', 2)).toEqual({ knownHours: null, totalHours: 48, complete: false })
  })

  it('groups withheld blocks that share a reason', () => {
    const why = 'The Sun is unknown for 18 h.'
    const notes = withheldNotes(result({ withheld: { solar: why, power: why, earth: 'Earth unknown for 2 h.' } }))
    expect(notes).toEqual([
      { blocks: 'Solar statistics and Power statistics', reason: why },
      { blocks: 'Earth statistics', reason: 'Earth unknown for 2 h.' },
    ])
    expect(withheldNotes(result({}))).toEqual([])
  })
})
