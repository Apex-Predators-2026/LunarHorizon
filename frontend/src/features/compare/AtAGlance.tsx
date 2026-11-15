// "At a glance": the answer first. The decision headline and each scenario's verdict, then the four headline
// conditions drawn side by side so the differences are visible without reading the tables. Everything shown comes
// from the canonical engine (verdicts, ranks, metrics); bars are drawn only for exact values.
import { scenarioDisplayName } from './scenario'
import { eligibilityOf, groupCountOf, rankText, requirementSummary, type Entry } from './analysis'
import { HEADLINES, headlineNote, headlineRows, type Headline } from './glance'
import { buildDecision } from './decision'
import { seriesColor } from './palette'
import type { PairEvidence, RankingGroup } from './types'
import { EligibilityBadge, RankBadge, ReqIcon, ScenarioChip } from './ui'
import { AskButton } from './assistant/AskButton'

function Bars({ h, entries }: { h: Headline; entries: Entry[] }) {
  const rows = headlineRows(h, entries)
  const max = Math.max(...rows.map((r) => r.value ?? 0), h.unit === '%' ? 100 : 1)
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium text-ink">{h.label}</h4>
        <span className="text-[11px] text-ink-3">{h.better === 'higher' ? 'higher is better' : 'lower is better'}</span>
      </div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.entry.scenario.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs">
            <ScenarioChip s={r.entry.scenario} size="sm" />
            <span className="relative block h-2.5 overflow-hidden rounded-sm bg-inset" aria-hidden="true">
              {/* A measured zero draws no bar (its text says 0); a small positive value keeps a visible sliver. */}
              {r.value !== null && r.value > 0 && (
                <span className="absolute inset-y-0 left-0 rounded-sm"
                  style={{ width: `${Math.min(100, Math.max(1.5, (r.value / max) * 100))}%`, background: seriesColor(r.entry.scenario.colorSlot) }} />
              )}
            </span>
            <span className="flex min-w-[7.5rem] items-center justify-end gap-1 tabular-nums text-ink-2">
              {r.status && r.status !== 'not_applicable' && <ReqIcon status={r.status as 'pass' | 'fail' | 'unknown'} />}
              <span className={r.value === null ? 'text-ink-4' : ''}>{r.text}</span>
              {r.best && (
                <span className="text-[11px] font-medium text-emerald-300" data-testid="glance-best"
                  title={r.illustrative ? 'Best among demonstration results only: illustrative, not about the real Moon' : 'A meaningful, proven lead on this quantity among comparable real-data plans. Descriptive, not a recommendation.'}>
                  {r.illustrative ? 'best (illustrative)' : 'best'}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AtAGlance({ entries, groups, pairs, ready, onJump }: {
  entries: Entry[]
  groups: RankingGroup[]
  pairs: PairEvidence[]
  ready: boolean
  onJump: (id: string) => void
}) {
  const decision = ready ? buildDecision(entries, groups, pairs) : null
  const main = decision?.groups.find((g) => g.group.primary) ?? decision?.groups[0] ?? null
  const groupCount = groupCountOf(entries)
  const anyData = entries.some((e) => e.result)
  return (
    <div className="mb-6 space-y-4">
      <div data-tour="compare-verdict" className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-3xl">
            <div className="text-[11px] font-medium text-ink-3">Verdict under the selected requirements</div>
            <p className="mt-1 text-base leading-snug text-ink">
              {!anyData ? 'Results appear once the selected plans have been assessed.'
                : !main ? 'Updating the canonical ranking…' : main.headline}
            </p>
          </div>
          <span className="flex flex-wrap items-center gap-2">
            {anyData && main && <AskButton question="Explain this verdict: why did these plans get these results?" label="Ask why" />}
            <button type="button" className="cmp-btn" onClick={() => onJump('cmp-summary')}>Read the reasoning</button>
          </span>
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2" aria-label="Status of each plan">
          {entries.map((e) => {
            const el = eligibilityOf(e)
            const rank = rankText(e.ranking, groupCount)
            const req = requirementSummary(e)
            return (
              <li key={e.scenario.id} className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
                <ScenarioChip s={e.scenario} size="sm" />
                <span className="min-w-0 break-words">{scenarioDisplayName(e.scenario)}</span>
                {el ? <EligibilityBadge eligibility={el} /> : <span className="text-ink-4">{e.state?.state === 'loading' ? 'evaluating…' : 'not assessed'}</span>}
                {rank && <RankBadge text={rank} />}
                {req && <span className="tabular-nums text-ink-3">{req.passed}/{req.applicable} requirements met</span>}
              </li>
            )
          })}
        </ul>
      </div>
      <HeadlineConditions entries={entries} />
    </div>
  )
}

/** The four headline conditions side by side (the "compare-headlines" tour target). Nothing until data exists. */
export function HeadlineConditions({ entries }: { entries: Entry[] }) {
  if (!entries.some((e) => e.result)) return null
  const note = headlineNote(entries)
  return (
      <div data-tour="compare-headlines" className="grid gap-x-8 gap-y-4 rounded-xl border border-line bg-surface p-4 md:grid-cols-2">
        {HEADLINES.map((h) => <Bars key={h.key} h={h} entries={entries} />)}
        <p className="text-[11px] text-ink-3 md:col-span-2">
          Bars are drawn only for exact values; a range or a missing value is written out instead. The icon is the verdict of the
          requirement each figure is checked against. “best” is a proven, meaningful lead (≥ 1 percentage point, or ≥ 2 h / 10%)
          on one quantity among comparable real-data plans: it describes a measurement, it is not the recommendation.
          {note && <span className="mt-1 block text-ink-2" data-testid="glance-best-note">{note}</span>}
        </p>
      </div>
  )
}
