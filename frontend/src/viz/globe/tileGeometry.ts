// Builds the mesh data for one cube-sphere terrain tile, in the site frame.
// Vertices are stored relative to the tile's own centre (float32 stays precise at Moon scale);
// the caller places the mesh at `centre` (kept in float64 by three.js on the CPU).
//
// Normals come from central differences over the height grid. With a padded tile (a ring of the
// neighbours' vertices around it, /api/terrain/tile?pad=1) the normals on a shared edge are
// computed from the same points in both tiles, so the lighting has no seams between tiles.
import { MOON_RADIUS_M, SiteFrame, TILE_N, tileVertexUV, uvToVec, vertexSpacingM, type Vec3 } from './cubeSphere'

export interface TileMeshData {
  centre: Vec3 // site frame, metres
  radius: number // bounding-sphere radius around centre
  positions: Float32Array // (n*n + skirt) * 3, relative to centre
  normals: Float32Array // same layout; skirt vertices copy their edge vertex's normal
  indices: Uint16Array | Uint32Array // shared by every tile of this size (see tileTopology)
  surfaceIndexCount: number // indices.subarray(0, surfaceIndexCount) = surface only (no skirts)
  skirtStart: number // first skirt vertex index
  borderOf: Uint32Array // for each skirt vertex, the grid vertex it hangs from
}

export interface TileTopology {
  border: number[] // grid vertices along the tile border, in loop order
  borderOf: Uint32Array
  indices: Uint16Array | Uint32Array // surface triangles first, then skirt walls
  surfaceIndexCount: number
  vertexCount: number
  uvs: Float32Array // texture coordinates (i, j) / (n - 1); skirts copy their edge vertex
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

const topologies = new Map<number, TileTopology>()

/**
 * Triangles of an n x n tile plus its skirts. Every tile has exactly the same ones, so they are
 * built once and shared (one GPU index buffer for all tiles; 16-bit while the vertices fit).
 * Triangles wind counter-clockwise seen from outside the Moon (right x up = outward); each grid
 * quad is split along its (i, j)-(i+1, j+1) diagonal.
 */
export function tileTopology(n = TILE_N): TileTopology {
  let t = topologies.get(n)
  if (t) return t
  const border = borderLoop(n)
  const vertexCount = n * n + border.length
  const quads = (n - 1) * (n - 1)
  const indices = vertexCount <= 65536 ? new Uint16Array((quads + border.length) * 6) : new Uint32Array((quads + border.length) * 6)
  let k6 = 0
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const k = j * n + i
      indices.set([k, k + 1, k + n + 1, k, k + n + 1, k + n], k6)
      k6 += 6
    }
  }
  const surfaceIndexCount = k6
  // Skirt walls: each border edge (a -> b, going round the tile) to its copy hanging below.
  for (let s = 0; s < border.length; s++) {
    const a = border[s]
    const b = border[(s + 1) % border.length]
    const sa = n * n + s
    const sb = n * n + ((s + 1) % border.length)
    indices.set([a, sa, b, b, sa, sb], k6)
    k6 += 6
  }
  const uvs = new Float32Array(vertexCount * 2)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      uvs[2 * (j * n + i)] = i / (n - 1)
      uvs[2 * (j * n + i) + 1] = j / (n - 1)
    }
  }
  border.forEach((g, s) => {
    uvs[2 * (n * n + s)] = uvs[2 * g]
    uvs[2 * (n * n + s) + 1] = uvs[2 * g + 1]
  })
  t = { border, borderOf: Uint32Array.from(border), indices, surfaceIndexCount, vertexCount, uvs }
  topologies.set(n, t)
  return t
}

/**
 * heights: metres relative to the 1737.4 km sphere, backend order heights[j * m + i], where
 * m = n + 2 * pad: the n x n tile, plus `pad` rings of its neighbours' vertices (0 or 1).
 */
export function buildTileMesh(
  face: number,
  z: number,
  x: number,
  y: number,
  heights: ArrayLike<number>,
  frame: SiteFrame,
  n = TILE_N,
  pad = 0,
): TileMeshData {
  const m = n + 2 * pad
  if (heights.length !== m * m) throw new Error(`tile heights: expected ${m * m} values, got ${heights.length}`)
  const { border, borderOf, indices, surfaceIndexCount, vertexCount } = tileTopology(n)
  const skirtDepth = Math.max(20, vertexSpacingM(z, n) * 4)

  // Site-frame positions of the whole (padded) grid, in float64.
  const grid = new Float64Array(m * m * 3)
  for (let jj = 0; jj < m; jj++) {
    for (let ii = 0; ii < m; ii++) {
      const g = jj * m + ii
      const d = uvToVec(face, ...tileVertexUV(z, x, y, ii - pad, jj - pad, n))
      const r = MOON_RADIUS_M + heights[g]
      const s = frame.toSite([d[0] * r, d[1] * r, d[2] * r])
      grid[3 * g] = s[0]
      grid[3 * g + 1] = s[1]
      grid[3 * g + 2] = s[2]
    }
  }
  const at = (i: number, j: number) => 3 * ((j + pad) * m + (i + pad)) // grid offset of tile vertex (i, j)

  const c = at(n >> 1, n >> 1)
  const centre: Vec3 = [grid[c], grid[c + 1], grid[c + 2]]
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  let radius = 0
  const lo = -pad
  const hi = n - 1 + pad
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = 3 * (j * n + i)
      const p = at(i, j)
      positions[k] = grid[p] - centre[0]
      positions[k + 1] = grid[p + 1] - centre[1]
      positions[k + 2] = grid[p + 2] - centre[2]
      radius = Math.max(radius, Math.hypot(positions[k], positions[k + 1], positions[k + 2]))
      // Normal = (right difference) x (up difference); one-sided where the grid ends.
      const r1 = at(Math.min(hi, i + 1), j)
      const r0 = at(Math.max(lo, i - 1), j)
      const u1 = at(i, Math.min(hi, j + 1))
      const u0 = at(i, Math.max(lo, j - 1))
      const ax = grid[r1] - grid[r0]
      const ay = grid[r1 + 1] - grid[r0 + 1]
      const az = grid[r1 + 2] - grid[r0 + 2]
      const bx = grid[u1] - grid[u0]
      const by = grid[u1 + 1] - grid[u0 + 1]
      const bz = grid[u1 + 2] - grid[u0 + 2]
      const nx = ay * bz - az * by
      const ny = az * bx - ax * bz
      const nz = ax * by - ay * bx
      const len = Math.hypot(nx, ny, nz) || 1
      normals[k] = nx / len
      normals[k + 1] = ny / len
      normals[k + 2] = nz / len
    }
  }

  // Skirts: each border vertex copied skirtDepth straight down (towards the Moon's centre), with
  // its normal (vertical walls would otherwise light up every tile border as a bright line).
  const mc = frame.moonCentre
  for (let s = 0; s < border.length; s++) {
    const g = border[s]
    const p = at(g % n, Math.floor(g / n))
    const dx = grid[p] - mc[0]
    const dy = grid[p + 1] - mc[1]
    const dz = grid[p + 2] - mc[2]
    const f = skirtDepth / Math.hypot(dx, dy, dz)
    const k = 3 * (n * n + s)
    positions[k] = grid[p] - dx * f - centre[0]
    positions[k + 1] = grid[p + 1] - dy * f - centre[1]
    positions[k + 2] = grid[p + 2] - dz * f - centre[2]
    radius = Math.max(radius, Math.hypot(positions[k], positions[k + 1], positions[k + 2]))
    normals[k] = normals[3 * g]
    normals[k + 1] = normals[3 * g + 1]
    normals[k + 2] = normals[3 * g + 2]
  }
  return { centre, radius, positions, normals, indices, surfaceIndexCount, skirtStart: n * n, borderOf }
}

/**
 * How many rings of neighbour vertices a tile response carries, from its number of heights:
 * 1 for a padded tile ((n + 2)^2, /api/terrain/tile?pad=1), 0 for a plain one (n^2: what a backend
 * from before padding sends, since it ignores the parameter), null for anything else.
 */
export function tilePadding(valueCount: number, n = TILE_N): 0 | 1 | null {
  if (valueCount === (n + 2) * (n + 2)) return 1
  if (valueCount === n * n) return 0
  return null
}

/** The tile's own n x n heights out of a padded array (for ground-height lookups). */
export function innerHeights(heights: Float32Array, n = TILE_N, pad = 0): Float32Array {
  if (!pad) return heights
  const m = n + 2 * pad
  const out = new Float32Array(n * n)
  for (let j = 0; j < n; j++) out.set(heights.subarray((j + pad) * m + pad, (j + pad) * m + pad + n), j * n)
  return out
}
