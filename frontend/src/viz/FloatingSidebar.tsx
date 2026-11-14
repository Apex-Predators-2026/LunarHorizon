import { useRef, useState, type ReactNode } from 'react'
import { useDraggable } from './useDraggable'

/**
 * Floating sidebar with a coral header bar that is both the drag handle and the collapse toggle.
 * It starts in normal flow (under the Mini Map); the first drag switches it to fixed positioning
 * at the size it had, so it never resizes while moving. Collapsing only hides the body (it stays
 * mounted), so form state is never lost.
 */
export function FloatingSidebar({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(true)
  const { pos, size, handlers, consumeClick, refit } = useDraggable(rootRef)
  const [openHeight, setOpenHeight] = useState(0) // height while expanded, kept so the panel is the same size after moving

  const onClick = () => {
    if (consumeClick()) return
    if (open && rootRef.current) setOpenHeight(rootRef.current.offsetHeight)
    setOpen((o) => !o)
    setTimeout(refit, 240) // after the height transition, pull it back inside the viewport
  }

  return (
    <div
      ref={rootRef}
      className="lp-light pointer-events-auto flex min-h-0 w-full flex-col overflow-hidden rounded-[20px] bg-opal-100 shadow-lg shadow-black/30"
      style={
        pos && size
          ? {
              position: 'fixed',
              left: pos.x,
              top: pos.y,
              width: size.w,
              maxHeight: openHeight || size.h,
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
    </div>
  )
}
