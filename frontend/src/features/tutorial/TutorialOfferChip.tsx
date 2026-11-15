import { useEffect, useRef, useState } from 'react'

import { InteractiveGrainGradient } from '../../ui/InteractiveGrainGradient'
import { playUiTap } from '../../viz/sfx'
import { useTutorialStore } from './useTutorialStore'

/** The Mission Planner toolbar's More (⋮) button, and the Guided Tour item inside its menu. */
const MORE_BUTTON = '[data-tour="more-menu"]'
const MENU_ITEM = '[data-tour="menu-tour"]'

const ARROW_W = 28
const ARROW_H = 44
const GAP = 8 // between the arrow tip and the highlighted button
const EDGE = 16

/**
 * Material Symbols Rounded "arrow_downward" (a stem with round caps and a chevron head), used as a mask so the
 * arrow is filled with the same living coral gradient as the tour's progress strip and Start button.
 */
const ARROW_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 44'><path d='M14 3v35M4 28l10 10 10-10' fill='none' stroke='black' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/></svg>`,
)}")`

interface Box {
  left: number
  top: number
  width: number
  height: number
}

function visibleBox(selector: string): Box | null {
  if (typeof document === 'undefined') return null
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    if (el.closest('[inert]')) continue // inside the hidden Planner while another page is open
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return { left: r.left, top: r.top, width: r.width, height: r.height }
  }
  return null
}

const same = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1)

/** Follows the More button and, while its menu is open, the Guided Tour item (both mount and move with the layout). */
function useAnchors(active: boolean) {
  const [more, setMore] = useState<Box | null>(null)
  const [item, setItem] = useState<Box | null>(null)
  useEffect(() => {
    if (!active) return
    const read = () => {
      const m = visibleBox(MORE_BUTTON)
      const i = visibleBox(MENU_ITEM)
      setMore((p) => (same(p, m) ? p : m))
      setItem((p) => (same(p, i) ? p : i))
    }
    // Every frame: the toolbar mounts once the site data is in and slides into place, and menus open and close.
    // Two rect reads a frame; state only changes when something actually moved.
    let raf = 0
    const loop = () => {
      read()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active])
  return active ? { more, item } : { more: null, item: null }
}

/**
 * Non-blocking M3 offer of the Guided Tour. In the Mission Planner it floats above the map toolbar with an arrow
 * pointing at More (⋮), where the tour always lives, and rings that button (then the menu's Guided Tour item once
 * the menu is open). Elsewhere it sits in the corner. Optional: Start tour, dismiss, or Don't show again.
 * Respects dark mode (.lp-light/.lp-dark), `dontShowAgain`, `[data-ui-hidden='true']` and reduced motion.
 */
export function TutorialOfferChip({
  uiHidden,
  compareActive,
  anchorToMenu = false,
}: {
  uiHidden: boolean
  compareActive: boolean
  /** Point at the Mission Planner toolbar's More (⋮) button. */
  anchorToMenu?: boolean
}) {
  const open = useTutorialStore((s) => s.open)
  const offerDismissed = useTutorialStore((s) => s.offerDismissed)
  const dontShowAgain = useTutorialStore((s) => s.dontShowAgain)
  const startTour = useTutorialStore((s) => s.startTour)
  const dismissOffer = useTutorialStore((s) => s.dismissOffer)

  const visible = !(uiHidden || open || offerDismissed || dontShowAgain)
  const { more, item } = useAnchors(visible && anchorToMenu)
  const hasAnchor = more !== null
  const cardRef = useRef<HTMLElement>(null)
  const [cardSize, setCardSize] = useState({ width: 340, height: 170 })
  useEffect(() => {
    const el = cardRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      if (r.width > 0) setCardSize((p) => (Math.abs(p.width - r.width) < 1 && Math.abs(p.height - r.height) < 1 ? p : { width: r.width, height: r.height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [visible, hasAnchor])

  if (!visible) return null
  // In the planner, wait for the toolbar rather than flashing the card in the corner first.
  if (anchorToMenu && !more) return null

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1366
  const anchored = anchorToMenu && more
  // A narrow screen can push More (⋮) past the edge of the scrolling toolbar: then nothing is drawn pointing at it.
  const pointable = !!more && more.left >= 0 && more.left + more.width <= vw
  const cx = more ? more.left + more.width / 2 : 0
  const arrowTop = more ? more.top - GAP - ARROW_H : 0
  // The arrow sits near the card's right end, so the card spreads left over the open 3D view (not onto the + button).
  const cardLeft = more
    ? pointable
      ? Math.min(Math.max(EDGE, cx + ARROW_W / 2 + 12 - cardSize.width), Math.max(EDGE, vw - cardSize.width - EDGE))
      : Math.max(EDGE, (vw - cardSize.width) / 2)
    : 0
  const cardTop = more ? Math.max(EDGE, arrowTop - 6 - cardSize.height) : 0
  const ring = item ?? (pointable ? more : null)

  const card = (
    <aside
      ref={cardRef}
      aria-label="Guided tour offer"
      data-testid="tutorial-offer-chip"
      className={`lp-light md-reveal pointer-events-auto fixed z-40 flex w-[min(340px,calc(100vw-32px))] flex-col gap-2.5 rounded-[22px] border border-opal-300 bg-opal-50/95 p-3.5 text-slate-100 shadow-xl shadow-black/35 backdrop-blur-md ${
        anchored ? 'recede-behind-menu' : compareActive ? 'bottom-5 left-[clamp(16px,4.5vw,65px)]' : 'bottom-5 left-4'
      }`}
      style={{ fontFamily: 'var(--font-inter)', ...(anchored ? { left: cardLeft, top: cardTop } : null) }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-coral" aria-hidden />
            <p className="font-display text-sm font-bold tracking-tight text-slate-100">Guided Tour</p>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-300">
            Follow one real south-pole mission from landing site to decision: the quick tour takes about 90 seconds.
          </p>
          {anchored && (
            <p className="mt-1 text-xs leading-relaxed text-slate-300">
              Start it now, or any time from <span className="font-semibold text-slate-100">More (⋮)</span>{' '}
              {pointable ? 'below.' : 'at the end of the map toolbar.'}
            </p>
          )}
        </div>
        <button
          type="button"
          data-no-sfx
          aria-label="Dismiss guided tour offer"
          onClick={() => {
            playUiTap()
            dismissOffer(false)
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-opal-100 hover:text-slate-100"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          data-no-sfx
          onClick={() => {
            playUiTap()
            dismissOffer(true)
          }}
          className="inline-flex h-8 items-center rounded-full px-2 text-xs font-medium text-slate-400 transition-colors hover:text-slate-100"
        >
          Don&apos;t show again
        </button>

        <span className="flex items-center gap-1.5">
          <button type="button" onClick={() => startTour(0, 'full')} className="md-compact border border-opal-300 bg-opal-100 text-slate-200">
            Full tour
          </button>
          <button type="button" onClick={() => startTour(undefined, 'quick')} className="md-compact relative overflow-hidden font-semibold text-white shadow-sm">
            <span aria-hidden className="absolute inset-0">
              <InteractiveGrainGradient className="h-full w-full" />
            </span>
            <span className="relative z-10">Quick tour · 90 s</span>
          </button>
        </span>
      </div>
    </aside>
  )

  if (!anchored || !more) return card

  return (
    <>
      {card}
      {/* The arrow: an M3 rounded arrow filled with the living coral gradient, pointing at More (⋮). */}
      {pointable && <span
        aria-hidden
        className="recede-behind-menu pointer-events-none fixed z-40"
        style={{ left: cx - ARROW_W / 2, top: arrowTop, width: ARROW_W, height: ARROW_H }}
      >
        <span
          className="md-offer-arrow block h-full w-full"
          style={{ WebkitMaskImage: ARROW_MASK, maskImage: ARROW_MASK, WebkitMaskSize: '100% 100%', maskSize: '100% 100%' }}
        >
          <InteractiveGrainGradient className="h-full w-full" interactive={false} />
        </span>
      </span>}
      {/* The button to press: More (⋮), then the menu's Guided Tour item once the menu is open. */}
      {ring && (
        <span
          aria-hidden
          data-testid="tour-offer-ring"
          className={`md-tour-ring pointer-events-none fixed left-0 top-0 z-[45] border-2 border-coral ${item ? 'rounded-xl' : 'rounded-full'}`}
          // No glide: it follows the button every frame (the pulse stays; reduced motion stills it).
          style={{ transform: `translate3d(${ring.left - 4}px, ${ring.top - 4}px, 0)`, width: ring.width + 8, height: ring.height + 8, transition: 'none' }}
        />
      )}
    </>
  )
}
