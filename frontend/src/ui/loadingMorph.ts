// Timing of the M3 loading indicator's animation (LoadingIndicator.tsx): which shapes, how far, how turned.

export type Shape = { n: number; a: number } // lobes and depth of the outline r(θ) = 1 + a·cos(nθ)
// Soft burst, 9-sided cookie, pentagon, sunny, 4-sided cookie, oval: the M3 loading sequence, approximated.
export const SHAPES: Shape[] = [
  { n: 10, a: 0.1 },
  { n: 9, a: 0.075 },
  { n: 5, a: 0.1 },
  { n: 12, a: 0.11 },
  { n: 4, a: 0.12 },
  { n: 2, a: 0.2 },
]
export const POINTS = 72
const HOLD_MS = 420 // each shape is held, then morphs to the next
const MORPH_MS = 480
const TURN_MS = 5000 // one full turn

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/**
 * Which two shapes to blend, how far (0-1), and the turn (degrees) `elapsedMs` into the animation. The first
 * animation frame can carry a timestamp from just before the effect read performance.now(), i.e. a slightly
 * negative elapsed time: that is clamped to 0 (it used to index SHAPES[-1] and throw "reading 'a'").
 */
export function morphAt(elapsedMs: number): { from: Shape; to: Shape; mix: number; turnDeg: number } {
  const t = Math.max(0, elapsedMs)
  const cycle = HOLD_MS + MORPH_MS
  const k = Math.floor(t / cycle)
  const within = t - k * cycle
  return {
    from: SHAPES[k % SHAPES.length],
    to: SHAPES[(k + 1) % SHAPES.length],
    mix: within < HOLD_MS ? 0 : ease((within - HOLD_MS) / MORPH_MS),
    turnDeg: ((t / TURN_MS) * 360) % 360,
  }
}
