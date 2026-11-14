import { useState } from 'react'

import { ComparisonDashboard } from './features/compare'
import { MissionRescue } from './features/rescue'
import { Scene } from './viz/Scene'

const VIEWS = [
  { id: 'planner', label: 'Mission Planner' },
  { id: 'compare', label: 'Scenario Comparison' }, // Member 4
] as const

type View = (typeof VIEWS)[number]['id']

function TopNav({ view, onView }: { view: View; onView: (v: View) => void }) {
  return (
    <div className="pointer-events-none flex flex-wrap items-baseline gap-x-[clamp(16px,3vw,44px)] gap-y-1">
      <span className="font-display text-[clamp(22px,2.7vw,40px)] font-bold leading-none tracking-[-0.06em] text-opal-50">
        Site Navigator
      </span>
      <nav aria-label="Main" className="pointer-events-auto flex gap-[clamp(14px,2vw,32px)]">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            aria-current={view === v.id ? 'page' : undefined}
            onClick={() => onView(v.id)}
            className={`cursor-pointer font-[var(--font-inter)] text-[clamp(15px,1.9vw,28px)] font-bold leading-tight tracking-[-0.06em] text-opal-50 transition-colors duration-200 hover:text-opal-300 ${
              view === v.id ? 'underline decoration-2 underline-offset-4' : ''
            }`}
          >
            {v.label}
          </button>
        ))}
      </nav>
    </div>
  )
}

export default function App() {
  const [view, setView] = useState<View>('planner')

  if (view === 'compare') {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-line bg-black px-[clamp(16px,3vw,48px)] py-3">
          <TopNav view={view} onView={setView} />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ComparisonDashboard onOpen3D={() => setView('planner')} />
        </main>
      </div>
    )
  }

  return (
    <main className="relative h-full overflow-hidden bg-black">
      {/* Full-screen 3D simulation; the sidebar content is Member 5's mission-rescue panel. */}
      <Scene
        sidebar={<MissionRescue />}
      />
      <header className="pointer-events-none absolute left-[clamp(16px,4.5vw,65px)] top-[clamp(14px,2.5vw,34px)] z-30">
        <TopNav view={view} onView={setView} />
      </header>
    </main>
  )
}
