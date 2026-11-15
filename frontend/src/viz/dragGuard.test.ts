import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardDrag } from './dragGuard'

// No DOM in these tests: a recording stand-in for `document`, with handlers called directly.
function fakeDocument() {
  const handlers = new Map<string, (e: unknown) => void>()
  return {
    handlers,
    addEventListener: (type: string, fn: (e: unknown) => void) => void handlers.set(type, fn),
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (handlers.get(type) === fn) handlers.delete(type)
    },
  }
}

function fire(doc: ReturnType<typeof fakeDocument>, type: string, target: object) {
  const e = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
  doc.handlers.get(type)?.(e)
  return e.defaultPrevented
}

describe('guardDrag', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('blocks selection and native drag until released, but lets fields select', () => {
    const doc = fakeDocument()
    const cleared = vi.fn()
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { getSelection: () => ({ removeAllRanges: cleared }) })

    const release = guardDrag()
    expect(cleared).toHaveBeenCalled() // an existing selection is dropped when the gesture starts
    const div = { tagName: 'DIV', isContentEditable: false }
    expect(fire(doc, 'selectstart', div)).toBe(true)
    expect(fire(doc, 'dragstart', div)).toBe(true)
    expect(fire(doc, 'selectstart', { tagName: 'INPUT', isContentEditable: false })).toBe(false)

    release()
    expect(doc.handlers.size).toBe(0) // both listeners removed
  })
})
