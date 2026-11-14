import { describe, expect, it } from 'vitest'
import {
  FACES,
  MOON_RADIUS_M,
  SiteFrame,
  latLonToVec,
  tileAt,
  tileVertexUV,
  uvToVec,
  vecToLatLon,
  vertexSpacingM,
  type Vec3,
} from './cubeSphere'

const vertexLatLon = (face: number, z: number, x: number, y: number, i: number, j: number) =>
  vecToLatLon(uvToVec(face, ...tileVertexUV(z, x, y, i, j)))

// Reference values from backend/app/engine/tiles.py::tile_latlon (the two must agree exactly).
const BACKEND: [number, number, number, number, number, number, number, number][] = [
  // face, z, x, y, j, i, lat, lon
  [5, 3, 2, 5, 0, 0, -65.321283018, 295.651106939],
  [5, 3, 2, 5, 0, 64, -74.288464897, 315.0],
  [5, 3, 2, 5, 64, 0, -59.638806595, 315.0],
  [5, 3, 2, 5, 32, 17, -64.992965607, 310.565777925],
  [0, 2, 1, 3, 0, 0, 20.941020472, 337.5],
  [0, 2, 1, 3, 32, 17, 32.643022549, 343.4765625],
  [1, 4, 9, 0, 0, 64, -44.444216484, 101.25],
  [1, 4, 9, 0, 32, 17, -41.966939428, 97.119140625],
]

describe('cube sphere matches the backend', () => {
  it.each(BACKEND)('face %i z%i (%i,%i) vertex j%i i%i', (face, z, x, y, j, i, lat, lon) => {
    const [la, lo] = vertexLatLon(face, z, x, y, i, j)
    expect(la).toBeCloseTo(lat, 7)
    expect(((lo - lon + 540) % 360) - 180).toBeCloseTo(0, 7)
  })

  it('finds the same tile for a point', () => {
    expect(tileAt(-89.53432, 209.94767, 10)).toEqual([5, 509, 507])
    expect(tileAt(0.67, 23.47, 6)).toEqual([0, 48, 32])
    expect(tileAt(45.0, 300.0, 4)).toEqual([4, 0, 3])
  })
})

describe('cube sphere geometry', () => {
  it('has orthonormal faces with the poles at face centres', () => {
    for (const [c, r, u] of FACES) {
      const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      expect(dot(c, r)).toBe(0)
      expect(dot(c, u)).toBe(0)
      expect(dot(r, u)).toBe(0)
    }
    expect(vecToLatLon(uvToVec(5, 0, 0))[0]).toBeCloseTo(-90, 9)
    expect(vecToLatLon(uvToVec(4, 0, 0))[0]).toBeCloseTo(90, 9)
  })

  it('round-trips lat/lon', () => {
    const [lat, lon] = vecToLatLon(latLonToVec(-89.53432, 209.94767))
    expect(lat).toBeCloseTo(-89.53432, 9)
    expect(lon).toBeCloseTo(209.94767, 9)
  })

  it('gives ~5 m vertices at the deepest level', () => {
    expect(vertexSpacingM(13)).toBeCloseTo(5.2, 1)
  })
})

describe('SiteFrame', () => {
  const site = new SiteFrame(-89.53432, 209.94767, 1654)

  it('puts the site at the origin and the Moon centre straight down', () => {
    const r = MOON_RADIUS_M + 1654
    const atSite = site.toSite([site.up[0] * r, site.up[1] * r, site.up[2] * r])
    atSite.forEach((v) => expect(v).toBeCloseTo(0, 6))
    const c = site.moonCentre
    expect(c[0]).toBeCloseTo(0, 6)
    expect(c[1]).toBeCloseTo(-r, 6)
    expect(c[2]).toBeCloseTo(0, 6)
  })

  it('maps local east and north onto +x and -z', () => {
    const r = MOON_RADIUS_M + 1654
    // A point a little further from the pole (north) and a little east, on the sphere.
    const north = site.toSite(latLonToVec(-89.53432 + 0.01, 209.94767).map((v) => v * r) as Vec3)
    expect(north[2]).toBeLessThan(0) // north = -z
    expect(Math.abs(north[0])).toBeLessThan(1e-6 * r)
    const east = site.toSite(latLonToVec(-89.53432, 209.94767 + 0.5).map((v) => v * r) as Vec3)
    expect(east[0]).toBeGreaterThan(0)
    expect(east[1]).toBeLessThan(0) // curvature: neighbours dip below the site's horizontal
  })

  it('inverts', () => {
    const p: Vec3 = [1234.5, -987.25, 4321]
    const back = site.toSite(site.toMoon(p))
    back.forEach((v, k) => expect(v).toBeCloseTo(p[k], 6))
  })
})
