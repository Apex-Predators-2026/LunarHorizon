// The whole-Moon minimap (MoonMiniMap.tsx): an orthographic globe, north up, centred on what the 3D
// camera is looking at and zoomed to show a few times the camera's footprint (the whole hemisphere when
// far out). The surface comes from the LRO imagery pack (imageryPack.ts), shaded by the Sun at the
// selected time. Pure maths here (unit-tested); MiniMapTracker.tsx publishes the camera's view.
import { create } from 'zustand'
import { latLonToVec, MOON_RADIUS_M, vecToFaceUV, vecToLatLon, type Vec3 } from './cubeSphere'

export type LatLon = [number, number] // degrees, lon east 0..360 or -180..180

/** What the 3D camera shows, in lat/lon (published by MiniMapTracker, ~10 times a second at most). */
export interface CameraView {
  centre: LatLon // the surface point in the middle of the view (else the one below the camera)
  footprint: LatLon[] // surface points under the edges of the view, in order (only those on the Moon)
}
export const useCameraView = create<{ view: CameraView | null }>(() => ({ view: null }))

/** The map's centre and how far from it it reaches (angle at the Moon's centre, radians). */
export interface MapView {
  lat: number
  lon: number
  radius: number // up to PI/2: the whole hemisphere
}

const DEG = Math.PI / 180
/** The map shows at least this much around its centre (finer than the pack's imagery is just blur). */
export const MIN_MAP_RADIUS = 150_000 / MOON_RADIUS_M
/** ... and about this many times the camera's footprint. */
const FOOTPRINT_MARGIN = 3.5

/** Angle between two surface points (radians). */
export function angleBetween(a: LatLon, b: LatLon): number {
  const p = latLonToVec(a[0], a[1])
  const q = latLonToVec(b[0], b[1])
  return Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])))
}

/** The map for a camera view: centred on it, zoomed to a few times its footprint. */
export function mapViewFor(view: CameraView): MapView {
  let reach = 0
  for (const p of view.footprint) reach = Math.max(reach, angleBetween(view.centre, p))
  if (view.footprint.length < 3) reach = Math.PI / 2 // looking at the sky: just show the hemisphere
  return { lat: view.centre[0], lon: view.centre[1], radius: Math.min(Math.PI / 2, Math.max(MIN_MAP_RADIUS, reach * FOOTPRINT_MARGIN)) }
}

/** East / north / up (outwards) unit vectors at the map's centre (Moon-fixed). */
function basis(m: MapView): { e: Vec3; n: Vec3; c: Vec3 } {
  const lat = m.lat * DEG
  const lon = m.lon * DEG
  return {
    c: [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)],
    e: [-Math.sin(lon), Math.cos(lon), 0],
    n: [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)],
  }
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * Map coordinates of a lat/lon: x right (east at the centre), y up (north), the map's rim at radius 1.
 * `shown`: on the near side and inside the (square) map. Zoomed in, the Moon fills the whole square.
 */
export function project(m: MapView, ll: LatLon): { x: number; y: number; shown: boolean } {
  const { e, n, c } = basis(m)
  const p = latLonToVec(ll[0], ll[1])
  const s = Math.sin(m.radius)
  const x = dot(p, e) / s
  const y = dot(p, n) / s
  return { x, y, shown: dot(p, c) >= 0 && Math.abs(x) <= 1 + 1e-9 && Math.abs(y) <= 1 + 1e-9 }
}

/** The lat/lon under map coordinates (x right, y up, rim at 1), or null off the Moon. */
export function unproject(m: MapView, x: number, y: number): LatLon | null {
  const s = Math.sin(m.radius)
  const px = x * s
  const py = y * s
  const r2 = px * px + py * py
  if (r2 > 1) return null
  const { e, n, c } = basis(m)
  const h = Math.sqrt(1 - r2)
  return vecToLatLon([px * e[0] + py * n[0] + h * c[0], px * e[1] + py * n[1] + h * c[1], px * e[2] + py * n[2] + h * c[2]])
}

/**
 * Brightness (0-255) of the imagery at a direction, from whole-face greyscale images (`size` square,
 * row 0 = the face's top, v = 1; bilinear).
 */
export function faceSampler(faces: Uint8ClampedArray[], size: number) {
  return (p: Vec3): number => {
    const [f, u, v] = vecToFaceUV(p)
    const img = faces[f]
    const fx = Math.min(size - 1, Math.max(0, ((u + 1) / 2) * size - 0.5))
    const fy = Math.min(size - 1, Math.max(0, (1 - (v + 1) / 2) * size - 0.5))
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const x1 = Math.min(size - 1, x0 + 1)
    const y1 = Math.min(size - 1, y0 + 1)
    const tx = fx - x0
    const ty = fy - y0
    const a = img[y0 * size + x0] * (1 - tx) + img[y0 * size + x1] * tx
    const b = img[y1 * size + x0] * (1 - tx) + img[y1 * size + x1] * tx
    return a * (1 - ty) + b * ty
  }
}

// Mosaic bytes are dim display values (mean ~40/255): brightened like the 3D view's imagery.
const GAIN = 2.2
const NIGHT = 0.16 // the night side stays faintly visible

/**
 * Draw the map into an RGBA buffer (`px` square): the imagery, lit by `sun` (Moon-fixed unit vector
 * towards the Sun; null = no shading), transparent off the Moon.
 */
export function renderMap(out: Uint8ClampedArray, px: number, m: MapView, sample: (p: Vec3) => number, sun: Vec3 | null) {
  const { e, n, c } = basis(m)
  const s = Math.sin(m.radius)
  const p: Vec3 = [0, 0, 0]
  for (let j = 0; j < px; j++) {
    const y = (1 - ((j + 0.5) / px) * 2) * s
    for (let i = 0; i < px; i++) {
      const x = (((i + 0.5) / px) * 2 - 1) * s
      const k = (j * px + i) * 4
      const r2 = x * x + y * y
      if (r2 > 1) {
        out[k + 3] = 0
        continue
      }
      const h = Math.sqrt(1 - r2)
      p[0] = x * e[0] + y * n[0] + h * c[0]
      p[1] = x * e[1] + y * n[1] + h * c[1]
      p[2] = x * e[2] + y * n[2] + h * c[2]
      let light = 1
      if (sun) {
        const d = dot(p, sun)
        const t = Math.max(0, Math.min(1, (d + 0.04) / 0.3)) // soft terminator
        light = NIGHT + (1 - NIGHT) * t * t * (3 - 2 * t)
      }
      const g = Math.min(255, sample(p) * GAIN * light)
      out[k] = g
      out[k + 1] = g
      out[k + 2] = Math.min(255, g * 1.04) // a touch cool, like the 3D view
      out[k + 3] = 255
    }
  }
}
