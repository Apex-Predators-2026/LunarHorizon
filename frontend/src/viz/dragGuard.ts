import { useEffect, useRef } from 'react'
// While a pointer drag is in progress the browser must not start its own gestures: a text selection that
// sweeps across the overlays, or a native drag of an already-selected block of text (which then follows the
// pointer and can't be dropped or cleared). `guardDrag()` clears any selection, blocks both for the
// duration, and returns the function that releases them.
export function clearSelection(): void {
  try {
    window.getSelection?.()?.removeAllRanges()
  } catch {
    /* no selection API (tests, very old browsers) */
  }
}

export function guardDrag(): () => void {
  if (typeof document === 'undefined') return () => {}
  clearSelection()
  const stop = (e: Event) => {
    const t = e.target as HTMLElement | null
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return // typing in a field still selects
    e.preventDefault()
  }
  document.addEventListener('selectstart', stop, true)
  document.addEventListener('dragstart', stop, true)
  return () => {
    document.removeEventListener('selectstart', stop, true)
    document.removeEventListener('dragstart', stop, true)
  }
}

/** For scrub strips and sliders: `begin()` on pointer-down, `end()` on pointer-up / cancel. */
export function useDragGuard() {
  const release = useRef<(() => void) | null>(null)
  const end = () => {
    release.current?.()
    release.current = null
  }
  const begin = () => {
    end()
    release.current = guardDrag()
  }
  // A strip unmounted mid-drag must not leave the document-level blockers behind.
  useEffect(() => () => end(), [])
  return { begin, end, onDragStart: (e: { preventDefault: () => void }) => e.preventDefault() }
}
