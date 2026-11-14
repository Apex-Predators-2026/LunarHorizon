import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ComparisonDashboard } from './features/compare'
import { MissionRescue } from './features/rescue'
import { initMaterialMotion } from './viz/materialMotion'
import { Scene } from './viz/Scene'

const VIEWS = [
  { id: 'planner', label: 'Mission Planner' },
  { id: 'compare', label: 'Scenario Comparison' }, // Member 4
] as const

type View = (typeof VIEWS)[number]['id']

/** Title + tabs. One instance lives across both pages so the underline can slide between tabs. */
function TopNav({ view, onView }: { view: View; onView: (v: View) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const navRef = useRef<HTMLElement>(null)
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[view]
      if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (navRef.current) ro.observe(navRef.current)
    Object.values(refs.current).forEach((b) => b && ro.observe(b))
    document.fonts?.ready.then(measure)
    return () => ro.disconnect()
  }, [view])

  return (
    <div className="pointer-events-none flex flex-wrap items-baseline gap-x-[clamp(16px,3vw,44px)] gap-y-1">
      <span className="font-display text-[clamp(22px,2.7vw,40px)] font-bold leading-none tracking-[-0.06em] text-opal-50">
        Site Navigator
      </span>
      <nav ref={navRef} aria-label="Main" className="pointer-events-auto relative flex gap-[clamp(14px,2vw,32px)] pb-1">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            ref={(el) => {
              refs.current[v.id] = el
            }}
            type="button"
            aria-current={view === v.id ? 'page' : undefined}
            onClick={() => onView(v.id)}
            className="cursor-pointer font-[var(--font-inter)] text-[clamp(15px,1.9vw,28px)] font-bold leading-tight tracking-[-0.06em] text-opal-50 transition-colors duration-200 hover:text-opal-300"
          >
            {v.label}
          </button>
        ))}
        <span
          aria-hidden
          className="absolute bottom-0 h-[2px] rounded-full bg-opal-50 transition-[left,width] duration-[400ms] ease-[var(--md-ease-standard)]"
          style={bar ? { left: bar.left, width: bar.width } : { opacity: 0 }}
        />
      </nav>
    </div>
  )
}

const NAV_PAD = 'pl-[clamp(16px,4.5vw,65px)] pt-[clamp(14px,2.5vw,34px)]'

export default function App() {
  const [view, setView] = useState<View>('planner')
  const compare = view === 'compare'
  useEffect(() => initMaterialMotion(), [])

  return (
    <div className="relative h-full overflow-hidden bg-black">
      {/* The header is rendered once for both pages (floating over the 3D view, or above the comparison). */}
      <header className={`md-host absolute inset-x-0 top-0 z-30 pb-3 ${NAV_PAD} ${compare ? 'border-b border-line bg-black' : 'pointer-events-none'}`}>
        <TopNav view={view} onView={setView} />
      </header>
      {compare ? (
        <main key="compare" className="md-fade-through h-full overflow-y-auto pt-[calc(clamp(14px,2.5vw,34px)+clamp(22px,2.7vw,40px)+20px)]">
          <ComparisonDashboard onOpen3D={() => setView('planner')} />
        </main>
      ) : (
        <main key="planner" className="md-fade-through h-full">
          {/* Full-screen 3D simulation; the sidebar content is Member 5's mission-rescue panel. */}
          <Scene sidebar={<MissionRescue />} />
        </main>
      )}
    </div>
  )
}
