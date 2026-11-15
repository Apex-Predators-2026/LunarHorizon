// The comparison's shared time axis uses the times the backend actually evaluated (the hourly data grid,
// backend/app/timegrid.py), so elapsed (T+) and UTC labels line up with the data drawn on them. Before a result
// arrives a scenario is placed provisionally with the backend's documented policy (see missionTime.test.tsx for
// the evaluated-window cases).
import { describe, expect, it } from 'vitest'

import { axisOffsets, axisOrigin, fullDomain, type Entry } from './analysis'
import { axisPlacement, missionTimeOf } from './missionTime'
import type { ComparisonScenario } from './types'

const sc = (id: string, landing_utc: string, duration_days: number) =>
  ({ id, landing_utc, duration_days }) as unknown as ComparisonScenario
const pending = (s: ComparisonScenario) => ({ scenario: s, state: { state: 'loading' as const } })
const ms = (iso: string) => new Date(iso).getTime()
const place = (s: ComparisonScenario) => axisPlacement(missionTimeOf(s, undefined))

describe('comparison time axis before results arrive (provisional placement)', () => {
  it('rounds landings to the nearest whole UTC hour (half up) and lengths to whole hours (ties to even)', () => {
    expect(place(sc('a', '2027-02-08T00:15:00Z', 1)).landingMs).toBe(ms('2027-02-08T00:00:00Z'))
    expect(place(sc('a', '2027-02-08T00:30:00Z', 1)).landingMs).toBe(ms('2027-02-08T01:00:00Z'))
    expect(place(sc('a', '2027-02-08T00:00:00Z', 1.01)).hours).toBe(24)
    expect(place(sc('a', '2027-02-08T00:00:00Z', 0.001)).hours).toBe(1)
    // Python round(): 23.5 -> 24, 24.5 -> 24, 25.5 -> 26 (Math.round would give 25 for 24.5).
    expect([23.5, 24.5, 25.5].map((h) => place(sc('a', '2027-02-08T00:00:00Z', h / 24)).hours)).toEqual([24, 24, 26])
    expect(place(sc('a', '2027-02-08T00:00:00Z', 1)).provisional).toBe(true)
  })

  it('aligns UTC offsets and the origin to the grid landings', () => {
    const list = [pending(sc('a', '2027-02-08T00:15:00Z', 1)), pending(sc('b', '2027-02-08T02:30:00Z', 1))]
    expect(axisOrigin(list)).toBe(ms('2027-02-08T00:00:00Z'))
    expect(axisOffsets(list, 'utc')).toEqual({ a: 0, b: 3 })
    expect(axisOffsets(list, 'met')).toEqual({ a: 0, b: 0 })
  })

  it('spans the grid length, not the typed one', () => {
    const e = { offsetHours: 0, state: undefined, scenario: sc('a', '2027-02-08T00:00:00Z', 1.01) } as unknown as Entry
    expect(fullDomain([e])).toEqual([0, 24])
  })
})
