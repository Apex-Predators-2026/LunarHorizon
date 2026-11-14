// Section 7: science vs engineering trade-off. User-defined weights over four criteria; the measured values
// behind each criterion are always shown. This is a preference ranking, not a mission viability assessment.
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip } from 'recharts'

import { CRITERIA, WEIGHT_PRESETS, computeTradeoff, type CriterionKey, type Entry } from './analysis'
import { STATE, seriesColor, seriesDash } from './palette'
import { Explain, ScenarioChip, btn, input } from './ui'
import { useCompareStore } from './useCompareStore'

export function TradeoffPanel({ entries }: { entries: Entry[] }) {
  const weights = useCompareStore((s) => s.weights)
  const setWeights = useCompareStore((s) => s.setWeights)
  const traverseKm = useCompareStore((s) => s.traverseKm)
  const setTraverseKm = useCompareStore((s) => s.setTraverseKm)
  const rows = computeTradeoff(entries, weights, traverseKm)
  const total = weights.solar + weights.comms + weights.science + weights.safety
  const radar = CRITERIA.map((c) => ({ criterion: c.label, ...Object.fromEntries(rows.map((r) => [r.entry.scenario.id, Math.round(r.scores[c.key] * 100)])) }))

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <div className="space-y-3">
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-2.5 text-[11px] leading-snug text-amber-100">
          <b>User preferences, not a NASA assessment.</b> Weights are yours; the ranking below only shows how your priorities
          order the scenarios. Measured values are listed next to each score. The science criterion uses an approximate,
          demonstration PSR catalog.
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
            <input type="range" min={0} max={5} step={0.5} value={weights[c.key]} className="w-full accent-cyan-500"
              onChange={(e) => setWeights({ [c.key]: Number(e.target.value) } as Partial<Record<CriterionKey, number>>)} />
            <span className="block text-[10px] text-slate-500">{c.basis}</span>
          </label>
        ))}
        <label className="block text-xs text-slate-300">
          Max science traverse (km)
          <input type="number" min={1} max={200} className={input} value={traverseKm}
            onChange={(e) => Number(e.target.value) > 0 && setTraverseKm(Number(e.target.value))} />
          <span className="block text-[10px] text-slate-500">Science index = 1 − distance to nearest PSR edge ÷ this distance (as in Mission Rescue’s compromise).</span>
        </label>
      </div>

      <div className="min-w-0 space-y-4">
        {rows.length < 2 ? (
          <p className="text-xs text-slate-500">Needs at least two scenarios with comparable data.</p>
        ) : (
          <>
            <div className="grid gap-4 xl:grid-cols-2">
              <div style={{ height: 260 }} role="img" aria-label="Radar chart of criterion scores per scenario">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radar} outerRadius="72%">
                    <PolarGrid stroke={STATE.grid} />
                    <PolarAngleAxis dataKey="criterion" tick={{ fill: STATE.ink, fontSize: 10 }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={{ fill: STATE.axis, fontSize: 9 }} stroke={STATE.grid} angle={90} />
                    <Tooltip isAnimationActive={false} content={({ active, payload, label }) => active && payload?.length ? (
                      <div className="rounded-md border border-[#2a3c63] bg-[#08111f]/95 px-2.5 py-2 text-xs">
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
              <div>
                <h3 className="mb-2 text-xs font-semibold text-slate-200">Preference ranking (weighted contributions)</h3>
                <ol className="space-y-2">
                  {rows.map((r) => (
                    <li key={r.entry.scenario.id}>
                      <div className="mb-0.5 flex items-center gap-2 text-xs">
                        <span className="w-5 font-bold text-slate-500">#{r.rank}</span>
                        <ScenarioChip s={r.entry.scenario} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-slate-200">{r.entry.scenario.site.name}</span>
                        <span className="tabular-nums font-semibold text-slate-100">{(r.weighted * 100).toFixed(0)}</span>
                      </div>
                      <div className="flex h-3 overflow-hidden rounded bg-slate-800" aria-hidden="true">
                        {CRITERIA.map((c, i) => (
                          <div key={c.key} title={`${c.label}: +${(r.contributions[c.key] * 100).toFixed(1)}`}
                            style={{ width: `${r.contributions[c.key] * 100}%`, background: ['#e8b84a', '#5aa9f0', '#b58cf0', '#4fbf8f'][i] }}
                            className="border-r-2 border-[#0b1426] last:border-r-0" />
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400">
                  {CRITERIA.map((c, i) => (
                    <span key={c.key} className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm" style={{ background: ['#e8b84a', '#5aa9f0', '#b58cf0', '#4fbf8f'][i] }} />{c.label}</span>
                  ))}
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <caption className="mb-1 text-left text-[11px] text-slate-400">Underlying values (score 0–100 in brackets)</caption>
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="py-1 font-normal">Scenario</th>
                    {CRITERIA.map((c) => <th key={c.key} className="py-1 pl-2 font-normal">{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.entry.scenario.id} className="border-t border-[#1c2a48]">
                      <td className="py-1"><ScenarioChip s={r.entry.scenario} size="sm" /></td>
                      {CRITERIA.map((c) => (
                        <td key={c.key} className="py-1 pl-2 text-slate-300">
                          {r.raw[c.key]} <span className="tabular-nums text-slate-500">[{Math.round(r.scores[c.key] * 100)}]</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-slate-500">
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
