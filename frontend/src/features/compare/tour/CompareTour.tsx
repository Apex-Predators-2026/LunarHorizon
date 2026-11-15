// Spotlight tour of the Scenario Comparison page. Non-blocking: the page stays usable (the dimmed backdrop does
// not take clicks), the highlighted element is scrolled into view, and the card is placed with the same helper the
// Mission Planner tour uses. Esc skips, arrow keys move between steps.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { computeCoachmarkPosition, type RectBox } from '../../tutorial/utils'
import { COMPARE_TOUR_STEPS, availableSteps, type CompareTourStep } from './steps'
import { useCompareTour } from './useCompareTour'

const PAD = 8
const TOP_CLEARANCE = 150 // app header + sticky section bar
const EDGE = 16

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight && /auto|scroll/.test(getComputedStyle(p).overflowY)) return p
  }
  return null
}

const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: RectBox) =>
  !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)

function visibleTarget(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return el
    }
  }
  return null
}

const toBox = (r: DOMRect): RectBox => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })

export function CompareTour() {
  const open = useCompareTour((s) => s.open)
  const index = useCompareTour((s) => s.index)
  const { next, back, skip, finish } = useCompareTour.getState()
  // Which steps exist is read from the page when the tour opens (an optional step needs its target rendered).
  const steps: CompareTourStep[] = useMemo(() => (open ? availableSteps(visibleTarget) : COMPARE_TOUR_STEPS), [open])
  const [rect, setRect] = useState<RectBox | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 16, top: 16 })
  const cardRef = useRef<HTMLDivElement>(null)
  const step = steps[Math.min(index, steps.length - 1)]

  // Bring the highlighted element into view on each step, and focus the card for keyboard users.
  useEffect(() => {
    if (!open || !step) return
    // Instant scroll (no animation; nothing moves for users who prefer reduced motion). The target goes near the
    // top, below the app header and the sticky section bar, leaving room for the card underneath it.
    const el = visibleTarget(step.targets)
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: 'auto' })
      scrollParent(el)?.scrollBy({ top: -TOP_CLEARANCE, behavior: 'auto' })
    }
    cardRef.current?.focus({ preventScroll: true })
  }, [open, step])

  // Follow the target while the page scrolls, resizes or re-renders.
  const measure = useCallback(() => {
    if (!step) return
    const el = visibleTarget(step.targets)
    const box = el ? toBox(el.getBoundingClientRect()) : null
    setRect(box)
    const card = cardRef.current
    const size = { width: card?.offsetWidth ?? 360, height: card?.offsetHeight ?? 220 }
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    // A target taller than the screen: anchor to its visible part so the card stays next to what is highlighted.
    const anchor = box && {
      ...box,
      top: Math.max(box.top, 0),
      bottom: Math.min(box.bottom, viewport.height),
      height: Math.min(box.bottom, viewport.height) - Math.max(box.top, 0),
    }
    const target = anchor && anchor.height > 0 ? anchor : null
    const p = computeCoachmarkPosition(target, viewport, size, step.placement)
    // No free side large enough (small window, large target): dock the card in the bottom-right corner, where it
    // covers the least of the highlighted element's top, which is scrolled into view.
    if (target && overlaps({ left: p.left, top: p.top, right: p.left + size.width, bottom: p.top + size.height }, target)) {
      setPos({ left: Math.max(EDGE, viewport.width - size.width - EDGE), top: Math.max(EDGE, viewport.height - size.height - EDGE) })
    } else {
      setPos({ left: p.left, top: p.top })
    }
  }, [step])

  useLayoutEffect(() => {
    if (!open) return
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    schedule()
    window.addEventListener('scroll', schedule, true) // capture: the page scrolls inside <main>, not the window
    window.addEventListener('resize', schedule)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    if (cardRef.current) ro?.observe(cardRef.current)
    const settle = window.setInterval(measure, 250) // smooth scrolling and late layout
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      ro?.disconnect()
      window.clearInterval(settle)
    }
  }, [open, measure])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); skip() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(steps.length) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, steps.length, next, back, skip])

  if (!open || !step || typeof document === 'undefined') return null
  const last = index >= steps.length - 1
  return createPortal(
    // Same style scope as the comparison page, without its page background. The scope creates its own positioning
    // context, so the wrapper itself is a full-screen fixed layer: everything inside is then placed against the screen.
    <div className="cmp-page lp-light md-host pointer-events-none fixed inset-0 z-[90]"
      style={{ background: 'transparent', minHeight: 0, padding: 0, margin: 0 }}>
      {/* Dimmed backdrop with a cut-out around the target. It ignores pointer events: the page stays usable. */}
      {rect ? (
        <div aria-hidden="true" className="pointer-events-none absolute rounded-xl"
          style={{
            left: rect.left - PAD, top: rect.top - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD,
            boxShadow: '0 0 0 2px var(--color-accent, #d9472f), 0 0 0 9999px rgba(15, 18, 24, 0.38)',
          }} />
      ) : (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[rgba(15,18,24,0.38)]" />
      )}
      <div ref={cardRef} role="dialog" aria-modal="false" aria-labelledby="cmp-tour-title" aria-describedby="cmp-tour-body"
        tabIndex={-1}
        className="pointer-events-auto absolute w-[min(360px,calc(100vw-32px))] rounded-2xl border border-line bg-surface p-4 text-ink shadow-xl outline-none"
        style={{ left: pos.left, top: pos.top }}>
        <div className="flex items-center justify-between text-[11px] text-ink-3">
          <span>How to compare missions · step {index + 1} of {steps.length}</span>
          <button type="button" className="cmp-btn-text" onClick={skip}>Skip tour</button>
        </div>
        <h2 id="cmp-tour-title" className="mt-1 text-base font-medium text-ink">{step.title}</h2>
        <div id="cmp-tour-body" className="mt-1.5 space-y-1.5 text-sm leading-relaxed text-ink-2">
          {step.body.map((p) => <p key={p}>{p}</p>)}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="flex gap-1" aria-hidden="true">
            {steps.map((s, i) => (
              <span key={s.id} className={`h-1.5 w-4 rounded-full ${i === index ? 'bg-[var(--color-accent,#d9472f)]' : 'bg-line'}`} />
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <button type="button" className="cmp-btn" onClick={back} disabled={index === 0}>Back</button>
            {last
              ? <button type="button" className="cmp-btn-primary" onClick={finish}>Finish</button>
              : <button type="button" className="cmp-btn-primary" onClick={() => next(steps.length)}>Next</button>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
