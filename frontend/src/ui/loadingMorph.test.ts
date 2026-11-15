import { describe, expect, it } from 'vitest'
import { morphAt } from './loadingMorph'

describe('loading indicator animation', () => {
  it('handles a first frame timestamped just before the start (negative elapsed time)', () => {
    // requestAnimationFrame can pass a time slightly before the performance.now() read when the effect
    // started; this used to read SHAPES[-1] and throw "Cannot read properties of undefined (reading 'a')".
    for (const t of [-0.1, -16.7, -1000]) {
      const m = morphAt(t)
      expect(m.from).toBeDefined()
      expect(m.to).toBeDefined()
      expect(m.mix).toBe(0)
      expect(m.turnDeg).toBe(0)
    }
  })

  it('holds a shape, then morphs to the next, turning steadily', () => {
    expect(morphAt(100).mix).toBe(0) // holding
    const mid = morphAt(420 + 240) // halfway through the morph
    expect(mid.mix).toBeCloseTo(0.5, 5)
    expect(morphAt(900).from).toBe(morphAt(0).to) // the next cycle starts from the shape it morphed to
    expect(morphAt(2500).turnDeg).toBeCloseTo(180, 5)
  })
})
