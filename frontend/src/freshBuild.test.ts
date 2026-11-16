import { describe, expect, it } from 'vitest'
import { shouldReload } from './freshBuild'

describe('shouldReload', () => {
  it('reloads once when a different build is published', () => {
    expect(shouldReload('b2', 'b1', null)).toBe(true)
    expect(shouldReload('b2', 'b1', 'b2')).toBe(false) // already reloaded for b2 (e.g. the cache served b1 again)
  })
  it('does nothing for the same build or a missing id', () => {
    expect(shouldReload('b1', 'b1', null)).toBe(false)
    expect(shouldReload(undefined, 'b1', null)).toBe(false)
  })
})
