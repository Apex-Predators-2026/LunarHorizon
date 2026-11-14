import { useLayoutEffect, useRef, useState } from 'react'
import { GlassSurface } from '../ui/GlassSurface'
import type { Horizon, SiteInfo, TimelineStep } from '../types'
import type { SiteFrame } from './globe/cubeSphere'
import { MoonMiniMap } from './MoonMiniMap'
import { SkyPlot } from './SkyPlot'
import { useDraggable } from './useDraggable'

type Tab = 'map' | 'sky'

const TABS: { id: Tab; label: string; tip: string }[] = [
  { id: 'map', label: 'Map', tip: 'Where you are on the Moon: the 3D view outlined, all sites, lit by the Sun now. Click to fly.' },
  { id: 'sky', label: 'Sky', tip: 'The sky from the lander: the terrain horizon, and the Sun and Earth paths over the time window' },
]

/**
 * The Mini Map card: a whole-Moon map of where the 3D view is (Map tab), or the sky from the lander
 * (Sky tab). Starts in the upper-right; drag it by its tab bar or edges to move it. A placeholder of the
 * same size stays in the layout so the sidebar beneath it does not jump when the card is moved.
 */
export function MiniMapPanel(props: {
  horizon: Horizon | null
  steps: TimelineStep[]
  current: TimelineStep | null
  windowLabel: string
  sites: SiteInfo[] | null
  siteId: string | null
  frame: SiteFrame | null
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const { pos, size, dragging, handlers } = useDraggable(cardRef)
  const [tab, setTab] = useState<Tab>('map')
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const el = tabRefs.current[tab]
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth })
  }, [tab])

  return (
    <div className="shrink-0" style={pos && size ? { height: size.h } : undefined}>
      <div
        ref={cardRef}
        {...handlers}
        data-tip="Drag to move"
        className={`lp-light pointer-events-auto flex touch-none select-none flex-col items-center rounded-[20px] ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={pos && size ? { position: 'fixed', left: pos.x, top: pos.y, width: size.w, zIndex: 20 } : undefined}
      >
        <GlassSurface radius="9999px" interactive={false} className="glass-strong mt-2 inline-flex p-1">
          <div role="tablist" aria-label="Mini map" className="relative flex gap-1">
            {/* The selected tab's glass slides between the options. */}
            <GlassSurface
              radius="9999px"
              interactive={false}
              aria-hidden
              className="glass-slide pointer-events-none absolute inset-y-0"
              style={{ left: pill?.left ?? 0, width: pill?.width ?? 0, opacity: pill ? 1 : 0, background: 'linear-gradient(135deg, rgba(255,255,255,0.5), rgba(255,255,255,0.22))' }}
            />
            {TABS.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el
                }}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                data-tip={t.tip}
                onPointerDown={(e) => e.stopPropagation()} // a click on a tab, not a drag of the card
                onClick={() => setTab(t.id)}
                className={`relative z-10 h-8 min-w-20 rounded-full px-4 text-sm transition-colors ${tab === t.id ? 'font-semibold text-white' : 'text-white/75 hover:text-white'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </GlassSurface>
        {tab === 'map' ? (
          <MoonMiniMap sites={props.sites} siteId={props.siteId} frame={props.frame} current={props.current} />
        ) : (
          <SkyPlot horizon={props.horizon} steps={props.steps} current={props.current} windowLabel={props.windowLabel} suppressTip={dragging} />
        )}
      </div>
    </div>
  )
}
