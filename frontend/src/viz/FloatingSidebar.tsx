import { useRef, useState, type ReactNode } from 'react'
import { useDraggable } from './useDraggable'

const MARGIN = 8
const MIN_W = 260
const MIN_H = 120

type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

// Invisible grab zones on the edges and corners.
const HANDLES: { dir: Dir; cls: string; cursor: string }[] = [
  { dir: 'n', cls: 'left-3 right-3 top-0 h-1', cursor: 'ns-resize' },
  { dir: 's', cls: 'bottom-0 left-3 right-3 h-1.5', cursor: 'ns-resize' },
  { dir: 'e', cls: 'bottom-3 right-0 top-3 w-1.5', cursor: 'ew-resize' },
  { dir: 'w', cls: 'bottom-3 left-0 top-3 w-1.5', cursor: 'ew-resize' },
  { dir: 'ne', cls: 'right-0 top-0 h-3 w-3', cursor: 'nesw-resize' },
  { dir: 'nw', cls: 'left-0 top-0 h-3 w-3', cursor: 'nwse-resize' },
  { dir: 'se', cls: 'bottom-0 right-0 h-4 w-4', cursor: 'nwse-resize' },
  { dir: 'sw', cls: 'bottom-0 left-0 h-4 w-4', cursor: 'nesw-resize' },
]

/**
 * Floating sidebar with a coral header bar that is both the drag handle and the collapse toggle.
 * It starts in normal flow (under the Mini Map); the first drag or resize switches it to fixed
 * positioning at the size it had, so it never resizes while moving. Its edges and corners resize it.
 * Collapsing only hides the body (it stays mounted), so form state is never lost.
 */
export function FloatingSidebar({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(true)
  const { pos, setPos, size, setSize, handlers, consumeClick, refit } = useDraggable(rootRef)
  const [openHeight, setOpenHeight] = useState(0) // height while expanded, kept across collapse / moves
  const [userSized, setUserSized] = useState(false) // true once resized by hand: then height is exact, not a max

  const onClick = () => {
    if (consumeClick()) return
    if (open && rootRef.current) setOpenHeight(rootRef.current.offsetHeight)
    setOpen((o) => !o)
    setTimeout(refit, 240) // after the height transition, pull it back inside the viewport
  }

  const startResize = (dir: Dir, cursor: string) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const r = rootRef.current!.getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, w: r.width, h: r.height }
    const el = e.currentTarget
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // pointer already gone; listeners on the handle still work
    }
    document.body.style.cursor = cursor
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      let { l, t, w, h } = start
      if (dir.includes('e')) w = Math.min(Math.max(MIN_W, start.w + dx), window.innerWidth - start.l - MARGIN)
      if (dir.includes('w')) {
        w = Math.min(Math.max(MIN_W, start.w - dx), start.l + start.w - MARGIN)
        l = start.l + start.w - w
      }
      if (dir.includes('s')) h = Math.min(Math.max(MIN_H, start.h + dy), window.innerHeight - start.t - MARGIN)
      if (dir.includes('n')) {
        h = Math.min(Math.max(MIN_H, start.h - dy), start.t + start.h - MARGIN)
        t = start.t + start.h - h
      }
      setPos({ x: l, y: t })
      setSize({ w, h })
      setOpenHeight(h)
      setUserSized(true)
    }
    const up = () => {
      document.body.style.cursor = ''
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const h = openHeight || size?.h || 0
  const fixed = pos && size
  return (
    <div
      ref={rootRef}
      className="lp-light pointer-events-auto relative flex min-h-0 w-full flex-col overflow-hidden rounded-[20px] bg-opal-100 shadow-lg shadow-black/30"
      style={
        fixed
          ? {
              position: 'fixed',
              left: pos.x,
              top: pos.y,
              width: size.w,
              ...(open ? (userSized ? { height: h } : { maxHeight: h }) : {}),
            }
          : undefined
      }
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Sidebar: drag to move, click to minimize' : 'Sidebar: drag to move, click to expand'}
        title={open ? 'Drag to move · click to minimize' : 'Drag to move · click to expand'}
        {...handlers}
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
      {open &&
        HANDLES.map((hd) => (
          <div
            key={hd.dir}
            aria-hidden
            className={`absolute z-10 touch-none ${hd.cls}`}
            style={{ cursor: hd.cursor }}
            onPointerDown={startResize(hd.dir, hd.cursor)}
          />
        ))}
    </div>
  )
}
