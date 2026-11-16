import { useEffect, useRef, useState, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], summary, button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The element Tab should move to inside `items` (a modal's focusable elements), or null to let the browser act. */
export function nextTrapTarget<T>(items: T[], active: T | null, backwards: boolean): T | null {
  if (!items.length) return null
  const i = active === null ? -1 : items.indexOf(active)
  if (i === -1) return backwards ? items[items.length - 1] : items[0] // focus is outside: bring it back in
  if (backwards && i === 0) return items[items.length - 1]
  if (!backwards && i === items.length - 1) return items[0]
  return null // a normal step inside the dialog
}

/**
 * Modal keyboard behaviour for a dialog element: Escape calls `onEscape`, and Tab / Shift+Tab cycle inside the
 * dialog instead of reaching the page behind it. Focus goes back to where it was when the dialog closes.
 * `trap` false lets Tab leave (e.g. into a date popup the dialog opened, which lives outside it); Escape still works.
 */
export function useModalKeys(ref: RefObject<HTMLElement | null>, onEscape: () => void, trap = true) {
  const escape = useRef(onEscape)
  useEffect(() => {
    escape.current = onEscape
  })
  // Read during the first render: by the time effects run, the dialog's own autoFocus has already moved focus.
  const [before] = useState(() => (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null))
  useEffect(() => () => before?.focus({ preventScroll: true }), [before])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current
      if (!root) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        escape.current()
        return
      }
      if (e.key !== 'Tab' || !trap) return
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
      // Inside the dialog on something the list doesn't know: let the browser take the step.
      if (focused && root.contains(focused) && !items.includes(focused)) return
      const active = focused && root.contains(focused) ? focused : null
      const target = nextTrapTarget(items, active, e.shiftKey)
      if (!target) return
      e.preventDefault()
      target.focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [ref, trap])
}
