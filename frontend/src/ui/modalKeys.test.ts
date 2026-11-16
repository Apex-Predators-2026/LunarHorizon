import { describe, expect, it } from 'vitest'
import { nextTrapTarget } from './modalKeys'

describe('nextTrapTarget', () => {
  const items = ['name', 'site', 'save']
  it('wraps forwards from the last item and backwards from the first', () => {
    expect(nextTrapTarget(items, 'save', false)).toBe('name')
    expect(nextTrapTarget(items, 'name', true)).toBe('save')
  })
  it('leaves ordinary steps inside the dialog to the browser', () => {
    expect(nextTrapTarget(items, 'name', false)).toBeNull()
    expect(nextTrapTarget(items, 'save', true)).toBeNull()
  })
  it('pulls focus back in when it is outside the dialog', () => {
    expect(nextTrapTarget(items, null, false)).toBe('name')
    expect(nextTrapTarget(items, 'page-behind', true)).toBe('save')
  })
  it('does nothing without focusable items', () => {
    expect(nextTrapTarget([], null, false)).toBeNull()
  })
})
