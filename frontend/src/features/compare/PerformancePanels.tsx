// Availability and outage bar charts, and the mission performance / ranking panel.
// Ranking order and pass/fail come from the team viability evaluator (not recomputed here).
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { fmtMetric, rankByViability, type Entry } from './analysis'
import { STATE, seriesColor } from './palette'
import { DataKindBadge, Explain, PassBadge, ScenarioChip } from './ui'
import { useCompareStore } from './useCompareStore'

interface BarRow {
  id: string
  name: string
  value: number
  limit?: number
  entry: Entry
}

function ScenarioBars({ rows, unit, title, max, format, limitLabel }: {
  rows: BarRow[]
  unit: string
  title: string
  max?: number
  format: (v: number) => string
  limitLabel?: string
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold text-slate-200">{title}</h3>
      <div style={{ height: 46 + rows.length * 34 }} role="img" aria-label={`${title}: ${rows.map((r) => `${r.name} ${format(r.value)}`).join(', ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 70, bottom: 4, left: 4 }} barCategoryGap={8}>
            <CartesianGrid stroke={STATE.grid} horizontal={false} />
            <XAxis type="number" domain={[0, max ?? 'auto']} tick={{ fill: STATE.axis, fontSize: 10 }} stroke={STATE.grid}
              tickFormatter={(v: number) => `${v}${unit}`} />
            <YAxis type="category" dataKey="name" width={36} tick={{ fill: STATE.ink, fontSize: 11, fontWeight: 600 }} stroke={STATE.grid} />
            <Tooltip isAnimationActive={false} cursor={{ fill: 'rgba(148,163,184,0.08)' }}
              content={({ active, payload }) => {
                const r = active && (payload?.[0]?.payload as BarRow | undefined)
                if (!r) return null
                return (
                  <div className="rounded-md border border-[#2a3c63] bg-[#08111f]/95 px-2.5 py-2 text-xs">
                    <div className="flex items-center gap-2"><ScenarioChip s={r.entry.scenario} size="sm" /> {r.entry.scenario.name}</div>
                    <div className="mt-1 tabular-nums text-slate-200">{format(r.value)}{r.limit !== undefined && ` (${limitLabel ?? 'limit'} ${format(r.limit)})`}</div>
                  </div>
                )
              }} />
            <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false} stroke={STATE.surface} strokeWidth={2}>
              {rows.map((r) => <Cell key={r.id} fill={seriesColor(r.entry.scenario.colorSlot)} />)}
              <LabelList dataKey="value" position="right" fill={STATE.ink} fontSize={11}
                formatter={(v: unknown) => format(Number(v))} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {rows.some((r) => r.limit !== undefined) && (
        <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
          {rows.map((r) => r.limit !== undefined && (
            <li key={r.id} className="flex items-center gap-1.5">
              <ScenarioChip s={r.entry.scenario} size="sm" />
              {r.value > r.limit ? <span className="text-red-300">✕ exceeds {limitLabel} {format(r.limit)} by {format(r.value - r.limit)}</span>
                : <span className="text-emerald-300">✓ within {limitLabel} {format(r.limit)} (margin {format(r.limit - r.value)})</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const h = (v: number) => fmtMetric(v, 'h')
const pctf = (v: number) => `${v.toFixed(1)}%`

export function AvailabilityCharts({ entries }: { entries: Entry[] }) {
  const ok = entries.filter((e) => e.result?.solar && e.result.earth)
  if (ok.length === 0) return <p className="text-xs text-slate-500">No results with data yet.</p>
  const row = (e: Entry, value: number, limit?: number): BarRow => ({ id: e.scenario.id, name: e.scenario.label, value, limit, entry: e })
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ScenarioBars title="☀ Mission illuminated (any solar disk visible)" unit="%" max={100} format={pctf}
        rows={ok.map((e) => row(e, e.result!.solar!.sunlit_fraction * 100))} />
      <ScenarioBars title="⊕ Mission with Earth in line of sight" unit="%" max={100} format={pctf}
        rows={ok.map((e) => row(e, e.result!.earth!.visible_fraction * 100))} />
      <ScenarioBars title="Longest power gap (Sun below panel threshold) vs battery limit" unit=" h" format={h} limitLabel="battery limit"
        rows={ok.filter((e) => e.result!.viability).map((e) => row(e, e.result!.viability!.metrics.longest_dark_gap_hours, e.scenario.requirements.battery_hours))} />
      <ScenarioBars title="Longest communication blackout vs allowed blackout" unit=" h" format={h} limitLabel="allowed"
        rows={ok.map((e) => row(e, e.result!.earth!.longest_blackout_hours, e.scenario.requirements.max_comms_gap_hours))} />
    </div>
  )
}

export function MissionPerformance({ entries }: { entries: Entry[] }) {
  const viabilitySource = useCompareStore((s) => s.viabilitySource)
  const { real, demo } = rankByViability(entries)
  const placeholder = viabilitySource.includes('placeholder')
  const list = (ranked: typeof real, title: string) => (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-slate-200">{title}</h3>
      <ol className="space-y-2">
        {ranked.map(({ entry: e, rank }) => {
          const v = e.result!.viability!
          return (
            <li key={e.scenario.id} className="rounded-lg border border-[#1c2a48] bg-[#08111f] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg font-bold tabular-nums text-slate-500">#{rank}</span>
                <ScenarioChip s={e.scenario} />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{e.scenario.name}</span>
                <PassBadge passes={v.passes} />
                <DataKindBadge kind={e.result!.data_kind} />
                <span className="ml-1 text-right">
                  <span className="block text-xl font-semibold tabular-nums text-slate-50">{v.score.toFixed(1)}</span>
                  <span className="block text-[10px] text-slate-500">viability score</span>
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-800" aria-hidden="true">
                <div className="h-full rounded" style={{ width: `${Math.max(0, Math.min(100, v.score))}%`, background: seriesColor(e.scenario.colorSlot) }} />
              </div>
              {v.violations.length > 0 ? (
                <ul className="mt-2 space-y-0.5 text-xs text-red-200">
                  {v.violations.map((x) => (
                    <li key={x.constraint}>
                      ✕ {x.message} <span className="text-red-300/70">(short by {(x.relative_shortfall * 100).toFixed(0)}%)</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-emerald-300">✓ No constraint violations.</p>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
  if (!real.length && !demo.length) return <p className="text-xs text-slate-500">No viability results yet.</p>
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-slate-400">
        Ranked by the team viability evaluator (<code className="text-slate-300">{viabilitySource || 'n/a'}</code>): passing scenarios first, then by score.
        {placeholder && ' This is the interim placeholder implementation until Brandon’s evaluator is connected; the comparison will use his automatically.'}
      </p>
      {real.length > 0 && list(real, 'Real-data scenarios')}
      {demo.length > 0 && list(demo, '⚠ Demonstration-data scenarios (ranked separately, not comparable with real data)')}
      <Explain title="Why are long darkness periods dangerous?">
        <p>Without sunlight the lander runs on its battery for heaters and electronics. If darkness lasts longer than the battery can supply (the “max darkness” requirement), the lander can freeze or shut down. At the poles, nights are irregular: terrain can block the Sun for a few hours or for many days.</p>
        <p>The viability score combines how comfortably each requirement is met. It is a team engineering heuristic, not a NASA mission assessment.</p>
      </Explain>
    </div>
  )
}
