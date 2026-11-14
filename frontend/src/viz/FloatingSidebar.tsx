import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const MARGIN = 8
const CLICK_SLOP_PX = 4

/**
 * Floating sidebar with a coral header bar that is both the drag handle and the collapse toggle.
 * It starts in normal flow (under the Mini Map); the first drag switches it to fixed positioning.
 * Collapsing only hides the body (it stays mounted), so form state is never lost.
 */
export function FloatingSidebar({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [open, setOpen] = useState(true)
  const drag = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  const clamp = useCallback((x: number, y: number) => {
    const el = rootRef.current
    const w = el?.offsetWidth ?? 0
    return {
      x: Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
      y: Math.min(Math.max(MARGIN, y), Math.max(MARGIN, window.innerHeight - 36 - MARGIN)),
    }
  }, [])

  // Keep a dragged panel reachable after the window shrinks.
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p.x, p.y) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    const rect = rootRef.current!.getBoundingClientRect()
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, sx: e.clientX, sy: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < CLICK_SLOP_PX) return
    d.moved = true
    setPos(clamp(e.clientX - d.dx, e.clientY - d.dy))
  }
  const onPointerUp = () => {
    // A drag must not also toggle the panel: swallow the click that follows the pointer-up.
    suppressClick.current = !!drag.current?.moved
    drag.current = null
  }
  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    setOpen((o) => !o)
  }

  return (
    <div
      ref={rootRef}
      className="lp-light pointer-events-auto flex min-h-0 w-full flex-col overflow-hidden rounded-[20px] bg-opal-100 shadow-lg shadow-black/30"
      style={
        pos
          ? { position: 'fixed', left: pos.x, top: pos.y, width: 'var(--lp-side-w)', maxHeight: `calc(100vh - ${pos.y}px - ${MARGIN}px)` }
          : undefined
      }
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Sidebar: drag to move, click to minimize' : 'Sidebar: drag to move, click to expand'}
        title={open ? 'Drag to move · click to minimize' : 'Drag to move · click to expand'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        className="flex h-6 w-full shrink-0 cursor-grab touch-none select-none items-center justify-center bg-coral transition-colors hover:bg-[#ee5740] active:cursor-grabbing"
      >
        <span aria-hidden className="h-1 w-10 rounded-full bg-white/70" />
      </button>
      <div
        className={`min-h-0 overflow-y-auto overflow-x-hidden transition-[max-height] duration-200 ${open ? 'max-h-[100vh]' : 'max-h-0'}`}
        inert={!open}
        aria-hidden={!open}
      >
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
