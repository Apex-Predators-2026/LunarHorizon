// Member 5's panel: plan, then "Rescue" or "Science vs engineering" tabs.
import { useState } from 'react'

import { CompromisePanel } from './CompromisePanel'
import { fmtUtc } from './format'
import { PlanForm } from './PlanForm'
import { RescuePanel } from './RescuePanel'
import { useRescueStore } from './useRescueStore'

const TABS = [
  { id: 'rescue', label: 'Mission rescue' },
  { id: 'compromise', label: 'Science vs engineering' },
] as const

export function MissionRescue() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('rescue')
  const original = useRescueStore((s) => s.original)
  const selected = useRescueStore((s) => s.selected)

  return (
    <div className="space-y-4">
      <section aria-label="Plan">
        <h2 className="mb-2 text-sm font-semibold text-slate-100">Plan</h2>
        <PlanForm />
        {original && (
          <p className="mt-2 text-xs text-slate-400">
            Current: <span className="text-slate-200">{original.site.name}</span>, {fmtUtc(original.landing_utc)},{' '}
            {original.duration_days} days
          </p>
        )}
        {selected && selected !== original && (
          <p className="mt-1 text-xs text-sky-300">
            Viewing: {selected.site.name}, {fmtUtc(selected.landing_utc)}
          </p>
        )}
      </section>

      <div role="tablist" aria-label="Rescue tools" className="flex border-b border-slate-800 text-xs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-1.5 ${tab === t.id ? 'border-sky-500 text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">{tab === 'rescue' ? <RescuePanel /> : <CompromisePanel />}</div>
    </div>
  )
}
