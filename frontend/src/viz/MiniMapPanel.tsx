import { useRef } from 'react'
import type { Horizon, TimelineStep } from '../types'
import { SkyPlot } from './SkyPlot'
import { useDraggable } from './useDraggable'

/**
 * The Mini Map card. Starts in the upper-right; drag it anywhere. A placeholder of the same size stays
 * in the layout so the sidebar beneath it does not jump when the card is moved.
 */
export function MiniMapPanel(props: { horizon: Horizon | null; steps: TimelineStep[]; current: TimelineStep | null; windowLabel: string }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const { pos, size, dragging, handlers } = useDraggable(cardRef)

  return (
    <div className="shrink-0" style={pos && size ? { height: size.h } : undefined}>
      <div
        ref={cardRef}
        {...handlers}
        title="Drag to move"
        className={`lp-light pointer-events-auto flex touch-none select-none justify-center rounded-[20px] bg-opal-50 transition-shadow ${
          dragging ? 'cursor-grabbing shadow-2xl shadow-black/50' : 'cursor-grab shadow-lg shadow-black/30'
        }`}
        style={pos && size ? { position: 'fixed', left: pos.x, top: pos.y, width: size.w, zIndex: 20 } : undefined}
      >
        <SkyPlot {...props} suppressTip={dragging} />
      </div>
    </div>
  )
}
