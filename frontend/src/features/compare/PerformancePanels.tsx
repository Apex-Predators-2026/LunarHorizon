// Availability and outage bar charts, and the mission performance / ranking panel.
// Eligibility, ranks and order come from the canonical viability engine via the backend (never recomputed here).
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { formatMarginMetric, marginStatusClassLabel } from '../../lib/headroom'
import type { MarginMetricValue, MarginStatus } from '../../types'
import { PassHeadroom, PassHeadroomBadge } from '../../ui/PassHeadroom'
import { canonicalRanking, cm, comparableEntries, constraintMarginById, fmtMetric, headroomOfEntry, humanizeSeconds, inexactText, isLimitedHeadroom, knownValue, okEntries, scoreText, type Entry, type MetricDef } from './analysis'
import { STATE, seriesColor } from './palette'
import { scenarioDisplayName } from './scenario'
import type { RankingGroup } from './types'
import { constraintForViolation } from './evidence'
import { ShowWhy } from './ShowWhy'
import { DataKindBadge, EligibilityBadge, Explain, Icon, ScenarioChip, ScenarioLegend } from './ui'

interface BarRow {
  id: string
  name: string
  value: number
  limit?: number
  entry: Entry
  margin?: MarginMetricValue
  marginClass?: MarginStatus
  narrowReason?: string | null
}

function ScenarioBars({ rows, unit, title, max, format, limitLabel, notPlotted = [] }: {
  rows: BarRow[]
  unit: string
  title: string
  max?: number
  format: (v: number) => string
  limitLabel?: string
  notPlotted?: { entry: Entry; text: string }[] // values that are only bounded or unavailable: listed, never drawn
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-slate-200">{title}</h3>
      <div style={{ height: 46 + rows.length * 34 }} role="img" aria-label={`${title}: ${rows.map((r) => `${r.name} · ${scenarioDisplayName(r.entry.scenario)}: ${format(r.value)}`).join(', ')}`}>
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
                  <div className="cmp-tip">
                    <div className="flex items-center gap-2"><ScenarioChip s={r.entry.scenario} size="sm" /> {scenarioDisplayName(r.entry.scenario)}</div>
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
          {rows.map((r) => {
            if (r.limit === undefined) return null
            const exceeds = r.marginClass === 'negative' || r.value > r.limit
            const isNarrow = !exceeds && (r.marginClass === 'narrow' || r.marginClass === 'at_threshold')
            const marginText = r.margin && r.margin.status !== 'unavailable'
              ? formatMarginMetric(r.margin, true)
              : `${exceeds ? '-' : '+'}${format(Math.abs(r.limit - r.value))}`
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-1.5" title={r.narrowReason ?? undefined}>
                <ScenarioChip s={r.entry.scenario} size="sm" />
                {exceeds ? (
                  <span className="inline-flex items-center gap-1 text-red-300">
                    <Icon name="close" size={14} />
                    exceeds {limitLabel} {format(r.limit)} by {format(r.value - r.limit)}
                  </span>
                ) : isNarrow ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5 text-warn">
                    <Icon name="warning" size={14} />
                    <span>within {limitLabel} {format(r.limit)} (headroom {marginText})</span>
                    <span className="inline-flex items-center rounded border border-warn/45 bg-inset px-1.5 py-px text-[10px] font-medium text-warn">
                      {marginStatusClassLabel(r.marginClass!)}
                    </span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <Icon name="check" size={14} />
                    within {limitLabel} {format(r.limit)} (headroom {marginText})
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {notPlotted.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400" aria-label="Values not plotted">
          {notPlotted.map(({ entry, text }) => (
            <li key={entry.scenario.id} className="flex items-center gap-1.5">
              <ScenarioChip s={entry.scenario} size="sm" /> {scenarioDisplayName(entry.scenario)}. {text}. Not plotted: the engine could not determine an exact value.
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const h = (v: number) => fmtMetric(v, 'h')
const pctf = (v: number) => `${v.toFixed(1)}%`

/**
 * Availability and outage bars from the viability engine's own metrics. Only exact (known) values are drawn;
 * bounded or unavailable values are listed under the chart instead of being drawn at a guessed length.
 */
export function AvailabilityCharts({ entries }: { entries: Entry[] }) {
  const ok = comparableEntries(entries).filter((e) => e.result?.assessment)
  const left = okEntries(entries).filter((e) => !ok.includes(e))
  if (ok.length === 0) return <p className="text-xs text-slate-500">No results with data yet.</p>
  const chart = (key: string, unit: MetricDef['unit'], limit?: (e: Entry) => number, constraintId?: string) => {
    const rows: BarRow[] = []
    const notPlotted: { entry: Entry; text: string }[] = []
    for (const e of ok) {
      const m = cm(e.result, key)
      const v = knownValue(m)
      if (v !== null) {
        const resolved = constraintId ? constraintMarginById(e.result, constraintId) : null
        rows.push({
          id: e.scenario.id,
          name: e.scenario.label,
          value: v,
          limit: limit?.(e),
          entry: e,
          margin: resolved?.margin,
          marginClass: resolved?.marginClass,
          narrowReason: resolved?.narrowReason ?? null,
        })
      } else {
        notPlotted.push({ entry: e, text: m ? (inexactText(m, unit) ?? 'unavailable') : 'unavailable' })
      }
    }
    return { rows, notPlotted }
  }
  const sun = chart('sunlight_percent', '%')
  const earth = chart('earth_visible_percent', '%')
  const dark = chart('longest_power_darkness_h', 'h', (e) => e.scenario.requirements.battery_hours, 'max_continuous_darkness')
  const black = chart('longest_blackout_h', 'h', (e) => e.scenario.requirements.max_comms_gap_hours, 'max_communication_blackout')
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {ok.length > 0 && <ScenarioLegend scenarios={ok.map((e) => e.scenario)} className="lg:col-span-2" />}
      {left.length > 0 && (
        <p className="text-[11px] text-amber-300 lg:col-span-2">
          <Icon name="warning" size={14} className="mr-1 align-[-2px]" />{left.map((e) => e.scenario.label).join(', ')} {left.length > 1 ? 'use' : 'uses'} demonstration data and {left.length > 1 ? 'are' : 'is'} left out of these real-data charts.
        </p>
      )}
      <ScenarioBars title="Mission in direct sunlight (any solar disk visible)" unit="%" max={100} format={pctf} {...sun} />
      <ScenarioBars title="Mission with Earth in line of sight" unit="%" max={100} format={pctf} {...earth} />
      <ScenarioBars title="Longest power gap (Sun below panel threshold) vs battery limit" unit=" h" format={h} limitLabel="battery limit" {...dark} />
      <ScenarioBars title="Longest communication blackout vs allowed blackout" unit=" h" format={h} limitLabel="allowed" {...black} />
    </div>
  )
}

function ScenarioRow({ e, rankLabel }: { e: Entry; rankLabel: string | null }) {
  const v = e.result!.viability
  const r = e.ranking!
  const hr = headroomOfEntry(e)
  const failed = v?.violations.filter((x) => !x.is_unknown) ?? []
  const undecided = v?.violations.filter((x) => x.is_unknown) ?? []
  const constraintFor = (field: string) => constraintForViolation(e.result!, field)
  const width = r.score_status === 'known' && r.score !== null ? r.score : null // bar only for an exact score
  return (
    <li className="rounded-lg border border-line bg-inset p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-sm font-medium tabular-nums text-slate-400">{rankLabel ?? 'Not ranked'}</span>
        <ScenarioChip s={e.scenario} />
        <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{e.scenario.name}</span>
        <EligibilityBadge eligibility={r.eligibility} />
        <PassHeadroomBadge headroom={hr} eligibility={r.eligibility} surface="compare" />
        <DataKindBadge kind={e.result!.data_kind} />
        <span className="ml-1 text-right">
          <span className="block text-sm font-medium tabular-nums text-slate-50">{scoreText(r)}</span>
          <span className="block text-[11px] text-slate-500">desirability score · risk {r.overall_risk}</span>
        </span>
      </div>
      {width !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-800" aria-hidden="true">
          <div className="h-full rounded" style={{ width: `${Math.max(0, Math.min(100, width))}%`, background: seriesColor(e.scenario.colorSlot) }} />
        </div>
      )}
      {failed.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-red-200" aria-label="Failed requirements">
          {failed.map((x) => (
            <li key={x.constraint}>
              <Icon name="close" size={14} className="mr-1 align-[-2px]" />{x.message}{' '}
              <span className="text-red-300/70">(short by {(x.relative_shortfall * 100).toFixed(0)}%)</span>
              <ShowWhy entry={e} constraintId={constraintFor(x.constraint)?.id} section="cmp-performance" />
            </li>
          ))}
        </ul>
      )}
      {undecided.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-slate-300" aria-label="Requirements that cannot be decided">
          {undecided.map((x) => (
            <li key={x.constraint}><Icon name="unknown" size={14} className="mr-1 align-[-2px]" />{x.message}<ShowWhy entry={e} constraintId={constraintFor(x.constraint)?.id} section="cmp-performance" /></li>
          ))}
        </ul>
      )}
      {r.eligibility === 'pass' && (
        hr ? (
          <div className="mt-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {isLimitedHeadroom(hr) ? (
                <span className="inline-flex items-center gap-1 text-warn">
                  <Icon name="warning" size={14} />
                  {hr.qualified_verdict}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-emerald-300">
                  <Icon name="check" size={14} />
                  {hr.qualified_verdict}
                </span>
              )}
              {isLimitedHeadroom(hr) && <PassHeadroomBadge headroom={hr} eligibility={r.eligibility} surface="compare" />}
            </div>
            <PassHeadroom headroom={hr} surface="compare" compact />
          </div>
        ) : (
          <p className="mt-2 text-xs text-emerald-300"><Icon name="check" size={14} className="mr-1 align-[-2px]" />Every applicable requirement is met</p>
        )
      )}
      <p className="mt-2 text-[11px] leading-snug text-slate-500">{r.explanation}</p>
    </li>
  )
}

/**
 * Canonical ranking from the viability engine, one list per comparable group. Only PASS scenarios carry a rank;
 * UNKNOWN and FAIL scenarios are listed separately for inspection and are never ranked or recommended.
 */
export function MissionPerformance({ entries, groups, ranking = 'ready' }: {
  entries: Entry[]
  groups: RankingGroup[]
  ranking?: 'ready' | 'updating'
}) {
  const { groups: views, unassessed } = canonicalRanking(entries, groups)
  const sources = [...new Set(entries.map((e) => e.result?.viability?.source).filter(Boolean))].join(', ')
  const method = groups[0]?.method_version
  if (ranking === 'updating') return <p className="text-xs text-slate-400">Updating the canonical ranking for the selected plans…</p>
  if (!views.length && !unassessed.some((e) => e.result)) return <p className="text-xs text-slate-500">No viability results yet.</p>
  const multi = views.length > 1
  return (
    <div className="space-y-5">
      <p className="text-[11px] text-slate-400">
        Canonical ranking from the viability engine
        {sources && <> (<code className="text-slate-300">{sources}</code>{method && <>, <code className="text-slate-300">{method}</code></>})</>}.
        Only plans that pass every requirement are ranked, in the engine’s own order. Plans that fail or cannot be
        decided are listed for inspection and never ranked.
        {multi && ' Plans with a different data basis, requirements or mission duration form separate groups; ranks never cross groups.'}
      </p>
      {views.map((v) => (
        <section key={v.group.id} aria-label={`Ranking group ${v.group.id}`} className="space-y-2">
          {multi && (
            <h3 className="text-xs font-medium text-slate-200">
              {v.group.primary ? `Group ${v.group.id} (main comparison)` : `Group ${v.group.id}: ranked separately`}
              {v.group.data_basis === 'synthetic' && <span className="ml-2 text-amber-300">demonstration data</span>}
              {v.group.separate_reason && (
                <span className="ml-2 font-normal text-slate-400">Not comparable with {views[0].group.id}: {humanizeSeconds(v.group.separate_reason)}</span>
              )}
            </h3>
          )}
          {v.ranked.length > 0 ? (
            <ol className="space-y-2" aria-label="Ranked: passes every requirement">
              {v.ranked.map((e) => <ScenarioRow key={e.scenario.id} e={e} rankLabel={`#${e.ranking!.rank}`} />)}
            </ol>
          ) : (
            <p className="text-xs text-slate-400">No plan in this group passes every requirement, so this group has no recommended option.</p>
          )}
          {v.unknown.length > 0 && (
            <div>
              <h4 className="mb-1 text-[11px] font-medium text-slate-400">Cannot be decided (UNKNOWN), not ranked</h4>
              <ul className="space-y-2">{v.unknown.map((e) => <ScenarioRow key={e.scenario.id} e={e} rankLabel={null} />)}</ul>
            </div>
          )}
          {v.failed.length > 0 && (
            <div>
              <h4 className="mb-1 text-[11px] font-medium text-slate-400">Fails a requirement, not ranked</h4>
              <ul className="space-y-2">{v.failed.map((e) => <ScenarioRow key={e.scenario.id} e={e} rankLabel={null} />)}</ul>
            </div>
          )}
        </section>
      ))}
      {unassessed.length > 0 && (
        <section aria-label="Not assessed" className="space-y-1">
          <h3 className="text-xs font-medium text-slate-200">Not assessed</h3>
          <ul className="space-y-1 text-xs text-slate-400">
            {unassessed.map((e) => (
              <li key={e.scenario.id} className="flex items-start gap-2">
                <ScenarioChip s={e.scenario} size="sm" />
                <span>
                  {e.state?.state === 'error' ? e.state.message
                    : e.state?.state === 'done' ? (e.state.result.message ?? 'No canonical assessment.') : 'Waiting for results…'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Explain title="Why are long darkness periods dangerous?">
        <p>Without sunlight the lander runs on its battery for heaters and electronics. If darkness lasts longer than the battery can supply (the “max darkness” requirement), the lander can freeze or shut down. At the poles, nights are irregular: terrain can block the Sun for a few hours or for many days.</p>
        <p>The desirability score is a relative index of illumination and line-of-sight geometry under the engine’s weights. It is not a probability of mission success, and it never overrides a failed requirement.</p>
      </Explain>
    </div>
  )
}
