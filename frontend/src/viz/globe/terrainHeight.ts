// Ground height under a point, from whichever terrain tiles are loaded. Used to keep the camera
// from going through the terrain (TileTree lifts it after the orbit controls move it).
import { MAX_ZOOM, MOON_RADIUS_M, TILE_N, vecToFaceUV, type SiteFrame, type Vec3 } from './cubeSphere'

/** Above this height (m over the 1737.4 km sphere) there is no terrain anywhere (highest point ~ +10.8 km). */
export const MAX_RELIEF_M = 11_000

/** Heights of a loaded tile (heights[j * n + i]), or undefined if it isn't loaded. */
export type TileHeights = (face: number, z: number, x: number, y: number) => ArrayLike<number> | undefined

/**
 * Height on a tile's drawn surface at fractional vertex coordinates (fi, fj), each in 0..n-1.
 * Uses the same two triangles per quad as tileGeometry, split along (i, j)-(i+1, j+1), so it matches
 * what is on screen, not a smoothed bilinear surface.
 */
export function tileSurfaceHeight(heights: ArrayLike<number>, fi: number, fj: number, n = TILE_N): number {
  const i = Math.min(n - 2, Math.max(0, Math.floor(fi)))
  const j = Math.min(n - 2, Math.max(0, Math.floor(fj)))
  const a = Math.min(1, Math.max(0, fi - i))
  const b = Math.min(1, Math.max(0, fj - j))
  const k = j * n + i
  const h00 = heights[k]
  const h10 = heights[k + 1]
  const h01 = heights[k + n]
  const h11 = heights[k + n + 1]
  return a >= b ? h00 + a * (h10 - h00) + b * (h11 - h10) : h00 + b * (h01 - h00) + a * (h11 - h01)
}

/** Terrain height (m over the sphere) in a Moon-fixed direction, from the finest loaded tile; null if none is. */
export function groundHeightAt(dir: Vec3, tiles: TileHeights, maxZoom = MAX_ZOOM, n = TILE_N): number | null {
  const [face, u, v] = vecToFaceUV(dir)
  for (let z = maxZoom; z >= 0; z--) {
    const s = 2 ** z
    const gu = ((u + 1) / 2) * s
    const gv = ((v + 1) / 2) * s
    const x = Math.min(s - 1, Math.floor(gu))
    const y = Math.min(s - 1, Math.floor(gv))
    const h = tiles(face, z, x, y)
    if (h) return tileSurfaceHeight(h, (gu - x) * (n - 1), (gv - y) * (n - 1), n)
  }
  return null
}

/**
 * A site-frame position moved straight up (away from the Moon's centre) so that it is at least
 * `clearanceM` above the ground, or null when it already is (or no terrain is loaded under it).
 */
export function liftAboveGround(p: Vec3, frame: SiteFrame, tiles: TileHeights, clearanceM: number): Vec3 | null {
  const m = frame.toMoon(p)
  const r = Math.hypot(m[0], m[1], m[2])
  if (r === 0 || r > MOON_RADIUS_M + MAX_RELIEF_M + clearanceM) return null // clear of any terrain
  const h = groundHeightAt(m, tiles)
  if (h === null) return null
  const minR = MOON_RADIUS_M + h + clearanceM
  if (r >= minR) return null
  const k = minR / r
  return frame.toSite([m[0] * k, m[1] * k, m[2] * k])
}
