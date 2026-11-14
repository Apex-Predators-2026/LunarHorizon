import { describe, expect, it } from 'vitest'
import { parseStars, starColour, starLook } from './stars'

// Node's fs without pulling Node types into the app build (tsconfig.app only has vite/client).
const nodeFs = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: URL): Uint8Array<ArrayBuffer> }

describe('star catalogue', () => {
  const file = readFileSync(new URL('../../../public/sky/stars.bin', import.meta.url))
  const stars = parseStars(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength))

  it('has the naked-eye sky, brightest first, as unit vectors', () => {
    expect(stars.length).toBeGreaterThan(8000)
    expect(stars[0].mag).toBeLessThan(-1) // Sirius
    for (let i = 1; i < stars.length; i += 97) expect(stars[i].mag).toBeGreaterThanOrEqual(stars[i - 1].mag)
    for (const s of stars.slice(0, 50)) expect(Math.hypot(...s.dir)).toBeCloseTo(1, 6)
  })

  it('puts Sirius and Polaris where they belong', () => {
    const sirius = stars[0].dir // RA 101.29, Dec -16.72
    expect((Math.asin(sirius[2]) * 180) / Math.PI).toBeCloseTo(-16.72, 1)
    expect(((Math.atan2(sirius[1], sirius[0]) * 180) / Math.PI + 360) % 360).toBeCloseTo(101.29, 1)
    expect(stars.some((s) => s.mag < 2.1 && s.dir[2] > 0.9999)).toBe(true) // Polaris, ~0.7 deg from the pole
  })

  it('rejects other files', () => {
    expect(() => parseStars(new Uint8Array(8).buffer)).toThrow(/star catalogue/)
  })
})

describe('star appearance', () => {
  it('colours hot stars blue-white and cool stars orange', () => {
    const [r1, , b1] = starColour(-0.2)
    const [r2, , b2] = starColour(1.6)
    expect(b1).toBeGreaterThan(r1 - 0.2)
    expect(r2).toBeGreaterThan(b2)
    for (const c of starColour(0.65)) expect(c).toBeGreaterThan(0.8) // Sun-like: near white
  })

  it('draws brighter stars bigger and more opaque, faint ones still faintly', () => {
    const bright = starLook(-1.4)
    const faint = starLook(6.5)
    expect(bright.size).toBeGreaterThan(faint.size)
    expect(bright.alpha).toBe(1)
    expect(faint.alpha).toBeGreaterThan(0)
    expect(faint.alpha).toBeLessThan(0.3)
  })
})
