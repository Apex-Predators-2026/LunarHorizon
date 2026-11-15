import { describe, expect, it } from 'vitest'
import { SHADOW_EVERY_MS, shadowDecision, waitMs } from './shadowThrottle'

describe('shadowDecision', () => {
  it('does nothing while nothing changed', () => {
    expect(shadowDecision(false, 10_000)).toBe('idle')
  })
  it('redraws at once after a pause, waits during a burst', () => {
    expect(shadowDecision(true, SHADOW_EVERY_MS)).toBe('redraw')
    expect(shadowDecision(true, 5)).toBe('wait')
  })
  it('waits only as long as the throttle needs, so the last move is always drawn', () => {
    expect(waitMs(5)).toBe(SHADOW_EVERY_MS - 5 + 1)
    expect(waitMs(1000)).toBe(1)
  })
})
