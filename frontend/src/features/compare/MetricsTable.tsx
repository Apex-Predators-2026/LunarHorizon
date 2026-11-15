// Section 3: side-by-side scientific metrics, best values marked, deltas against the baseline.
import { Fragment, useState } from 'react'

import { formatMarginMetric, marginStatusClassLabel } from '../../lib/headroom'
import type { MarginStatus } from '../../types'
import { PassHeadroomBadge } from '../../ui/PassHeadroom'
import { METRICS, bestIds, bestPool, deltaVsBaseline, eligibilityOf, fmtDeltaValue, fmtMetric, groupCountOf, headroomOfEntry, rankText, requirementMatrix, requirementSummary, type Entry, type MetricDef } from './analysis'
import { DataKindBadge, EligibilityBadge, Explain, ProvenanceTag, RankBadge, ReqIcon, ScenarioChip } from './ui'
import { useCompareStore } from './useCompareStore'
import { AskButton } from './assistant/AskButton'

function marginBadgeClass(cls: MarginStatus): string {
  if (cls === 'narrow' || cls === 'at_threshold') return 'border-warn/45 bg-inset text-warn'
  if (cls === 'negative') return 'border-crit/40 bg-inset text-crit'
  if (cls === 'comfortable') return 'border-ok/35 bg-inset text-ok'
  return 'border-line-strong bg-inset text-unknown'
}

const DIRECTION: Record<'higher' | 'lower', { mark: string; text: string }> = {
  higher: { mark: '↑', text: 'higher is better' },
  lower: { mark: '↓', text: 'lower is better' },
}

// Solar and Earth conditions first, then the engine's mission figures; the idealised panel factor is a secondary aid.
const GROUPS: { id: MetricDef['group']; title: string; note?: string }[] = [
  { id: 'solar', title: 'Solar conditions' },
  { id: 'earth', title: 'Earth communication (geometric line of sight)', note: 'Earth above the local terrain. A working link also needs antenna pointing, ground stations and link margin.' },
  { id: 'mission', title: 'Mission viability (canonical engine)' },
  { id: 'power', title: 'Idealised solar incidence (secondary)', note: 'Geometric upper bound: visible disk × max(0, cos θ). Not electrical output.' },
]

export function MetricsTable({ entries }: { entries: Entry[] }) {
  const groupCount = groupCountOf(entries)
  const baselineId = useCompareStore((s) => s.baselineId)
  const [open, setOpen] = useState<Record<string, boolean>>({ requirements: true, solar: true, earth: true, mission: true, power: false })
  const requirements = requirementMatrix(entries)
  // "most requirements met": a single scenario strictly ahead of every other one in the same fair pool as "best"
  // (same data kind, duration and requirements; nobody missing), so counts are of the same requirements.
  const pool = bestPool(entries)
  const illustrative = pool.basis === 'illustrative'
  const metCounts = pool.entries.map((e) => ({ id: e.scenario.id, n: requirementSummary(e)?.passed ?? null }))
  const maxMet = Math.max(...metCounts.map((x) => x.n ?? -1))
  const leaders = metCounts.filter((x) => x.n === maxMet)
  const mostMet = new Set(metCounts.length >= 2 && metCounts.every((x) => x.n !== null) && leaders.length === 1 ? [leaders[0].id] : [])
  const base = entries.find((e) => e.scenario.id === baselineId)
  const cols = entries.length

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Scientific metrics for each compared scenario</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-surface pb-2 text-left text-xs font-medium text-slate-400">Metric</th>
              {entries.map((e) => (
                <th key={e.scenario.id} scope="col" className="pb-2 pl-3 text-left text-xs font-medium text-slate-300">
                  <span className="flex items-center gap-1.5"><ScenarioChip s={e.scenario} size="sm" />
                    <span className="truncate">{e.scenario.site.name}</span></span>
                  {e.result?.data_kind === 'demonstration' && <span className="mt-0.5 block"><DataKindBadge kind="demonstration" /></span>}
                  {e.state?.state === 'done' && !e.result && <span className="mt-0.5 block"><DataKindBadge kind="unavailable" /></span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Status first: the engine's verdict on every applicable mission requirement. */}
            <tr>
              <th colSpan={cols + 1} scope="colgroup" className="pt-1 text-left">
                <button type="button" className="text-sm font-medium text-ink" aria-expanded={open.requirements}
                  onClick={() => setOpen({ ...open, requirements: !open.requirements })}>
                  {open.requirements ? '▾' : '▸'} Mission requirements (canonical viability engine)
                </button>
                {open.requirements && (
                  <div className="text-[11px] font-normal text-slate-500">
                    Measured value against the requirement, as judged by the engine. A cross is a proven violation; a question mark means the data cannot decide it.
                  </div>
                )}
              </th>
            </tr>
            {open.requirements && (
              <tr>
                <th scope="row" className="sticky left-0 bg-surface py-1 text-left text-xs font-normal text-slate-300">Eligibility · canonical rank</th>
                {entries.map((e) => {
                  const elig = eligibilityOf(e)
                  const hr = headroomOfEntry(e)
                  return (
                    <td key={e.scenario.id} className="py-1 pl-3 text-xs">
                      {elig ? (
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <EligibilityBadge eligibility={elig} />
                          <PassHeadroomBadge headroom={hr} eligibility={elig} surface="compare" />
                          {rankText(e.ranking, groupCount) && <RankBadge text={rankText(e.ranking, groupCount)!} />}
                        </span>
                      ) : <span className="text-slate-500" title="No canonical assessment">—</span>}
                    </td>
                  )
                })}
              </tr>
            )}
            {open.requirements && (
              <tr className="hover:bg-inset">
                <th scope="row" className="sticky left-0 bg-surface py-1 pr-2 text-left text-xs font-normal text-slate-300">Closest requirement to limit</th>
                {entries.map((e) => {
                  const hr = headroomOfEntry(e)
                  const closest = hr?.closest_constraint
                  return (
                    <td key={e.scenario.id} className="py-1 pl-3 align-top text-xs tabular-nums" title={closest?.summary_text}>
                      {closest ? (
                        <span className="inline-flex flex-col">
                          <span className={closest.margin_class === 'narrow' || closest.margin_class === 'at_threshold' ? 'text-warn' : closest.margin_class === 'negative' ? 'text-crit' : 'text-slate-200'}>
                            {closest.label} ({closest.headroom_text})
                          </span>
                          <span className="text-[11px] text-slate-500">{marginStatusClassLabel(closest.margin_class)}</span>
                        </span>
                      ) : <span className="text-slate-500">—</span>}
                    </td>
                  )
                })}
              </tr>
            )}
            {open.requirements && (
              <tr>
                <th scope="row" className="sticky left-0 bg-surface py-1 text-left text-xs font-normal text-slate-300">Requirements met</th>
                {entries.map((e) => {
                  const r = requirementSummary(e)
                  const most = r !== null && mostMet.has(e.scenario.id)
                  return (
                    <td key={e.scenario.id} className="py-1 pl-3 text-xs tabular-nums">
                      {r ? <span className={most ? 'font-medium text-slate-50' : 'text-slate-300'}>{r.passed} of {r.applicable}</span> : <span className="text-slate-500">—</span>}
                      {most && <span className="ml-1 text-xs text-emerald-300" title="Meets more requirements than every other compared scenario">most</span>}
                    </td>
                  )
                })}
              </tr>
            )}
            {open.requirements && requirements.map((row) => (
              <tr key={row.id} className="group hover:bg-inset">
                <th scope="row" className="sticky left-0 bg-surface py-1 pr-2 text-left text-xs font-normal text-slate-300">
                  {row.name}
                  {Object.values(row.cells).some((c) => c && (c.status === 'fail' || c.status === 'unknown')) && (
                    <AskButton iconOnly className="ml-1 align-middle"
                      question={`Explain the requirement “${row.name}”: which scenarios fail it or cannot decide it, and why?`} />
                  )}
                </th>
                {entries.map((e) => {
                  const c = row.cells[e.scenario.id]
                  const marginText = c && c.margin.status !== 'unavailable' ? formatMarginMetric(c.margin, true) : null
                  const isNarrow = c ? (c.marginClass === 'narrow' || c.marginClass === 'at_threshold') : false
                  return (
                    <td key={e.scenario.id} className="py-1 pl-3 align-top text-xs tabular-nums" title={c?.narrowReason ?? c?.message}>
                      {!c ? <span className="text-slate-500">—</span> : c.status === 'not_applicable' ? (
                        <span className="text-slate-500">not required</span>
                      ) : (
                        <span className="inline-flex items-start gap-1">
                          <ReqIcon status={c.status} />
                          <span>
                            <span className={c.status === 'fail' ? 'text-red-300' : isNarrow ? 'text-warn' : 'text-slate-200'}>{c.measured}</span>
                            {c.threshold && <span className="text-slate-500"> (required {c.threshold})</span>}
                            {marginText && marginText !== 'unavailable' && (
                              <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px]">
                                <span className={c.marginClass === 'negative' ? 'text-red-300' : isNarrow ? 'text-warn' : c.marginClass === 'comfortable' ? 'text-emerald-300' : 'text-slate-400'}>
                                  headroom {marginText}
                                </span>
                                <span className={`inline-flex items-center rounded border px-1 py-px text-[10px] font-medium leading-none ${marginBadgeClass(c.marginClass)}`}>
                                  {marginStatusClassLabel(c.marginClass)}
                                </span>
                              </span>
                            )}
                            {c.narrowReason && (
                              <span className="mt-0.5 block text-[11px] text-warn">{c.narrowReason}</span>
                            )}
                          </span>
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
            {GROUPS.map((g) => (
              <Fragment key={g.id}>
                <tr>
                  <th colSpan={cols + 1} scope="colgroup" className="border-t border-line pt-3 text-left">
                    <button type="button" className="text-sm font-medium text-ink"
                      aria-expanded={open[g.id]} onClick={() => setOpen({ ...open, [g.id]: !open[g.id] })}>
                      {open[g.id] ? '▾' : '▸'} {g.title}
                    </button>
                    {g.note && open[g.id] && <div className="text-[11px] font-normal text-slate-500">{g.note}</div>}
                  </th>
                </tr>
                {open[g.id] && METRICS.filter((m) => m.group === g.id).map((m) => {
                  const best = bestIds(entries, m)
                  return (
                    <tr key={m.id} className="group hover:bg-inset">
                      <th scope="row" title={m.hint} className="sticky left-0 bg-surface py-1 pr-2 text-left text-xs font-normal text-slate-300">
                        <span className="mr-1">{m.label}</span>
                        {m.better && (
                          <span className="mr-1.5 text-slate-500" title={DIRECTION[m.better].text} aria-label={DIRECTION[m.better].text}>{DIRECTION[m.better].mark}</span>
                        )}
                        <ProvenanceTag p={m.provenance} />
                        <AskButton iconOnly className="ml-1 align-middle" question={`Explain the metric “${m.label}” and how the selected scenarios compare on it.`} />
                      </th>
                      {entries.map((e) => {
                        const v = e.result ? m.get(e.result, e.scenario) : null
                        const d = deltaVsBaseline(m, e, base)
                        const isBest = best.has(e.scenario.id)
                        return (
                          <td key={e.scenario.id} className="py-1 pl-3 align-top tabular-nums">
                            <span className={isBest ? 'font-medium text-slate-50' : 'text-slate-300'}>{(e.result && m.text?.(e.result, e.scenario)) ?? fmtMetric(v, m.unit)}</span>
                            {isBest && <span className="ml-1 text-xs text-emerald-300" title={illustrative ? 'Best among demonstration results only: illustrative' : 'A meaningful, proven lead among comparable real-data scenarios. Descriptive, not a recommendation.'}>{illustrative ? 'best (illustrative)' : 'best'}</span>}
                            {d && (
                              <span className={`block text-[11px] ${d.better === null ? 'text-slate-500' : d.better ? 'text-emerald-400' : 'text-red-400'}`}>
                                {d.better === null ? (m.better && !d.meaningful && Math.abs(d.value) > 1e-9 ? '≈ ' : '') : d.better ? '▲ better ' : '▼ worse '}
                                {fmtDeltaValue(d.value, m.unit)} vs {base!.scenario.label}
                              </span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Tags: <b>ephemeris</b> = JPL Horizons Sun/Earth positions · <b>derived</b> = computed from the Horizons + LOLA timeline ·{' '}
        <b>idealised</b> = geometric upper bound · <b>viability</b> = team viability evaluator · <b>config</b> = your inputs.
        {' '}↑ / ↓ = which direction is better. “best” is only shown when the lead is meaningful (e.g. ≥ 1 percentage point, ≥ 2 h); ≈ marks a negligible difference.
        {!base && ' Set a baseline scenario to see improvements (▲) and regressions (▼).'}
      </p>
      <Explain title="What do these metrics mean?">
        <p><b>Solar elevation</b> is the Sun’s angle above the ideal flat horizon. Near the south pole it stays within a few degrees of 0°, so the Sun skims along the horizon all day.</p>
        <p><b>Sun clearance</b> is how far the Sun sits above the <i>actual</i> terrain in that direction. A crater rim or ridge that rises 1.5° above flat will hide a Sun at 1° elevation, which is why two sites with the same Sun elevation can have very different sunlight.</p>
        <p><b>Longest darkness</b> matters because the lander lives on its battery until the Sun returns; it must be shorter than the battery can survive. The viability “power gap” also counts hours when too little of the disk is visible for the panels (below the panel threshold).</p>
        <p><b>Incidence factor</b> = share of the solar disk above the terrain × cos θ (θ = angle between Sun and panel normal). It is 1 only for a panel pointed straight at a fully visible Sun. Real power is lower (efficiency, temperature, degradation, dust).</p>
      </Explain>
    </div>
  )
}
