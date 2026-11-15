// Science vs engineering: the landing that best satisfies both teams, or what each side
// would have to give up when nothing satisfies both.
import { headroomTone, resolveHeadroom, SCREENING_NOTE } from '../../lib/headroom'
import { LoadingIndicator } from '../../ui/LoadingIndicator'
import { MangoRange } from '../../ui/MangoRange'
import { SelectField, TextField } from '../../ui/MdFields'
import { PassHeadroom, PassHeadroomBadge } from '../../ui/PassHeadroom'
import { useEffect, useState } from 'react'

import { fetchRescueCatalog } from './api'
import { fmtUtc } from './format'
import { DataNote } from './RescuePanel'
import { verdictOf, type Scenario } from '../../types'
import type { CompromiseOption, CompromiseResponse, RescueCatalog } from './types'
import { useRescueStore } from './useRescueStore'


function OptionRow({ o, label, onSelect, tip }: { o: CompromiseOption; label?: string; onSelect: () => void; tip?: string }) {
  const hr = resolveHeadroom(o.viability)
  const elig = verdictOf(o.viability)
  const tone = headroomTone(hr, elig)
  const toneClass =
    tone === 'crit'
      ? 'text-red-300'
      : tone === 'warn'
        ? 'text-amber-200'
        : tone === 'unknown'
          ? 'text-slate-400'
          : 'text-emerald-200'

  return (
    <tr className="border-t border-slate-800 align-top">
      <td className="py-1.5 pr-2">
        {label && <div className="text-[11px] text-slate-500">{label}</div>}
        <button type="button" onClick={onSelect} data-tip={tip} className="text-left text-slate-200 hover:text-sky-300 hover:underline">
          {o.scenario.site.name}
        </button>
        <div className="text-[11px] text-slate-500">{fmtUtc(o.scenario.landing_utc)}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <PassHeadroomBadge headroom={hr} eligibility={elig} surface="planner" />
        </div>
        <div className={`mt-0.5 text-[11px] leading-snug ${toneClass}`}>{hr.qualified_verdict}</div>
        {hr.closest_constraint && (
          <div className="text-[11px] text-slate-400">Closest: {hr.closest_constraint.summary_text}</div>
        )}
      </td>
      <td className={`py-1.5 tabular-nums ${o.meets_engineering ? 'text-emerald-400' : 'text-red-400'}`}>
        {(o.engineering_score * 100).toFixed(0)}
      </td>
      <td className={`py-1.5 tabular-nums ${o.meets_science ? 'text-emerald-400' : 'text-red-400'}`}>
        {(o.science_score * 100).toFixed(0)}
      </td>
      <td className="py-1.5 tabular-nums text-slate-300">{o.distance_to_science_km.toFixed(1)} km</td>
    </tr>
  )
}

/**
 * `base` / `onPick` / `pickLabel` let the Scenario Comparison page use the same panel: it asks about one of the
 * compared plans and "picks" a result by adding it to the comparison (instead of showing it on the planner's map).
 */
export function CompromisePanel({ base, onPick, pickLabel = 'Use recommended plan' }: {
  base?: Scenario | null
  onPick?: (s: Scenario) => void
  pickLabel?: string
} = {}) {
  const s = useRescueStore()
  // On another page the result only shows if it was computed for the plan being asked about.
  const res = base && s.compromiseFor !== `${base.site.id}|${base.landing_utc}|${base.duration_days}` ? null : s.compromise
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
        <button type="button" disabled={loading || !(base ?? s.original)} onClick={() => void s.findCompromise(base ?? undefined)}
          data-tip="Find the landing that best balances what science and engineering each want."
          className="md-btn bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50">
          {loading ? <><LoadingIndicator size={20} contained={false} color="#ffffff" label="Searching" /><span className="ml-2">Searching…</span></> : 'Find best compromise'}
        </button>
      </div>

      {s.compromiseError && (
        <p role="alert" className="rounded border border-red-900 bg-red-950/50 p-2 text-xs text-red-300">{s.compromiseError}</p>
      )}

      {res && <CompromiseResults res={res} onSelect={onPick ?? s.select} pickLabel={pickLabel} />}
    </section>
  )
}

const sameOption = (a: CompromiseOption | null, b: CompromiseOption) =>
  a !== null && a.scenario.site.id === b.scenario.site.id && a.scenario.landing_utc === b.scenario.landing_utc

/** Pure display of a CompromiseResponse (no store access). */
export function CompromiseResults({ res, onSelect, pickLabel = 'Use recommended plan' }: { res: CompromiseResponse; onSelect: (s: Scenario) => void; pickLabel?: string }) {
  // The best-for-engineering and best-for-science rows are already shown first; don't repeat them.
  const isShownAbove = (o: CompromiseOption) => sameOption(res.best_for_engineering, o) || sameOption(res.best_for_science, o)
  const bestHr = res.best ? resolveHeadroom(res.best.viability) : null
  const bestElig = res.best ? verdictOf(res.best.viability) : null
  const bestLimited = bestHr !== null && (bestHr.status === 'limited' || bestHr.status === 'at_threshold')
  const bannerTone =
    res.status === 'both_met' && !bestLimited
      ? 'border-emerald-800 bg-emerald-950/40 text-emerald-200'
      : 'border-amber-800 bg-amber-950/40 text-amber-100'

  return (
    <div className="space-y-3 text-xs">
      <div role="status" className={`rounded-md border p-3 ${bannerTone}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{res.status === 'both_met' ? 'Both teams can be satisfied' : 'Trade-off required'}</h3>
          {bestHr && bestElig && (
            <PassHeadroomBadge headroom={bestHr} eligibility={bestElig} surface="planner" />
          )}
        </div>
        <p className="mt-1">{res.summary}</p>
        {res.suggestions.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {res.suggestions.map((t) => <li key={t}>{t}</li>)}
          </ul>
        )}
        {res.best && bestHr && (
          <PassHeadroom headroom={bestHr} surface="planner" compact className="mt-2" />
        )}
        {res.best && (
          <button type="button" onClick={() => onSelect(res.best!.scenario)}
            className="mt-2 rounded bg-sky-600 px-2 py-1 font-medium text-white hover:bg-sky-500">
            {pickLabel}
          </button>
        )}
      </div>

      <DataNote assumptions={res.assumptions} />

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
          {res.pareto_front.filter((o) => !isShownAbove(o)).map((o) => (
            <OptionRow key={`${o.scenario.site.id}@${o.scenario.landing_utc}`} o={o}
              onSelect={() => onSelect(o.scenario)} />
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-400" data-testid="compromise-screening-note">
        {SCREENING_NOTE}
      </p>
    </div>
  )
}
