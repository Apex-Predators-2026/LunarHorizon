import { describe, expect, it } from 'vitest'

import { countWords, firstWords } from './paced'

describe('paced reveal', () => {
  it('counts words and cuts after the nth', () => {
    expect(countWords('  one two\nthree ')).toBe(3)
    expect(firstWords('one two three four', 2)).toBe('one two')
    expect(firstWords('one two three', 0)).toBe('')
    expect(firstWords('one two three', 3)).toBe('one two three')
    expect(firstWords('one two three', 9)).toBe('one two three')
  })

  it('never shows a half-finished bold run or link', () => {
    expect(firstWords('A **big deal here** now', 2)).toBe('A **big**')
    expect(firstWords('See [[go:ranking]] for more', 1)).toBe('See')
    expect(firstWords('See [[go:ranking]] for more', 2)).toBe('See [[go:ranking]]')
  })
})
