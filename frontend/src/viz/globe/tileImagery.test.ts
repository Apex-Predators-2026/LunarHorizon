import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  IMAGERY_FADE_END_M,
  IMAGERY_FADE_START_M,
  IMAGERY_PREFETCH_M,
  imageryMix,
  imageryWanted,
  TileImagery,
} from './tileImagery'

describe('imagery fade by altitude (live terrain close up, photo mosaic zoomed out)', () => {
  it('is plain terrain in the Site and Region views, mostly the mosaic in the Globe view, all of it zoomed right out', () => {
    expect(imageryMix(3_000)).toBe(0) // Site, ~3 km up
    expect(imageryMix(420_000)).toBe(0) // Region, ~420 km up
    expect(imageryMix(1_000_000)).toBe(0) // the fade starts late
    const globe = imageryMix(4_260_000) // Globe, ~4,260 km up
    expect(globe).toBeGreaterThan(0.7)
    expect(globe).toBeLessThan(0.9)
    expect(imageryMix(7_800_000)).toBe(1) // reachable: the zoom-out limit is 8,000 km
  })

  it('fades continuously and only one way across the band', () => {
    expect(imageryMix(IMAGERY_FADE_START_M)).toBe(0)
    expect(imageryMix(IMAGERY_FADE_END_M)).toBe(1)
    let prev = 0
    for (let a = IMAGERY_FADE_START_M; a <= IMAGERY_FADE_END_M; a *= 1.01) {
      const m = imageryMix(a)
      expect(m).toBeGreaterThanOrEqual(prev)
      expect(m - prev).toBeLessThan(0.03) // no jumps
      prev = m
    }
    const mid = Math.sqrt(IMAGERY_FADE_START_M * IMAGERY_FADE_END_M) // halfway in log altitude
    expect(imageryMix(mid)).toBeCloseTo(0.5, 5)
  })

  it('loads images a little before they start to show, and none close up', () => {
    expect(IMAGERY_PREFETCH_M).toBeLessThan(IMAGERY_FADE_START_M)
    expect(imageryWanted(IMAGERY_PREFETCH_M + 1)).toBe(true)
    expect(imageryWanted(IMAGERY_PREFETCH_M - 1)).toBe(false)
    expect(imageryWanted(3_000)).toBe(false)
  })
})

describe('the fade band', () => {
  it('spans a long stretch of zooming (7.5x in altitude)', () => {
    expect(IMAGERY_FADE_END_M / IMAGERY_FADE_START_M).toBeGreaterThanOrEqual(7)
  })
})

// TileImagery's internals, to put images in place without downloading anything.
type Internals = {
  textures: Map<string, { state: string; texture: THREE.Texture | null; lastUsed: number; readyAt: number }>
  materials: Map<string, { mix: { value: number }; texKey: string }>
}
const internals = (im: TileImagery) => im as unknown as Internals
const ready = (im: TileImagery, texKey: string, readyAt = 0) =>
  internals(im).textures.set(texKey, { state: 'ready', texture: new THREE.Texture(), lastUsed: 0, readyAt })
const mixOf = (im: TileImagery, tileKey: string) => internals(im).materials.get(tileKey)!.mix.value

describe('imagery materials while the camera moves', () => {
  const base = new THREE.MeshStandardMaterial()
  const tile = (z: number, x: number, y: number) => ({ key: `0/${z}/${x}/${y}`, face: 0, z, x, y, mesh: new THREE.Mesh(undefined, base) })

  it('a tile that appears mid-zoom has the current mix in its very first frame (no flash of plain terrain)', () => {
    const im = new TileImagery(() => {}, 1)
    ready(im, '0/0/0/0')
    im.tick(5000, 0.8) // the frame starts: the mix for this altitude
    const t = tile(1, 1, 0) // split off by this frame's selection, showing its parent's image
    im.apply([t], base, 5000)
    expect(t.mesh.material).not.toBe(base)
    expect(mixOf(im, t.key)).toBeCloseTo(0.8)
  })

  it('swapping a stand-in for the sharper image keeps the mix (no flash either)', () => {
    const im = new TileImagery(() => {}, 1)
    ready(im, '0/0/0/0')
    const t = tile(1, 1, 0)
    im.tick(5000, 0.8)
    im.apply([t], base, 5000)
    ready(im, '0/1/1/0', 5100) // its own image arrives
    im.tick(5200, 0.8)
    im.apply([t], base, 5200)
    expect(internals(im).materials.get(t.key)!.texKey).toBe('0/1/1/0')
    expect(mixOf(im, t.key)).toBeCloseTo(0.8)
  })

  it('still fades in the first image of a tile when that image has only just arrived', () => {
    const im = new TileImagery(() => {}, 1)
    ready(im, '0/0/0/0', 5000)
    const t = tile(0, 0, 0)
    im.tick(5000, 1)
    im.apply([t], base, 5000)
    expect(mixOf(im, t.key)).toBe(0) // the 300 ms fade starts from plain terrain
    im.tick(5150, 1)
    expect(mixOf(im, t.key)).toBeCloseTo(0.5)
  })
})
