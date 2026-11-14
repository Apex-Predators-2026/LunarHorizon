import { describe, expect, it } from 'vitest'
import { parseImageryPack } from './imageryPack'

// Node's fs without pulling Node types into the app build (tsconfig.app only has vite/client).
const nodeFs = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: URL): Uint8Array<ArrayBuffer> }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe('imagery base pack (the ready-made zoomed-out look)', () => {
  const file = readFileSync(new URL('../../../public/imagery/base.bin', import.meta.url))
  const tiles = parseImageryPack(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength))

  it('holds every tile of levels 0-2 for all 6 faces, keyed like TileTree', () => {
    expect(tiles.size).toBe(6 * (1 + 4 + 16))
    for (let f = 0; f < 6; f++) for (const z of [0, 1, 2]) expect(tiles.has(`${f}/${z}/${2 ** z - 1}/0`)).toBe(true)
  })

  it('holds 128 px greyscale PNGs', () => {
    for (const png of tiles.values()) {
      expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE)
      const ihdr = new DataView(png.buffer, png.byteOffset + 16, 10)
      expect([ihdr.getUint32(0), ihdr.getUint32(4), ihdr.getUint8(8), ihdr.getUint8(9)]).toEqual([128, 128, 8, 0])
    }
  })

  it('rejects files that are not an imagery pack, or are cut short', () => {
    expect(() => parseImageryPack(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]).buffer)).toThrow(/imagery base pack/)
    const cut = new Uint8Array([0x4c, 0x49, 0x50, 0x31, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 0, 0, 0])
    expect(() => parseImageryPack(cut.buffer)).toThrow(/truncated/)
  })
})
