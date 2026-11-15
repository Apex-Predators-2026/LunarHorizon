import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const MARGIN = 8
const CLICK_SLOP_PX = 4

export interface DragPos {
  x: number
  y: number
}

/**
 * Pointer-based dragging for a floating panel. The panel starts wherever CSS puts it; the first drag
 * reads its rect and switches it to fixed positioning (`pos`). The panel keeps its own size, stays
 * inside the viewport, and a drag is told apart from a click (`consumeClick`).
 */
export function useDraggable(rootRef: RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<DragPos | null>(null)
  const [dragging, setDragging] = useState(false)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null) // size when the drag began
  const drag = useRef<{ pointerId: number; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const detachRef = useRef<(() => void) | null>(null)

  const clamp = useCallback(
    (x: number, y: number): DragPos => {
      const el = rootRef.current
      const w = el?.offsetWidth ?? 0
      const h = el?.offsetHeight ?? 0
      return {
        x: Math.round(Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - w - MARGIN))),
        y: Math.round(Math.min(Math.max(MARGIN, y), Math.max(MARGIN, window.innerHeight - h - MARGIN))),
      }
    },
    [rootRef],
  )

  /** Re-fit a dragged panel into the viewport (after a resize or a height change). */
  const refit = useCallback(() => setPos((p) => (p ? clamp(p.x, p.y) : p)), [clamp])

  useEffect(() => {
    window.addEventListener('resize', refit)
    return () => {
      window.removeEventListener('resize', refit)
      detachRef.current?.()
    }
  }, [refit])

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !rootRef.current) return
    detachRef.current?.()
    const rect = rootRef.current.getBoundingClientRect()
    const pointerId = e.pointerId
    drag.current = { pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top, sx: e.clientX, sy: e.clientY, moved: false }

    const onWindowMove = (ev: PointerEvent) => {
      const d = drag.current
      if (!d || ev.pointerId !== d.pointerId) return
      if (!d.moved) {
        if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < CLICK_SLOP_PX) return
        d.moved = true
        const el = rootRef.current
        if (el) {
          const r = el.getBoundingClientRect()
          setSize({ w: Math.round(r.width), h: Math.round(r.height) }) // whole pixels: fractional sizes let the panel's background fringe at the edges
        }
        setDragging(true)
      }
      setPos(clamp(ev.clientX - d.dx, ev.clientY - d.dy))
    }

    const onWindowUp = (ev: PointerEvent) => {
      const d = drag.current
      if (!d || ev.pointerId !== d.pointerId) return
      cleanup()
      suppressClick.current = d.moved
      drag.current = null
      setDragging(false)
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', onWindowMove)
      window.removeEventListener('pointerup', onWindowUp)
      window.removeEventListener('pointercancel', onWindowUp)
      detachRef.current = null
    }

    detachRef.current = cleanup
    window.addEventListener('pointermove', onWindowMove)
    window.addEventListener('pointerup', onWindowUp)
    window.addEventListener('pointercancel', onWindowUp)
  }

  /** True once after a drag, so the click that follows the pointer-up can be ignored. */
  const consumeClick = () => {
    const was = suppressClick.current
    suppressClick.current = false
    return was
  }

  return {
    pos,
    setPos,
    size,
    setSize,
    dragging,
    refit,
    consumeClick,
    handlers: { onPointerDown },
  }
}
