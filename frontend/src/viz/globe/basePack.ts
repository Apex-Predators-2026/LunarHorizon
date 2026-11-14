// The ready-made first view: the coarsest terrain tiles of the whole Moon in one static file
// (public/terrain/base.bin, built by backend/scripts/build_base_pack.py). TileTree uses these
// instead of asking the backend, so the globe appears as soon as the page loads; finer tiles
// stream as usual. Format: see the script.
import { TILE_N } from './cubeSphere'

export interface BaseTile {
  heights: Float32Array // padded ((TILE_N + 2)^2), like /api/terrain/tile?pad=1
  leaf: boolean
}

/** Parse the pack into tiles keyed "face/z/x/y" (TileTree's keys). */
export function parseBasePack(buf: ArrayBuffer): Map<string, BaseTile> {
  const v = new DataView(buf)
  const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))
  if (magic !== 'LBP1') throw new Error('not a terrain base pack')
  const side = v.getUint16(4, true)
  const count = v.getUint16(6, true)
  if (side !== TILE_N + 2) throw new Error(`base pack tiles are ${side} wide, expected ${TILE_N + 2}`)
  const tiles = new Map<string, BaseTile>()
  let o = 8
  for (let t = 0; t < count; t++) {
    const face = v.getUint8(o)
    const z = v.getUint8(o + 1)
    const x = v.getUint16(o + 2, true)
    const y = v.getUint16(o + 4, true)
    const leaf = v.getUint8(o + 6) === 1
    o += 8
    const heights = new Float32Array(side * side)
    for (let k = 0; k < heights.length; k++) heights[k] = v.getInt16(o + 2 * k, true)
    o += 2 * heights.length
    tiles.set(`${face}/${z}/${x}/${y}`, { heights, leaf })
  }
  return tiles
}

let pack: Promise<Map<string, BaseTile> | null> | null = null

/** The pack, downloaded once (null if it's missing or broken: the tiles then come from the backend). */
export function basePack(): Promise<Map<string, BaseTile> | null> {
  pack ??= fetch(`${import.meta.env.BASE_URL}terrain/base.bin`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(parseBasePack)
    .catch((e: unknown) => {
      console.warn('Terrain base pack unavailable; loading the coarse globe from the backend instead.', e)
      return null
    })
  return pack
}
