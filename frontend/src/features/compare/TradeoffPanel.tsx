// Section 7: science vs engineering trade-off. User-defined weights over four criteria; the measured values
// behind each criterion are always shown. This is a preference ranking, not a mission viability assessment:
// only options the viability engine passes can be ranked ("Recommended feasible options"); the others are shown
// apart, labelled, with the requirement that rules each one out. Weights can explain why an infeasible option is
// attractive, never make it a recommendation.
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip } from 'recharts'

import { CRITERIA, WEIGHT_PRESETS, computeTradeoff, isFeasible, type CriterionKey, type Entry, type TradeoffRow } from './analysis'
import { STATE, seriesColor, seriesDash } from './palette'
import { EligibilityBadge, Explain, ScenarioChip, btn, input } from './ui'

const CRITERION_COLORS = ['#e8b84a', '#5aa9f0', '#b58cf0', '#4fbf8f']

/** One option: its weighted value and the criteria's contributions as a bar. */
function OptionRow({ r, label, muted = false }: { r: TradeoffRow; label: string | null; muted?: boolean }) {
  return (
    <li className={muted ? 'opacity-80' : undefined}>
      <div className="mb-0.5 flex items-center gap-2 text-xs">
        {label !== null && <span className="w-5 font-medium text-slate-500">{label}</span>}
        <ScenarioChip s={r.entry.scenario} size="sm" />
        <span className="min-w-0 flex-1 truncate text-slate-200">{r.entry.scenario.site.name}</span>
        {!isFeasible(r) && r.eligibility && <EligibilityBadge eligibility={r.eligibility} />}
        <span className="tabular-nums font-medium text-slate-100" title={r.missing.join('; ') || undefined}>
          {r.weighted === null ? 'incomplete' : (r.weighted * 100).toFixed(0)}
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded bg-slate-800" aria-hidden="true">
        {CRITERIA.map((c, i) => (
          <div key={c.key} title={`${c.label}: ${r.contributions[c.key] === null ? 'unknown' : '+' + (r.contributions[c.key]! * 100).toFixed(1)}`}
            style={{ width: `${(r.contributions[c.key] ?? 0) * 100}%`, background: CRITERION_COLORS[i], opacity: muted ? 0.55 : 1 }}
            className="border-r-2 border-surface last:border-r-0" />
        ))}
      </div>
      {r.blockers.length > 0 && (
        <p className="mt-0.5 text-[11px] text-red-300">
          {r.eligibility === 'fail' ? 'Ruled out by: ' : 'Not decidable: '}{r.blockers.join(', ')}
        </p>
      )}
    </li>
  )
}
import { useCompareStore } from './useCompareStore'

export function TradeoffPanel({ entries }: { entries: Entry[] }) {
  const weights = useCompareStore((s) => s.weights)
  const setWeights = useCompareStore((s) => s.setWeights)
  const traverseKm = useCompareStore((s) => s.traverseKm)
  const setTraverseKm = useCompareStore((s) => s.setTraverseKm)
  const rows = computeTradeoff(entries, weights, traverseKm)
  const feasible = rows.filter(isFeasible)
  const ranked = feasible.filter((r) => r.rank !== null)
  const others = rows.filter((r) => !isFeasible(r))
  const total = weights.solar + weights.comms + weights.science + weights.safety
  const radar = CRITERIA.map((c) => ({ criterion: c.label, ...Object.fromEntries(rows.map((r) => [r.entry.scenario.id, r.scores[c.key] === null ? null : Math.round(r.scores[c.key]! * 100)])) }))

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <div className="space-y-3">
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-2.5 text-[11px] leading-snug text-amber-100">
          <b>User preferences, not a NASA assessment.</b> Weights are yours; they only order the options that already meet
          every requirement. Options that don't are listed apart with the requirement that rules them out: the sliders can
          show why one is attractive, never make it feasible. Measured values are listed next to each score. The science
          criterion uses an approximate, demonstration PSR catalog.
        </div>
        <div className="flex flex-wrap gap-1">
          {Object.entries(WEIGHT_PRESETS).map(([k, p]) => (
            <button key={k} type="button" className={btn} onClick={() => setWeights(p.weights)}
              aria-pressed={CRITERIA.every((c) => p.weights[c.key] === weights[c.key])}>
              {p.label}
            </button>
          ))}
        </div>
        {CRITERIA.map((c) => (
          <label key={c.key} className="block text-xs text-slate-300">
            <span className="flex justify-between"><span>{c.label}</span>
              <span className="tabular-nums text-slate-400">{total > 0 ? Math.round((weights[c.key] / total) * 100) : 0}%</span></span>
            <input type="range" min={0} max={5} step={0.5} value={weights[c.key]} className="w-full"
              onChange={(e) => setWeights({ [c.key]: Number(e.target.value) } as Partial<Record<CriterionKey, number>>)} />
            <span className="block text-[11px] text-slate-500">{c.basis}</span>
          </label>
        ))}
        <label className="block text-xs text-slate-300">
          Max science traverse (km)
          <input type="number" min={1} max={200} className={input} value={traverseKm}
            onChange={(e) => Number(e.target.value) > 0 && setTraverseKm(Number(e.target.value))} />
          <span className="block text-[11px] text-slate-500">Science index = 1 − distance to nearest PSR edge ÷ this distance (as in Mission Rescue’s compromise).</span>
        </label>
      </div>

      <div className="min-w-0 space-y-4">
        {rows.length < 2 ? (
          <p className="text-xs text-slate-500">Needs at least two plans with comparable data.</p>
        ) : (
          <>
            <div className="grid gap-4 xl:grid-cols-2">
              <div style={{ height: 260 }} role="img" aria-label="Radar chart of criterion scores per plan">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radar} outerRadius="72%">
                    <PolarGrid stroke={STATE.grid} />
                    <PolarAngleAxis dataKey="criterion" tick={{ fill: STATE.ink, fontSize: 10 }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={{ fill: STATE.axis, fontSize: 9 }} stroke={STATE.grid} angle={90} />
                    <Tooltip isAnimationActive={false} content={({ active, payload, label }) => active && payload?.length ? (
                      <div className="cmp-tip">
                        <div className="mb-1 text-slate-300">{label}</div>
                        {rows.map((r) => (
                          <div key={r.entry.scenario.id} className="flex items-center gap-2"><ScenarioChip s={r.entry.scenario} size="sm" />
                            <span className="tabular-nums">{payload.find((p) => p.dataKey === r.entry.scenario.id)?.value}/100</span></div>
                        ))}
                      </div>
                    ) : null} />
                    {rows.map((r) => (
                      <Radar key={r.entry.scenario.id} dataKey={r.entry.scenario.id} stroke={seriesColor(r.entry.scenario.colorSlot)}
                        strokeDasharray={seriesDash(r.entry.scenario.colorSlot)} strokeWidth={2}
                        fill={seriesColor(r.entry.scenario.colorSlot)} fillOpacity={0.08} isAnimationActive={false} />
                    ))}
                  </RadarChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-4">
                <section aria-label="Recommended feasible options">
                  <h3 className="mb-1 text-xs font-medium text-slate-200">Recommended feasible options</h3>
                  {feasible.length === 0 ? (
                    <p className="text-xs text-slate-400">
                      None of these plans meets every requirement, so none can be recommended. The options below show only
                      how your priorities rate them.
                    </p>
                  ) : (
                    <>
                      <p className="mb-2 text-[11px] text-slate-500">
                        {ranked.length > 1
                          ? 'Meet every requirement; ordered by your weights (weighted contributions).'
                          : 'The only option that meets every requirement with complete data: nothing to rank it against.'}
                      </p>
                      <ol className="space-y-2">
                        {feasible.map((r) => <OptionRow key={r.entry.scenario.id} r={r} label={ranked.length > 1 && r.rank !== null ? `#${r.rank}` : r.rank === null ? '-' : null} />)}
                      </ol>
                    </>
                  )}
                </section>
                {others.length > 0 && (
                  <section aria-label="Other options and trade-offs">
                    <h3 className="mb-1 text-xs font-medium text-slate-200">Other options and trade-offs</h3>
                    <p className="mb-2 text-[11px] text-slate-500">Don't meet the requirements (or can't be decided), so never recommended; scored only to show the trade-off.</p>
                    <ul className="space-y-2">
                      {others.map((r) => <OptionRow key={r.entry.scenario.id} r={r} label={null} muted />)}
                    </ul>
                  </section>
                )}
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
                  {CRITERIA.map((c, i) => (
                    <span key={c.key} className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm" style={{ background: CRITERION_COLORS[i] }} />{c.label}</span>
                  ))}
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <caption className="mb-1 text-left text-[11px] text-slate-400">Underlying values (score 0–100 in brackets)</caption>
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="py-1 font-normal">Plan</th>
                    {CRITERIA.map((c) => <th key={c.key} className="py-1 pl-2 font-normal">{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.entry.scenario.id} className="border-t border-line">
                      <td className="py-1"><ScenarioChip s={r.entry.scenario} size="sm" /></td>
                      {CRITERIA.map((c) => (
                        <td key={c.key} className="py-1 pl-2 text-slate-300">
                          {r.raw[c.key]} <span className="tabular-nums text-slate-500">[{r.scores[c.key] === null ? '-' : Math.round(r.scores[c.key]! * 100)}]</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-slate-500">
                Safety index = average over the power gap and the blackout of max(0, 1 − gap ÷ (2 × limit)): 100 with no outage, 50 exactly at the limit, 0 at twice the limit.
              </p>
            </div>
          </>
        )}
        <Explain title="Science vs engineering">
          <p>Science teams often want to land near permanently shadowed regions (PSRs), which may hold water ice, but PSRs are dark and often out of sight of Earth. Engineering teams want steady sunlight and Earth contact. Moving the sliders shows how the preferred site changes with priorities.</p>
        </Explain>
      </div>
    </div>
  )
}
