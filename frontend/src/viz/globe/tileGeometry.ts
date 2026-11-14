// Builds the mesh data for one cube-sphere terrain tile, in the site frame.
// Vertices are stored relative to the tile's own centre (float32 stays precise at Moon scale);
// the caller places the mesh at `centre` (kept in float64 by three.js on the CPU).
import { MOON_RADIUS_M, SiteFrame, TILE_N, tileVertexUV, uvToVec, vertexSpacingM, type Vec3 } from './cubeSphere'

export interface TileMeshData {
  centre: Vec3 // site frame, metres
  radius: number // bounding-sphere radius around centre
  positions: Float32Array // (n*n + skirt) * 3, relative to centre
  indices: Uint32Array // surface triangles first, then skirt walls
  surfaceIndexCount: number // indices.subarray(0, surfaceIndexCount) = surface only (for normals)
  skirtStart: number // first skirt vertex index (skirts copy the normals of their edge vertex)
  borderOf: Uint32Array // for each skirt vertex, the grid vertex it hangs from
}

/** Grid vertices along the tile border, in loop order (bottom, right, top, left). */
function borderLoop(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n - 1; i++) out.push(i) // bottom row (j = 0)
  for (let j = 0; j < n - 1; j++) out.push(j * n + (n - 1)) // right column
  for (let i = n - 1; i > 0; i--) out.push((n - 1) * n + i) // top row
  for (let j = n - 1; j > 0; j--) out.push(j * n) // left column
  return out
}

/**
 * heights: n*n metres relative to the 1737.4 km sphere, heights[j*n+i] (backend order).
 * Triangles wind counter-clockwise seen from outside the Moon (right x up = outward).
 */
export function buildTileMesh(
  face: number,
  z: number,
  x: number,
  y: number,
  heights: ArrayLike<number>,
  frame: SiteFrame,
  n = TILE_N,
): TileMeshData {
  const skirtDepth = Math.max(20, vertexSpacingM(z, n) * 4)
  const border = borderLoop(n)
  const total = n * n + border.length
  const site = new Float64Array(total * 3)

  const put = (k: number, dir: Vec3, h: number) => {
    const r = MOON_RADIUS_M + h
    const s = frame.toSite([dir[0] * r, dir[1] * r, dir[2] * r])
    site[3 * k] = s[0]
    site[3 * k + 1] = s[1]
    site[3 * k + 2] = s[2]
  }
  const dirs: Vec3[] = new Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      dirs[k] = uvToVec(face, ...tileVertexUV(z, x, y, i, j, n))
      put(k, dirs[k], heights[k])
    }
  }
  const borderOf = new Uint32Array(border.length)
  border.forEach((g, s) => {
    borderOf[s] = g
    put(n * n + s, dirs[g], heights[g] - skirtDepth)
  })

  const c = (n >> 1) * n + (n >> 1)
  const centre: Vec3 = [site[3 * c], site[3 * c + 1], site[3 * c + 2]]
  const positions = new Float32Array(total * 3)
  let radius = 0
  for (let k = 0; k < total; k++) {
    const dx = site[3 * k] - centre[0]
    const dy = site[3 * k + 1] - centre[1]
    const dz = site[3 * k + 2] - centre[2]
    positions[3 * k] = dx
    positions[3 * k + 1] = dy
    positions[3 * k + 2] = dz
    radius = Math.max(radius, Math.hypot(dx, dy, dz))
  }

  const quads = (n - 1) * (n - 1)
  const indices = new Uint32Array((quads + border.length) * 6)
  let t = 0
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const k = j * n + i
      indices.set([k, k + 1, k + n + 1, k, k + n + 1, k + n], t)
      t += 6
    }
  }
  const surfaceIndexCount = t
  // Skirt walls: each border edge (a -> b, going round the tile) to its copy hanging below.
  for (let s = 0; s < border.length; s++) {
    const a = border[s]
    const b = border[(s + 1) % border.length]
    const sa = n * n + s
    const sb = n * n + ((s + 1) % border.length)
    indices.set([a, sa, b, b, sa, sb], t)
    t += 6
  }
  return { centre, radius, positions, indices, surfaceIndexCount, skirtStart: n * n, borderOf }
}
