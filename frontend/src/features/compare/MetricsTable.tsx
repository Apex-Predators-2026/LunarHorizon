// Section 3: side-by-side scientific metrics, best values marked, deltas against the baseline.
import { Fragment, useState } from 'react'

import { METRICS, bestIds, deltaVsBaseline, fmtDeltaValue, fmtMetric, type Entry, type MetricDef } from './analysis'
import { DataKindBadge, Explain, ProvenanceTag, ScenarioChip, Icon } from './ui'
import { useCompareStore } from './useCompareStore'

const GROUPS: { id: MetricDef['group']; title: string; note?: string }[] = [
  { id: 'solar', title: 'Solar power' },
  { id: 'power', title: 'Idealised solar incidence', note: 'Geometric upper bound: visible disk × max(0, cos θ). Not electrical output.' },
  { id: 'earth', title: 'Earth communication (geometric line of sight)', note: 'Earth above the local terrain. A working link also needs antenna pointing, ground stations and link margin.' },
  { id: 'mission', title: 'Mission performance (team viability evaluator)' },
]

export function MetricsTable({ entries }: { entries: Entry[] }) {
  const baselineId = useCompareStore((s) => s.baselineId)
  const [open, setOpen] = useState<Record<string, boolean>>({ solar: true, power: true, earth: true, mission: true })
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
                {open[g.id] && g.id === 'mission' && (
                  <tr>
                    <th scope="row" className="sticky left-0 bg-surface py-1 text-left text-xs font-normal text-slate-300">Verdict</th>
                    {entries.map((e) => {
                      const v = e.result?.viability
                      return (
                        <td key={e.scenario.id} className="py-1 pl-3 text-xs">
                          {v ? (v.passes ? <span className="inline-flex items-center gap-1 text-emerald-300"><Icon name="check" size={14} />passes</span> : <span className="inline-flex items-center gap-1 text-red-300"><Icon name="close" size={14} />fails</span>) : <span className="text-slate-500">—</span>}
                        </td>
                      )
                    })}
                  </tr>
                )}
                {open[g.id] && METRICS.filter((m) => m.group === g.id).map((m) => {
                  const best = bestIds(entries, m)
                  return (
                    <tr key={m.id} className="hover:bg-inset">
                      <th scope="row" title={m.hint} className="sticky left-0 bg-surface py-1 pr-2 text-left text-xs font-normal text-slate-300">
                        <span className="mr-1.5">{m.label}</span><ProvenanceTag p={m.provenance} />
                      </th>
                      {entries.map((e) => {
                        const v = e.result ? m.get(e.result, e.scenario) : null
                        const d = deltaVsBaseline(m, e, base)
                        const isBest = best.has(e.scenario.id)
                        return (
                          <td key={e.scenario.id} className="py-1 pl-3 align-top tabular-nums">
                            <span className={isBest ? 'font-medium text-slate-50' : 'text-slate-300'}>{fmtMetric(v, m.unit)}</span>
                            {isBest && <span className="ml-1 text-xs text-emerald-300" title="Best among compared real-data scenarios">best</span>}
                            {d && (
                              <span className={`block text-[11px] ${d.better === null ? 'text-slate-500' : d.better ? 'text-emerald-400' : 'text-red-400'}`}>
                                {d.better === null ? '' : d.better ? '▲ ' : '▼ '}{fmtDeltaValue(d.value, m.unit)} vs {base!.scenario.label}
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
