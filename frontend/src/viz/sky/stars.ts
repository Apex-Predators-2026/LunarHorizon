// The star catalogue for the sky (public/sky/stars.bin, built by backend/scripts/build_star_catalog.py
// from Hipparcos): ~8,800 stars to magnitude 6.5, brightest first, and how each one is drawn.
import type { Vec3 } from '../globe/cubeSphere'

export interface Star {
  dir: Vec3 // unit vector, inertial (ICRF)
  mag: number // V magnitude (smaller = brighter)
  bv: number // B-V colour index (blue-white < 0.3 < yellow < 1 < orange-red)
}

const DEG = Math.PI / 180

export function parseStars(buf: ArrayBuffer): Star[] {
  const v = new DataView(buf)
  const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))
  if (magic !== 'LSC1') throw new Error('not a star catalogue')
  const n = v.getUint32(4, true)
  const out: Star[] = []
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 16
    const ra = v.getFloat32(o, true) * DEG
    const dec = v.getFloat32(o + 4, true) * DEG
    out.push({ dir: [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)], mag: v.getFloat32(o + 8, true), bv: v.getFloat32(o + 12, true) })
  }
  return out
}

let catalogue: Promise<Star[] | null> | null = null
/** The catalogue, downloaded once (null if missing: then there are no stars, nothing else breaks). */
export function loadStars(): Promise<Star[] | null> {
  catalogue ??= fetch(`${import.meta.env.BASE_URL}sky/stars.bin`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(parseStars)
    .catch((e: unknown) => {
      console.warn('Star catalogue unavailable.', e)
      return null
    })
  return catalogue
}

// Star colour by B-V (blackbody-ish, after Mitchell Charity's table), softened towards white: on a
// screen, fully saturated star colours look artificial.
const BV_COLOURS: [number, Vec3][] = [
  [-0.4, [0.62, 0.73, 1.0]],
  [0.0, [0.8, 0.85, 1.0]],
  [0.4, [1.0, 0.98, 0.95]],
  [0.8, [1.0, 0.91, 0.78]],
  [1.2, [1.0, 0.83, 0.62]],
  [1.6, [1.0, 0.74, 0.45]],
  [2.0, [1.0, 0.66, 0.35]],
]
export function starColour(bv: number): Vec3 {
  const b = Math.min(2, Math.max(-0.4, bv))
  let i = 0
  while (i < BV_COLOURS.length - 2 && b > BV_COLOURS[i + 1][0]) i++
  const [b0, c0] = BV_COLOURS[i]
  const [b1, c1] = BV_COLOURS[i + 1]
  const t = (b - b0) / (b1 - b0)
  return [0, 1, 2].map((k) => {
    const c = c0[k] + (c1[k] - c0[k]) * t
    return c + (1 - c) * 0.25 // softened
  }) as Vec3
}

/**
 * On-screen size (CSS px) and opacity of a star of a given magnitude: faint stars are small and dim
 * (their light ~ 10^(-0.4 m)), the brightest a little larger. No twinkling: there is no air.
 */
export function starLook(mag: number): { size: number; alpha: number } {
  const size = Math.min(6.5, Math.max(2.5, 3.2 + (2.5 - mag) * 0.75))
  const alpha = Math.min(1, Math.max(0.22, 10 ** (-0.4 * (mag - 3.5))))
  return { size, alpha }
}
