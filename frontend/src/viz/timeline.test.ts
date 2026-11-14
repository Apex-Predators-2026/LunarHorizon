import { describe, expect, it } from 'vitest'
import {
  fmtDeg,
  fmtPct,
  HOUR_MS,
  longestRun,
  nearestIndex,
  parseUtc,
  roundHour,
  runs,
  skyRange,
  skyXY,
  sunUp,
  toIsoMinute,
  windowFor,
} from './timeline'

const T0 = parseUtc('2027-01-01T00:00Z')
const T_END = parseUtc('2029-01-01T00:00Z')

describe('unknown-aware helpers', () => {
  it('trusts the visible flag over a rounded fraction, and treats unknown as not visible', () => {
    expect(sunUp({ visible: true, visible_fraction: 0 })).toBe(true) // sliver rounded to 0
    expect(sunUp({ visible_fraction: 0.4 })).toBe(true) // older data without the flag
    expect(sunUp({ visible: null, visible_fraction: null })).toBe(false)
  })
  it('formats unknowns and slivers', () => {
    expect(fmtPct(null)).toBe('unknown')
    expect(fmtPct(0.001, true)).toBe('<1%')
    expect(fmtPct(0.735)).toBe('74%')
    expect(fmtDeg(null)).toBe('unknown')
    expect(fmtDeg(1.234, 2, true)).toBe('+1.23°')
  })
})

describe('time formats', () => {
  it('round-trips the backend format', () => {
    expect(toIsoMinute(parseUtc('2027-03-04T05:06Z'))).toBe('2027-03-04T05:06Z')
    expect(parseUtc('2027-03-04T05:06')).toBe(parseUtc('2027-03-04T05:06Z')) // no zone = UTC
    expect(toIsoMinute(roundHour(parseUtc('2027-03-04T05:31Z')))).toBe('2027-03-04T06:00Z')
  })
})

describe('windowFor', () => {
  it('aligns windows to the data start and clips at the end', () => {
    const day = 24 * HOUR_MS
    expect(windowFor(T0 + 3 * day, T0, T_END, 28)).toEqual([T0, T0 + 28 * day])
    expect(windowFor(T0 + 30 * day, T0, T_END, 28)).toEqual([T0 + 28 * day, T0 + 56 * day])
    const [, b] = windowFor(T_END, T0, T_END, 28)
    expect(b).toBe(T_END)
    expect(windowFor(T0 - day, T0, T_END, 7)[0]).toBe(T0) // before the data -> first window
  })
})

describe('nearestIndex', () => {
  it('finds the closest sample', () => {
    const t = [0, 10, 20, 30]
    expect(nearestIndex(t, -5)).toBe(0)
    expect(nearestIndex(t, 14)).toBe(1)
    expect(nearestIndex(t, 16)).toBe(2)
    expect(nearestIndex(t, 99)).toBe(3)
    expect(nearestIndex([], 1)).toBe(-1)
  })
})

describe('runs / longestRun', () => {
  const f = [true, true, false, false, false, true, false]
  it('lists runs of a value', () => {
    expect(runs(f)).toEqual([[0, 2], [5, 6]])
    expect(runs(f, false)).toEqual([[2, 5], [6, 7]])
  })
  it('picks the longest', () => {
    expect(longestRun(f, false)).toEqual([2, 5])
    expect(longestRun([false], true)).toBeNull()
  })
})

describe('skyRange', () => {
  const step = (sun: number, earth: number) => ({ sun: { elevation_deg: sun }, earth: { elevation_deg: earth } })
  it('fits a ridge site (low horizon) tightly', () => {
    expect(skyRange([-2.45, 4.9, 1], [step(1.9, 7.2)])).toEqual([10, -4]) // 7.2+2 -> 10, -2.45-1.5 -> -4
  })
  it('fits a crater floor (high horizon) and caps the rim at -10', () => {
    expect(skyRange([19.8, 23.6], [step(1, -20)])).toEqual([26, -2])
    expect(skyRange([-30], [])).toEqual([2, -10])
  })
})

describe('skyXY', () => {
  it('puts north up, east right, top elevation at the centre and clamps to the rim', () => {
    const [nx, ny] = skyXY(0, 0, 100, 20, -20)
    expect(nx).toBeCloseTo(0)
    expect(ny).toBeCloseTo(-50) // halfway out, upwards
    const [ex, ey] = skyXY(90, -20, 100, 20, -20)
    expect(ex).toBeCloseTo(100)
    expect(ey).toBeCloseTo(0)
    expect(skyXY(180, 20, 100, 20, -20).map((v) => Math.abs(v))).toEqual([0, 0]) // zenith-ish centre
    expect(Math.hypot(...skyXY(45, -90, 100, 20, -20))).toBeCloseTo(100) // clamped
  })
})
