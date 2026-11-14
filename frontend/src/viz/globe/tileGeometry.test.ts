import { describe, expect, it } from 'vitest'
import { MOON_RADIUS_M, SiteFrame, TILE_N, tileAt, tileVertexUV, uvToVec, type Vec3 } from './cubeSphere'
import { buildTileMesh, innerHeights, tilePadding, tileTopology } from './tileGeometry'

const site = new SiteFrame(-89.53432, 209.94767, 1654)
const flat = (h: number) => new Float32Array(TILE_N * TILE_N).fill(h)

// Smooth synthetic terrain (+-30 m ridges ~0.5 km apart), defined by position on the Moon, so
// neighbouring tiles see exactly the same heights where they overlap.
const terrain = (d: Vec3) => 1654 + 30 * Math.sin(d[0] * 20000) * Math.cos(d[1] * 17000)
function heightsFor(face: number, z: number, x: number, y: number, pad: number) {
  const m = TILE_N + 2 * pad
  const h = new Float32Array(m * m)
  for (let jj = 0; jj < m; jj++)
    for (let ii = 0; ii < m; ii++) h[jj * m + ii] = terrain(uvToVec(face, ...tileVertexUV(z, x, y, ii - pad, jj - pad)))
  return h
}
const normalAt = (m: { normals: Float32Array }, k: number): Vec3 => [m.normals[3 * k], m.normals[3 * k + 1], m.normals[3 * k + 2]]
// atan2(|a x b|, a . b): exact near 0 (acos of a float32 dot product bottoms out at ~0.02 deg).
const angleDeg = (a: Vec3, b: Vec3) => {
  const cx = a[1] * b[2] - a[2] * b[1]
  const cy = a[2] * b[0] - a[0] * b[2]
  const cz = a[0] * b[1] - a[1] * b[0]
  return (Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180) / Math.PI
}

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

  it('shares one 16-bit index buffer between all tiles', () => {
    const a = buildTileMesh(5, 3, 2, 5, flat(0), site)
    const b = buildTileMesh(0, 7, 40, 90, flat(100), site)
    expect(a.indices).toBe(b.indices)
    expect(a.indices).toBe(tileTopology().indices)
    expect(a.indices).toBeInstanceOf(Uint16Array)
  })

  it('gives every tile the same texture coordinates (corners = texture corners, skirts copy their edge)', () => {
    const t = tileTopology()
    const uv = (k: number) => [t.uvs[2 * k], t.uvs[2 * k + 1]]
    const N = TILE_N
    expect(uv(0)).toEqual([0, 0])
    expect(uv(N - 1)).toEqual([1, 0])
    expect(uv(N * N - 1)).toEqual([1, 1])
    for (let s = 0; s < t.border.length; s++) expect(uv(N * N + s)).toEqual(uv(t.border[s]))
    expect(tileTopology().uvs).toBe(t.uvs) // shared, like the index
  })
})

describe('tile normals', () => {
  const [f, x, y] = tileAt(site.latDeg, site.lonDeg, 12)

  it('are unit length and point away from the Moon', () => {
    const m = buildTileMesh(f, 12, x, y, heightsFor(f, 12, x, y, 1), site, TILE_N, 1)
    const c = site.moonCentre
    for (let k = 0; k < m.positions.length / 3; k += 37) {
      const nrm = normalAt(m, k)
      expect(Math.hypot(...nrm)).toBeCloseTo(1, 6)
      const out = [0, 1, 2].map((a) => m.positions[3 * k + a] + m.centre[a] - c[a])
      expect(nrm[0] * out[0] + nrm[1] * out[1] + nrm[2] * out[2]).toBeGreaterThan(0)
    }
  })

  it('padding changes no vertex, only the normals at the edges', () => {
    const plain = buildTileMesh(f, 12, x, y, heightsFor(f, 12, x, y, 0), site)
    const padded = buildTileMesh(f, 12, x, y, heightsFor(f, 12, x, y, 1), site, TILE_N, 1)
    expect(padded.centre).toEqual(plain.centre)
    for (let k = 0; k < plain.positions.length; k++) expect(padded.positions[k]).toBeCloseTo(plain.positions[k], 3)
    const mid = (TILE_N >> 1) * TILE_N + (TILE_N >> 1)
    expect(angleDeg(normalAt(padded, mid), normalAt(plain, mid))).toBeLessThan(1e-4)
  })

  it('match exactly on an edge shared by two padded tiles (no lighting seams)', () => {
    const build = (dx: number, pad: number) => buildTileMesh(f, 12, x + dx, y, heightsFor(f, 12, x + dx, y, pad), site, TILE_N, pad)
    const worst = (pad: number) => {
      const a = build(0, pad)
      const b = build(1, pad)
      let max = 0
      // a's right column (i = N - 1) is b's left column (i = 0).
      for (let j = 0; j < TILE_N; j++) max = Math.max(max, angleDeg(normalAt(a, j * TILE_N + TILE_N - 1), normalAt(b, j * TILE_N)))
      return max
    }
    expect(worst(1)).toBeLessThan(1e-4)
    expect(worst(0)).toBeGreaterThan(1) // what the unpadded edges looked like
  })

  it('recognises padded and plain tile responses (a backend from before padding sends plain ones)', () => {
    expect(tilePadding(67 * 67)).toBe(1)
    expect(tilePadding(65 * 65)).toBe(0)
    expect(tilePadding(64 * 64)).toBeNull()
    // A plain tile still builds (edges with one-sided normals), so an older backend still shows terrain.
    const m = buildTileMesh(f, 12, x, y, heightsFor(f, 12, x, y, 0), site, TILE_N, tilePadding(TILE_N * TILE_N)!)
    expect(m.positions.length).toBe(tileTopology().vertexCount * 3)
  })

  it('cuts the tile itself out of a padded array', () => {
    const padded = heightsFor(f, 12, x, y, 1)
    expect(innerHeights(padded, TILE_N, 1)).toEqual(heightsFor(f, 12, x, y, 0))
  })
})
