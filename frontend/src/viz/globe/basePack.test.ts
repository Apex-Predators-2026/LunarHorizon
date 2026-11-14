import { describe, expect, it } from 'vitest'
import { parseBasePack } from './basePack'
import { TILE_N } from './cubeSphere'

// Node's fs without pulling Node types into the app build (tsconfig.app only has vite/client).
const nodeFs = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: URL): Uint8Array<ArrayBuffer> }

describe('terrain base pack (the ready-made first view)', () => {
  const file = readFileSync(new URL('../../../public/terrain/base.bin', import.meta.url))
  const tiles = parseBasePack(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength))

  it('holds every tile of levels 0-2 for all 6 faces, keyed like TileTree', () => {
    expect(tiles.size).toBe(6 * (1 + 4 + 16))
    for (let f = 0; f < 6; f++) for (const z of [0, 1, 2]) expect(tiles.has(`${f}/${z}/${2 ** z - 1}/0`)).toBe(true)
  })

  it('has padded height grids with plausible lunar heights', () => {
    for (const t of tiles.values()) {
      expect(t.heights.length).toBe((TILE_N + 2) ** 2)
      for (const h of [t.heights[0], t.heights[t.heights.length >> 1], t.heights[t.heights.length - 1]]) {
        expect(h).toBeGreaterThan(-10_000) // the Moon spans about -9.1 km to +10.8 km
        expect(h).toBeLessThan(11_000)
      }
      expect(t.leaf).toBe(false) // finer data exists everywhere
    }
  })

  it('rejects files that are not a base pack', () => {
    expect(() => parseBasePack(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]).buffer)).toThrow(/base pack/)
  })
})
