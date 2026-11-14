import { describe, expect, it } from 'vitest'
import { SiteFrame } from './cubeSphere'
import { blockerLine, currentBlockers, destination, horizonAt, surfacePoint } from './overlays'

describe('surface overlays', () => {
  const frame = new SiteFrame(-89.53432, 209.94767, 1654)

  it('puts the site itself at the origin', () => {
    const p = surfacePoint(frame, -89.53432, 209.94767, 1654)
    p.forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-6))
  })

  it('places a point 5 km north at z = -5 km (curvature drops it ~7 m)', () => {
    const [lat, lon] = destination(-89.53432, 209.94767, 0, 5000)
    const p = surfacePoint(frame, lat, lon, 1654)
    expect(p[2]).toBeCloseTo(-5000, -1)
    expect(Math.abs(p[0])).toBeLessThan(1)
    expect(p[1]).toBeCloseTo(-(5000 ** 2) / (2 * 1_739_054), 0)
  })

  it('reads the horizon at the nearest 0.5-degree bin', () => {
    const az = Array.from({ length: 720 }, (_, k) => k * 0.5)
    const vals = az.map((a) => a / 10)
    expect(horizonAt(az, vals, 90.2)).toBeCloseTo(9.0)
    expect(horizonAt(az, vals, 359.9)).toBeCloseTo(0) // wraps to 0 deg
    expect(horizonAt(az, vals, -0.4)).toBeCloseTo(35.95) // -0.4 -> 359.6 -> 359.5
  })
})

describe('currentBlockers', () => {
  const az = Array.from({ length: 720 }, (_, k) => k * 0.5)
  const horizon = { azimuth_deg: az, elevation_deg: az.map(() => 2), distance_m: az.map(() => 5000) }
  const body = (azimuth_deg: number, elevation_deg: number) => ({ azimuth_deg, elevation_deg, horizon_deg: null })

  it('returns a line only for the blocked body', () => {
    const b = currentBlockers({ sun: body(90, 1), earth: body(180, 3) }, horizon, 2)
    expect(b.map((x) => x.body)).toEqual(['sun'])
    expect(b[0].distanceM).toBe(5000)
    expect(b[0].marginDeg).toBeCloseTo(-1)
  })

  it('is empty without data', () => {
    expect(currentBlockers(null, horizon, 2)).toEqual([])
  })
})

describe('blockerLine', () => {
  it('is null when the body clears the terrain or the horizon is unknown', () => {
    expect(blockerLine('sun', 90, 2, 1, 8000, 2)).toBeNull()
    expect(blockerLine('sun', 90, 0, null, 8000, 2)).toBeNull()
  })

  it('points from the eye towards the blocking terrain, at the right distance', () => {
    const b = blockerLine('earth', 90, -1, 3, 8000, 2)!
    expect(b.marginDeg).toBeCloseTo(-4)
    expect(b.from).toEqual([0, 2, 0])
    expect(b.to[0]).toBeCloseTo(8000, 6) // due east, 8 km out horizontally
    expect(b.to[1]).toBeCloseTo(2 + 8000 * Math.tan((3 * Math.PI) / 180), 6)
    expect(Math.abs(b.to[2])).toBeLessThan(1e-9)
  })
})
