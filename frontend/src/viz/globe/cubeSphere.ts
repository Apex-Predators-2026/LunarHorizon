// Cube-sphere tiling of the whole Moon. MUST match backend/app/engine/tiles.py exactly
// (same FACES table, equal-angle mapping, vertex order heights[j * N + i]).
//
// Moon-fixed frame (Mean-Earth, like Horizons/LOLA): x -> (lat 0, lon 0), y -> (lat 0, lon 90E),
// z -> north pole. Rendering happens in the site frame used by the rest of the 3D view:
// origin at the site's ground point, x = east, y = up (radial), z = -north.

export const MOON_RADIUS_M = 1_737_400
export const TILE_N = 65
export const MAX_ZOOM = 13
export const FACE_EDGE_M = (Math.PI / 2) * MOON_RADIUS_M

export type Vec3 = [number, number, number]

// [centre, right, up] for each face.
export const FACES: [Vec3, Vec3, Vec3][] = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]], // 0: +X (lat 0, lon 0)
  [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], // 1: +Y (lon 90E)
  [[-1, 0, 0], [0, -1, 0], [0, 0, 1]], // 2: -X (lon 180)
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]], // 3: -Y (lon 90W)
  [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], // 4: +Z (north pole)
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]], // 5: -Z (south pole)
]

const DEG = Math.PI / 180

/** Unit vector for face coordinates u, v in [-1, 1] (equal-angle mapping). */
export function uvToVec(face: number, u: number, v: number): Vec3 {
  const [c, r, up] = FACES[face]
  const tu = Math.tan((u * Math.PI) / 4)
  const tv = Math.tan((v * Math.PI) / 4)
  const x = c[0] + tu * r[0] + tv * up[0]
  const y = c[1] + tu * r[1] + tv * up[1]
  const z = c[2] + tu * r[2] + tv * up[2]
  const n = Math.hypot(x, y, z)
  return [x / n, y / n, z / n]
}

export function latLonToVec(latDeg: number, lonDeg: number): Vec3 {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
}

export function vecToLatLon(p: Vec3): [number, number] {
  const n = Math.hypot(p[0], p[1], p[2])
  const lat = Math.asin(Math.max(-1, Math.min(1, p[2] / n))) / DEG
  const lon = ((Math.atan2(p[1], p[0]) / DEG) % 360 + 360) % 360
  return [lat, lon]
}

/** Face coordinates of a tile's vertex (i, j), each in 0..n-1. */
export function tileVertexUV(z: number, x: number, y: number, i: number, j: number, n = TILE_N): [number, number] {
  const size = 2 / 2 ** z
  return [-1 + size * (x + i / (n - 1)), -1 + size * (y + j / (n - 1))]
}

/** (face, x, y) of the level-z tile containing a lat/lon (inverse of the mapping). */
export function tileAt(latDeg: number, lonDeg: number, z: number): [number, number, number] {
  const [face, u, v] = vecToFaceUV(latLonToVec(latDeg, lonDeg))
  const n = 2 ** z
  return [face, Math.min(n - 1, Math.floor(((u + 1) / 2) * n)), Math.min(n - 1, Math.floor(((v + 1) / 2) * n))]
}

/** Face and face coordinates u, v in [-1, 1] of a direction (any length; inverse of uvToVec). */
export function vecToFaceUV(p: Vec3): [number, number, number] {
  let face = 0
  let best = -Infinity
  FACES.forEach(([c], f) => {
    const d = c[0] * p[0] + c[1] * p[1] + c[2] * p[2]
    if (d > best) {
      best = d
      face = f
    }
  })
  const [c, r, up] = FACES[face]
  const k = 1 / (c[0] * p[0] + c[1] * p[1] + c[2] * p[2]) // project onto the face plane
  const u = (Math.atan(k * (r[0] * p[0] + r[1] * p[1] + r[2] * p[2])) * 4) / Math.PI
  const v = (Math.atan(k * (up[0] * p[0] + up[1] * p[1] + up[2] * p[2])) * 4) / Math.PI
  return [face, u, v]
}

export const vertexSpacingM = (z: number, n = TILE_N) => FACE_EDGE_M / 2 ** z / (n - 1)

/**
 * Converts Moon-fixed positions (metres) into the site frame: origin at the site's ground point
 * (radius R + groundHeight), x = east, y = up, z = -north. Same axes as azElToVector.
 */
export class SiteFrame {
  readonly latDeg: number
  readonly lonDeg: number
  readonly groundHeightM: number
  readonly origin: Vec3
  readonly east: Vec3
  readonly north: Vec3
  readonly up: Vec3

  constructor(latDeg: number, lonDeg: number, groundHeightM: number) {
    this.latDeg = latDeg
    this.lonDeg = lonDeg
    this.groundHeightM = groundHeightM
    const lat = latDeg * DEG
    const lon = lonDeg * DEG
    this.up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
    this.east = [-Math.sin(lon), Math.cos(lon), 0]
    this.north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)]
    const r = MOON_RADIUS_M + groundHeightM
    this.origin = [this.up[0] * r, this.up[1] * r, this.up[2] * r]
  }

  /** Moon-fixed point (metres) -> site frame [x east, y up, z -north]. */
  toSite(p: Vec3): Vec3 {
    const d0 = p[0] - this.origin[0]
    const d1 = p[1] - this.origin[1]
    const d2 = p[2] - this.origin[2]
    const { east: e, north: n, up: u } = this
    return [d0 * e[0] + d1 * e[1] + d2 * e[2], d0 * u[0] + d1 * u[1] + d2 * u[2], -(d0 * n[0] + d1 * n[1] + d2 * n[2])]
  }

  /** Site frame -> Moon-fixed point (metres). */
  toMoon(s: Vec3): Vec3 {
    const { east: e, north: n, up: u, origin: o } = this
    return [
      o[0] + s[0] * e[0] + s[1] * u[0] - s[2] * n[0],
      o[1] + s[0] * e[1] + s[1] * u[1] - s[2] * n[1],
      o[2] + s[0] * e[2] + s[1] * u[2] - s[2] * n[2],
    ]
  }

  /** The Moon's centre in the site frame. */
  get moonCentre(): Vec3 {
    return this.toSite([0, 0, 0])
  }
}
