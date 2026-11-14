// Member 5's panel: plan, then "Rescue" or "Science vs engineering" tabs.
import { useState } from 'react'

import { CompromisePanel } from './CompromisePanel'
import { fmtUtc } from './format'
import { RescuePanel } from './RescuePanel'
import { useRescueStore } from './useRescueStore'

const TABS = [
  { id: 'rescue', label: 'Mission rescue', tip: 'When a plan slips or a requirement changes, search for alternative landing dates and sites that still work.' },
  { id: 'compromise', label: 'Science vs engineering', tip: 'Find a landing site that balances what the science team wants against what is safe to land and operate.' },
] as const

export function MissionRescue() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('rescue')
  const original = useRescueStore((s) => s.original)
  const selected = useRescueStore((s) => s.selected)

  return (
    <div className="space-y-6">
      {selected && selected !== original && (
        <p className="text-xs text-sky-300">
          Viewing: {selected.site.name}, {fmtUtc(selected.landing_utc)}
        </p>
      )}

      <div role="tablist" aria-label="Rescue tools" className="flex border-b border-slate-800 text-xs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tip={t.tip}
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px h-12 border-b-2 px-4 ${tab === t.id ? 'border-sky-500 text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">{tab === 'rescue' ? <RescuePanel /> : <CompromisePanel />}</div>
    </div>
  )
}
