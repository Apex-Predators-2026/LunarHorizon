// Science vs engineering: the landing that best satisfies both teams, or what each side
// would have to give up when nothing satisfies both.
import { MangoRange } from '../../ui/MangoRange'
import { SelectField, TextField } from '../../ui/MdFields'
import { useEffect, useState } from 'react'

import { fetchRescueCatalog } from './api'
import { fmtUtc } from './format'
import type { Scenario } from '../../types'
import type { CompromiseOption, CompromiseResponse, RescueCatalog } from './types'
import { useRescueStore } from './useRescueStore'


function OptionRow({ o, label, onSelect }: { o: CompromiseOption; label?: string; onSelect: () => void }) {
  return (
    <tr className="border-t border-slate-800">
      <td className="py-1">
        {label && <div className="text-[11px] text-slate-500">{label}</div>}
        <button type="button" onClick={onSelect} className="text-left text-slate-200 hover:text-sky-300 hover:underline">
          {o.scenario.site.name}
        </button>
        <div className="text-[11px] text-slate-500">{fmtUtc(o.scenario.landing_utc)}</div>
      </td>
      <td className={`tabular-nums ${o.meets_engineering ? 'text-emerald-400' : 'text-red-400'}`}>
        {(o.engineering_score * 100).toFixed(0)}
      </td>
      <td className={`tabular-nums ${o.meets_science ? 'text-emerald-400' : 'text-red-400'}`}>
        {(o.science_score * 100).toFixed(0)}
      </td>
      <td className="tabular-nums text-slate-300">{o.distance_to_science_km.toFixed(1)} km</td>
    </tr>
  )
}

export function CompromisePanel() {
  const s = useRescueStore()
  const res = s.compromise
  const loading = s.compromiseStatus === 'loading'
  const sciShare = s.weights.science / (s.weights.science + s.weights.engineering || 1)
  const [psrs, setPsrs] = useState<RescueCatalog['psrs']>([])

  useEffect(() => {
    const ctl = new AbortController()
    fetchRescueCatalog(ctl.signal).then((c) => setPsrs(c.psrs)).catch(() => {})
    return () => ctl.abort()
  }, [])

  return (
    <section aria-label="Science and engineering compromise" className="space-y-3">
      <div className="grid grid-cols-1 gap-2 text-xs">
        <SelectField
          label="Science target (where the ice is)"
          tip="The shadowed crater the science team wants to reach."
          value={s.science.target_psr_id ?? ''}
          onChange={(e) => s.setScience({ target_psr_id: e.target.value || null })}
        >
          <option value="">Nearest shadowed crater</option>
          {psrs.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </SelectField>
        <TextField
          label="Max drive to target (km)"
          tip="The farthest the rover can drive from the landing site to the science target."
          type="number" min={1} value={s.science.max_traverse_km ?? 15}
          onChange={(e) => s.setScience({ max_traverse_km: Number(e.target.value) || 15 })}
        />
        <TextField
          label="Min science score (0–1)"
          tip="The lowest science value a landing site may have to be considered."
          type="number" min={0} max={1} step={0.05} value={s.science.min_science_score ?? 0.5}
          onChange={(e) => s.setScience({ min_science_score: Number(e.target.value) })}
        />
        <label className="flex flex-col gap-1 text-slate-400" data-tip="Slide toward engineering to favour safe, easy missions, or toward science to favour valuable targets.">
          Priority: engineering {Math.round((1 - sciShare) * 100)}% / science {Math.round(sciShare * 100)}%
          <MangoRange min={0} max={100} value={Math.round(sciShare * 100)}
            onChange={(e) => {
              const v = Number(e.target.value) / 100
              s.setWeights({ science: Math.max(v, 0.001), engineering: Math.max(1 - v, 0.001) })
            }} />
        </label>
        <button type="button" disabled={loading || !s.original} onClick={() => void s.findCompromise()}
          data-tip="Find the landing that best balances what science and engineering each want."
          className="md-btn bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50">
          {loading ? 'Searching…' : 'Find best compromise'}
        </button>
      </div>

      {s.error && s.compromiseStatus === 'error' && (
        <p role="alert" className="rounded border border-red-900 bg-red-950/50 p-2 text-xs text-red-300">{s.error}</p>
      )}

      {res && <CompromiseResults res={res} onSelect={s.select} />}
    </section>
  )
}

/** Pure display of a CompromiseResponse (no store access). */
export function CompromiseResults({ res, onSelect }: { res: CompromiseResponse; onSelect: (s: Scenario) => void }) {
  return (
    <div className="space-y-3 text-xs">
      <div role="status" className={`rounded-md border p-3 ${res.status === 'both_met'
        ? 'border-emerald-800 bg-emerald-950/40 text-emerald-200'
        : 'border-amber-800 bg-amber-950/40 text-amber-100'}`}>
        <h3 className="text-sm font-medium">{res.status === 'both_met' ? 'Both teams can be satisfied' : 'Trade-off required'}</h3>
        <p className="mt-1">{res.summary}</p>
        {res.suggestions.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {res.suggestions.map((t) => <li key={t}>{t}</li>)}
          </ul>
        )}
        {res.best && (
          <button type="button" onClick={() => onSelect(res.best!.scenario)}
            className="mt-2 rounded bg-sky-600 px-2 py-1 font-medium text-white hover:bg-sky-500">
            Use recommended plan
          </button>
        )}
      </div>

      <table className="w-full">
        <caption className="pb-1 text-left text-[11px] text-slate-500">
          Best trade-offs: none of these beats another on both engineering and science. Green = meets that team's goal.
        </caption>
        <thead>
          <tr className="text-left text-slate-500">
            <th className="font-normal">Option</th>
            <th className="font-normal">Eng.</th>
            <th className="font-normal">Sci.</th>
            <th className="font-normal">To target</th>
          </tr>
        </thead>
        <tbody>
          {res.best_for_engineering && (
            <OptionRow o={res.best_for_engineering} label="Best for engineering"
              onSelect={() => onSelect(res.best_for_engineering!.scenario)} />
          )}
          {res.best_for_science && (
            <OptionRow o={res.best_for_science} label="Best for science"
              onSelect={() => onSelect(res.best_for_science!.scenario)} />
          )}
          {res.pareto_front.map((o) => (
            <OptionRow key={`${o.scenario.site.id}@${o.scenario.landing_utc}`} o={o}
              onSelect={() => onSelect(o.scenario)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
