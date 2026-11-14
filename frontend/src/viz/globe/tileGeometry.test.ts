import { describe, expect, it } from 'vitest'
import { MOON_RADIUS_M, SiteFrame, TILE_N, tileAt } from './cubeSphere'
import { buildTileMesh } from './tileGeometry'

const site = new SiteFrame(-89.53432, 209.94767, 1654)
const flat = (h: number) => new Float32Array(TILE_N * TILE_N).fill(h)

describe('buildTileMesh', () => {
  it('places the tile containing the site around the origin, on the sphere', () => {
    const [face, x, y] = tileAt(site.latDeg, site.lonDeg, 12)
    const m = buildTileMesh(face, 12, x, y, flat(1654), site)
    // Tile ~670 m across: its centre is within a tile-width of the site, at about ground level.
    expect(Math.hypot(m.centre[0], m.centre[2])).toBeLessThan(700)
    expect(Math.abs(m.centre[1])).toBeLessThan(1)
    expect(m.radius).toBeGreaterThan(300)
    expect(m.radius).toBeLessThan(800)
  })

  it('winds triangles outward (away from the Moon centre)', () => {
    const [face, x, y] = tileAt(site.latDeg, site.lonDeg, 6)
    const m = buildTileMesh(face, 6, x, y, flat(0), site)
    const c = site.moonCentre
    const p = (k: number) => [0, 1, 2].map((a) => m.positions[3 * k + a] + m.centre[a])
    let checked = 0
    for (let t = 0; t < (TILE_N - 1) * (TILE_N - 1) * 6; t += 6 * 97) {
      const [a, b, d] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]].map(p)
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]
      const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
      const out = [a[0] - c[0], a[1] - c[1], a[2] - c[2]]
      expect(nrm[0] * out[0] + nrm[1] * out[1] + nrm[2] * out[2]).toBeGreaterThan(0)
      checked++
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('hangs a skirt below every border vertex', () => {
    const m = buildTileMesh(5, 3, 2, 5, flat(0), site)
    const skirts = m.positions.length / 3 - m.skirtStart
    expect(skirts).toBe(4 * (TILE_N - 1))
    // A skirt vertex is closer to the Moon centre than its border vertex.
    const c = site.moonCentre
    const r = (k: number) => Math.hypot(...[0, 1, 2].map((a) => m.positions[3 * k + a] + m.centre[a] - c[a]))
    expect(r(m.skirtStart)).toBeLessThan(r(m.borderOf[0]))
    expect(r(m.borderOf[0])).toBeCloseTo(MOON_RADIUS_M, -1)
  })
})
