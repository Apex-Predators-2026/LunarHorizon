import type { ReactNode } from 'react'
import type { Scenario } from '../../types'
import { fmtUtc } from '../rescue/format'

const ACTION_PATH = {
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  duplicate: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z',
  remove: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
}

export function PlanActionButton({ action, label, tip, onClick }: {
  action: keyof typeof ACTION_PATH
  label: string
  tip: string
  onClick: () => void
}) {
  return (
    <button type="button" aria-label={label} data-tip={tip}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400 hover:text-slate-100"
      onClick={onClick}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={ACTION_PATH[action]} />
      </svg>
    </button>
  )
}

export function PlanCardLayout({ name, active, children }: { name: string; active: boolean; children: ReactNode }) {
  return (
    <li className={`md-reveal relative rounded-2xl border p-4 transition-colors ${active ? 'border-coral bg-coral/10' : 'border-slate-800 bg-panel-fill/60'}`}
      aria-label={`Plan ${name}`}>
      {children}
    </li>
  )
}

export function PlanCardHeading({ name, scenario }: { name: string; scenario: Pick<Scenario, 'site' | 'landing_utc' | 'duration_days'> }) {
  return (
    <div className="min-w-0">
      <p className="break-words text-sm font-semibold text-slate-100">{name}</p>
      <p className="mt-1 text-xs text-slate-400">
        {scenario.site.name} · {fmtUtc(scenario.landing_utc)} · {scenario.duration_days} d
      </p>
    </div>
  )
}
