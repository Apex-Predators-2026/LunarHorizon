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
  const drag = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

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
    return () => window.removeEventListener('resize', refit)
  }, [refit])

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const rect = rootRef.current!.getBoundingClientRect()
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, sx: e.clientX, sy: e.clientY, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < CLICK_SLOP_PX) return
      d.moved = true
      // Capture the pointer only once it is really a drag, so plain clicks on things inside the panel still work.
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* pointer already gone */
      }
      const r = rootRef.current!.getBoundingClientRect()
      setSize({ w: Math.round(r.width), h: Math.round(r.height) }) // whole pixels: fractional sizes let the panel's background fringe at the edges
      setDragging(true)
    }
    setPos(clamp(e.clientX - d.dx, e.clientY - d.dy))
  }
  const onPointerUp = () => {
    suppressClick.current = !!drag.current?.moved
    drag.current = null
    setDragging(false)
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
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  }
}
