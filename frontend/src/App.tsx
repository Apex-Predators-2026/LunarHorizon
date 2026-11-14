import { useState } from 'react'

import { ComparisonDashboard } from './features/compare'
import { MissionRescue } from './features/rescue'
import { Scene } from './viz/Scene'

const VIEWS = [
  { id: 'planner', label: 'Mission planner' },
  { id: 'compare', label: 'Scenario comparison' }, // Member 4
] as const

type View = (typeof VIEWS)[number]['id']

export default function App() {
  const [view, setView] = useState<View>('planner')
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-6 border-b border-slate-800 px-4 py-2">
        <span className="py-1 font-semibold">Lunar Landing Site Navigator</span>
        <nav aria-label="Main" className="flex gap-1 text-sm">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" aria-current={view === v.id ? 'page' : undefined} onClick={() => setView(v.id)}
              className={`rounded px-3 py-1 ${view === v.id ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
              {v.label}
            </button>
          ))}
        </nav>
      </header>
      {view === 'compare' ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ComparisonDashboard />
        </main>
      ) : (
        <main className="flex min-h-0 flex-1">
          {/* Mission configuration panel (Nimansh) */}
          <aside className="w-72 border-r border-slate-800 p-4" />
          <div className="relative flex-1">
            <Scene />
          </div>
          {/* Mission rescue & optimization (Member 5) */}
          <aside className="w-[26rem] overflow-y-auto border-l border-slate-800 p-4">
            <MissionRescue />
          </aside>
        </main>
      )}
    </div>
  )
}
