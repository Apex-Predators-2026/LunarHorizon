import { describe, expect, it } from 'vitest'
import { latLonToVec, MOON_RADIUS_M, uvToVec } from './cubeSphere'
import { angleBetween, faceSampler, MIN_MAP_RADIUS, mapViewFor, project, renderMap, unproject, type MapView } from './miniMap'

const hemisphere = (lat: number, lon: number): MapView => ({ lat, lon, radius: Math.PI / 2 })

describe('minimap projection (orthographic, north up)', () => {
  it('puts the centre in the middle, north up and east right', () => {
    const m = hemisphere(0, 0)
    expect(project(m, [0, 0])).toMatchObject({ x: 0, y: 0, shown: true })
    const north = project(m, [30, 0])
    expect(north.x).toBeCloseTo(0, 9)
    expect(north.y).toBeCloseTo(0.5, 9) // sin 30
    expect(project(m, [0, 30]).x).toBeCloseTo(0.5, 9) // east is right
    expect(project(m, [0, 180]).shown).toBe(false) // far side
  })

  it('round-trips map coordinates and lat/lon, also at the south pole', () => {
    for (const m of [hemisphere(-89.5, 150), { lat: -70, lon: 20, radius: 0.2 }, hemisphere(10, 300)]) {
      for (const [x, y] of [[0, 0], [0.3, -0.4], [-0.7, 0.2], [0.05, 0.9]]) {
        const ll = unproject(m, x, y)!
        const back = project(m, ll)
        expect(back.x).toBeCloseTo(x, 9)
        expect(back.y).toBeCloseTo(y, 9)
        expect(back.shown).toBe(true)
      }
    }
    expect(unproject(hemisphere(-89.5, 150), 0.9, 0.9)).toBeNull() // the corner of the whole-hemisphere map: space
    expect(unproject({ lat: -70, lon: 20, radius: 0.2 }, 0.9, 0.9)).not.toBeNull() // zoomed in: Moon all over
  })

  it('zooms: a smaller radius spreads the same points further out', () => {
    const wide = project(hemisphere(-80, 0), [-79, 0])
    const close = project({ lat: -80, lon: 0, radius: 0.1 }, [-79, 0])
    expect(close.y / wide.y).toBeCloseTo(1 / Math.sin(0.1), 6)
  })
})

describe('minimap zoom from the camera view', () => {
  it('shows a few times the footprint around the view centre', () => {
    const v = mapViewFor({ centre: [-80, 10], footprint: [[-79, 10], [-80, 15], [-81, 10], [-80, 5]] })
    expect(v.lat).toBe(-80)
    expect(v.lon).toBe(10)
    const reach = angleBetween([-80, 10], [-79, 10]) // the furthest footprint point is ~1 deg away
    expect(v.radius).toBeGreaterThan(3 * reach)
    expect(v.radius).toBeLessThan(5 * reach)
  })

  it('never closer than MIN_MAP_RADIUS (the imagery would be blur) nor wider than a hemisphere', () => {
    const tiny = mapViewFor({ centre: [-89.5, 0], footprint: [[-89.49, 0], [-89.5, 0.1], [-89.51, 0]] })
    expect(tiny.radius).toBe(MIN_MAP_RADIUS)
    expect(MIN_MAP_RADIUS * MOON_RADIUS_M).toBeCloseTo(150_000, -2)
    const sky = mapViewFor({ centre: [0, 0], footprint: [] }) // looking past the Moon
    expect(sky.radius).toBe(Math.PI / 2)
  })
})

describe('minimap imagery', () => {
  it('samples each cube face at the right place (face images: row 0 = top, v = 1)', () => {
    const size = 4
    // Face f is filled with value 10 * f, except its top-left pixel (u = -1, v = 1) which is 200 + f.
    const faces = Array.from({ length: 6 }, (_, f) => {
      const img = new Uint8ClampedArray(size * size).fill(10 * f)
      img[0] = 200 + f
      return img
    })
    const sample = faceSampler(faces, size)
    for (let f = 0; f < 6; f++) {
      expect(sample(uvToVec(f, 0.1, -0.1))).toBeCloseTo(10 * f, 6) // middle of the face
      expect(sample(uvToVec(f, -0.95, 0.95))).toBeCloseTo(200 + f, 6) // its top-left corner
    }
  })

  it('draws the Moon as a disc, transparent around it, dark on the night side', () => {
    const px = 32
    const out = new Uint8ClampedArray(px * px * 4)
    const sun = latLonToVec(0, 90) // the Sun over lon 90E: east of the map's centre lit, west dark
    renderMap(out, px, hemisphere(0, 0), () => 100, sun)
    const at = (i: number, j: number) => out[(j * px + i) * 4]
    const alpha = (i: number, j: number) => out[(j * px + i) * 4 + 3]
    expect(alpha(0, 0)).toBe(0) // corner: space
    expect(alpha(16, 16)).toBe(255)
    expect(at(28, 16)).toBeGreaterThan(3 * at(3, 16)) // day (east) vs night (west)
  })
})
