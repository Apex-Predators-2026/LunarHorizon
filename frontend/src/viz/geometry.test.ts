import { describe, expect, it } from 'vitest'
import { azElToVector, buildHorizonCurtain, skyTrail } from './geometry'

// digits = decimal places; vertex buffers are Float32, so compare those more loosely.
const close = (a: number[], b: number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits))

describe('azElToVector', () => {
  it('maps compass directions onto x=east, z=-north', () => {
    close(azElToVector(0, 0), [0, 0, -1]) // north
    close(azElToVector(90, 0), [1, 0, 0]) // east
    close(azElToVector(180, 0), [0, 0, 1]) // south
    close(azElToVector(270, 0), [-1, 0, 0]) // west
    close(azElToVector(123, 90), [0, 1, 0]) // zenith
  })

  it('scales and keeps unit length', () => {
    const [x, y, z] = azElToVector(37, 12, 5)
    expect(Math.hypot(x, y, z)).toBeCloseTo(5, 9)
    expect(y).toBeCloseTo(5 * Math.sin((12 * Math.PI) / 180), 9)
  })
})

describe('buildHorizonCurtain', () => {
  it('top edge follows the horizon and the loop closes', () => {
    const { topLine } = buildHorizonCurtain([0, 90, 180, 270], [5, 10, 0, -2], 1000)
    const n = topLine.length / 3
    expect(n).toBe(5)
    close(Array.from(topLine.slice(0, 3)), Array.from(topLine.slice(12, 15))) // closed
    close(Array.from(topLine.slice(3, 6)), azElToVector(90, 10, 1000), 3)
  })
})

describe('skyTrail', () => {
  const step = (h: number, sunVisible: boolean | null, earthVisible: boolean | null) => ({
    time_utc: new Date(Date.UTC(2027, 0, 1, h)).toISOString(),
    sun: { azimuth_deg: h * 15, elevation_deg: 1, visible_fraction: sunVisible === null ? null : sunVisible ? 1 : 0, visible: sunVisible },
    earth: { azimuth_deg: 180, elevation_deg: 5 + h, visible: earthVisible },
  })
  const colours = { visible: [1, 1, 1] as [number, number, number], blocked: [0, 0, 0] as [number, number, number], unknown: [0.5, 0.5, 0.5] as [number, number, number] }

  it('makes one segment per hour, coloured by the state at its start, and never bridges a gap', () => {
    // hours 0, 1, 2, then a 5-hour gap, then 7, 8
    const steps = [step(0, true, true), step(1, false, true), step(2, null, true), step(7, true, false), step(8, true, false)]
    const sun = skyTrail(steps, 'sun', 1000, colours)
    expect(sun.positions.length).toBe(3 * 2 * 3) // 0-1, 1-2, 7-8
    expect(Array.from(sun.colors.slice(0, 3))).toEqual([1, 1, 1]) // hour 0 visible
    expect(Array.from(sun.colors.slice(6, 9))).toEqual([0, 0, 0]) // hour 1 blocked
    expect(Array.from(sun.colors.slice(12, 15))).toEqual([1, 1, 1]) // hour 7 (after the gap)
    expect(Math.hypot(sun.positions[0], sun.positions[1], sun.positions[2])).toBeCloseTo(1000)
    const earth = skyTrail(steps, 'earth', 1000, colours)
    expect(Array.from(earth.colors.slice(12, 15))).toEqual([0, 0, 0]) // Earth hidden at hour 7
  })

  it('marks unknown hours as unknown', () => {
    const t = skyTrail([step(0, null, null), step(1, true, true)], 'sun', 1, colours)
    expect(Array.from(t.colors.slice(0, 3))).toEqual([0.5, 0.5, 0.5])
  })
})
