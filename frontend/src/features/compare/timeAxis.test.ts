// The comparison's shared time axis uses the times the backend actually evaluated (the hourly data grid,
// backend/app/timegrid.py), so elapsed (T+) and UTC labels line up with the data drawn on them.
import { describe, expect, it } from 'vitest'

import { axisOffsets, axisOrigin, fullDomain, gridHours, gridLandingMs, type Entry } from './analysis'
import type { ComparisonScenario } from './types'

const sc = (id: string, landing_utc: string, duration_days: number) =>
  ({ id, landing_utc, duration_days }) as unknown as ComparisonScenario
const ms = (iso: string) => new Date(iso).getTime()

describe('comparison time axis on the evaluated grid', () => {
  it('rounds landings to the nearest whole UTC hour (half up) and lengths to whole hours', () => {
    expect(gridLandingMs(sc('a', '2027-02-08T00:15:00Z', 1))).toBe(ms('2027-02-08T00:00:00Z'))
    expect(gridLandingMs(sc('a', '2027-02-08T00:30:00Z', 1))).toBe(ms('2027-02-08T01:00:00Z'))
    expect(gridHours(sc('a', '2027-02-08T00:00:00Z', 1.01))).toBe(24)
    expect(gridHours(sc('a', '2027-02-08T00:00:00Z', 0.001))).toBe(1)
  })

  it('aligns UTC offsets and the origin to the evaluated landings', () => {
    const list = [sc('a', '2027-02-08T00:15:00Z', 1), sc('b', '2027-02-08T02:30:00Z', 1)]
    expect(axisOrigin(list)).toBe(ms('2027-02-08T00:00:00Z'))
    expect(axisOffsets(list, 'utc')).toEqual({ a: 0, b: 3 })
    expect(axisOffsets(list, 'met')).toEqual({ a: 0, b: 0 })
  })

  it('spans the evaluated length, not the typed one', () => {
    const e = { offsetHours: 0, scenario: sc('a', '2027-02-08T00:00:00Z', 1.01) } as unknown as Entry
    expect(fullDomain([e])).toEqual([0, 24])
  })
})
