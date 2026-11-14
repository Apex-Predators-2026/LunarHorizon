import { describe, expect, it } from 'vitest'
import { IMAGERY_FADE_END_M, IMAGERY_FADE_START_M, IMAGERY_PREFETCH_M, imageryMix, imageryWanted } from './tileImagery'

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
