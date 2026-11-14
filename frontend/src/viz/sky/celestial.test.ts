import { describe, expect, it } from 'vitest'
import { SiteFrame, type Vec3 } from '../globe/cubeSphere'
import { apply, azEl, daysSinceJ2000, gmst, moonDirection, moonFixedFromInertial, siteFromInertial, sunDirection } from './celestial'

// From the engine (JPL Horizons, topocentric at the site): site, time, Sun az/el, Earth az/el (deg).
const HORIZONS: [string, string, number, number, number, number][] = [
  ['apollo-11', '2026-03-01T00:00Z', 93.075, 78.531, 258.254, 69.815],
  ['apollo-11', '2027-07-15T12:00Z', 90.438, 74.094, 284.886, 70.714],
  ['apollo-11', '2029-11-20T06:00Z', 264.033, 76.064, 258.254, 65.677],
  ['connecting-ridge', '2026-03-01T00:00Z', 184.978, -0.514, 153.846, 2.692],
  ['connecting-ridge', '2027-07-15T12:00Z', 189.432, -0.988, 154.881, -6.155],
  ['connecting-ridge', '2029-11-20T06:00Z', 159.667, 0.343, 149.791, 3.527],
  ['change-4', '2026-03-01T00:00Z', 226.975, -33.941, 188.187, -41.058],
  ['change-4', '2027-07-15T12:00Z', 231.773, -31.975, 191.176, -49.694],
  ['change-4', '2029-11-20T06:00Z', 196.427, -42.555, 182.793, -40.52],
]
const SITES: Record<string, [number, number, number]> = {
  'apollo-11': [0.6742, 23.4731, -1926.7],
  'connecting-ridge': [-89.53432, 209.94767, 1654],
  'change-4': [-45.4561, 177.5885, -5926.1],
}

/** Angle (deg) between two sky directions given as az/el (deg). */
function separation([az1, el1]: [number, number], [az2, el2]: [number, number]) {
  const r = Math.PI / 180
  const c = Math.sin(el1 * r) * Math.sin(el2 * r) + Math.cos(el1 * r) * Math.cos(el2 * r) * Math.cos((az1 - az2) * r)
  return Math.acos(Math.min(1, c)) / r
}

describe('the sky from a lunar site (checked against JPL Horizons)', () => {
  it.each(HORIZONS)('%s at %s: the Sun and Earth where Horizons puts them', (id, time, sunAz, sunEl, earthAz, earthEl) => {
    const frame = new SiteFrame(...SITES[id])
    const d = daysSinceJ2000(Date.parse(time.replace('Z', ':00Z')))
    const m = siteFromInertial(d, frame)
    const sun = azEl(apply(m, sunDirection(d)))
    const earth = azEl(apply(m, moonDirection(d).map((x) => -x) as Vec3)) // Earth from the Moon: opposite way
    expect(separation(sun, [sunAz, sunEl])).toBeLessThan(0.15) // measured: 0.04-0.10 deg
    expect(separation(earth, [earthAz, earthEl])).toBeLessThan(0.4) // measured: 0.06-0.29 deg
  })

  it('keeps the Moon facing Earth: the point below Earth stays within the libration limits of (0, 0)', () => {
    for (let d = 9000; d < 11000; d += 37.3) {
      const toEarth = apply(moonFixedFromInertial(d), moonDirection(d).map((x) => -x) as Vec3)
      const lat = (Math.asin(toEarth[2]) * 180) / Math.PI
      const lon = (Math.atan2(toEarth[1], toEarth[0]) * 180) / Math.PI
      expect(Math.abs(lat)).toBeLessThan(7.5)
      expect(Math.abs(lon)).toBeLessThan(8.5)
    }
  })

  it('turns Earth once per sidereal day', () => {
    expect((gmst(0) * 180) / Math.PI).toBeCloseTo(280.46, 2) // at J2000
    const day = 0.99726957 // sidereal day in solar days
    expect(Math.abs(Math.sin(gmst(10 + day) - gmst(10)))).toBeLessThan(1e-6)
  })
})
