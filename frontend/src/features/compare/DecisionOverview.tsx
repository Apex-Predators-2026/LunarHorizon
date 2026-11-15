// The comparison's first screen: which plans meet the requirements, whether there is a supported recommendation and
// why, what changed against the baseline, and what to do next. Built on buildDecision (canonical verdicts, ranks and
// pairwise evidence); a recommendation is only shown when that logic supports one, and only within a comparable group.
import type { ReactNode } from 'react'

import { openInPlanner as runInPlanner } from '../atlas/transfer'
import { eligibilityOf, type Entry } from './analysis'
import { lcFirst, type GroupDecision } from './decision'
import { DECISION_LABEL, keyConstraint, overallState, preferenceStrength, rolesOf, type RoleInfo } from './decisionView'
import { ExportButtons } from './ExportButtons'
import { toTeamScenario } from './scenario'
import type { PairEvidence, RankingGroup } from './types'
import { btn, EligibilityBadge, Icon, ScenarioChip } from './ui'
import { useCompareStore } from './useCompareStore'

const STYLE = {
  recommended: 'border-emerald-800 bg-emerald-950 text-emerald-300',
  unresolved: 'border-slate-500 bg-slate-800 text-slate-200',
  single_pass: 'border-emerald-800 bg-emerald-950 text-emerald-300',
  lone: 'border-slate-600 bg-slate-800 text-slate-200',
  insufficient: 'border-slate-500 bg-slate-800 text-slate-200',
  none_pass: 'border-red-800 bg-red-950 text-red-300',
} as const
const ICON = { recommended: 'check', unresolved: 'info', single_pass: 'check', lone: 'info', insufficient: 'unknown', none_pass: 'close' } as const

/** "Scenario C" -> "Scenario C (Recovery)" where the selection carries story roles. */
const withRoles = (text: string, entries: Entry[], roles: Record<string, RoleInfo>) =>
  entries.reduce((t, e) => (roles[e.scenario.id] ? t.split(`Scenario ${e.scenario.label} `).join(`Scenario ${e.scenario.label} (${lcFirst(roles[e.scenario.id].label)}) `) : t), text)

function GroupBrief({ d, pairs, entries, roles, multi }: { d: GroupDecision; pairs: PairEvidence[]; entries: Entry[]; roles: Record<string, RoleInfo>; multi: boolean }) {
  const strength = preferenceStrength(d, pairs)
  const kind = d.kind === 'recommended' && strength !== 'established' ? 'unresolved' : d.kind
  const members = d.requirements.map((r) => r.entry)
  const passing = members.filter((e) => eligibilityOf(e) === 'pass')
  return (
    <article aria-label={`Decision${multi ? ` for group ${d.group.id}` : ''}`} className="min-w-0 rounded-xl border border-line bg-surface p-4" data-testid="decision-brief" data-kind={kind}>
      <header className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${STYLE[kind]}`}>
          <Icon name={ICON[kind]} size={14} /> {DECISION_LABEL[kind]}
        </span>
        {d.recommended && (kind === 'recommended' || kind === 'single_pass') && <ScenarioChip s={d.recommended.scenario} />}
        {multi && <span className="text-[11px] text-ink-3">Group {d.group.id}{d.group.primary ? ' · main comparison' : ''}{d.group.separate_reason ? ` · ${d.group.separate_reason}` : ''}</span>}
      </header>
      <p className="mt-2 text-[15px] leading-relaxed text-ink">{withRoles(d.headline, entries, roles)}</p>
      {kind === 'unresolved' && (
        <p className="mt-1 text-[13px] text-ink-2">
          {strength === 'tie_break'
            ? 'Their order comes from a ranking tie-break, not a measured difference: treat them as equally preferred under these requirements.'
            : 'The score ranges overlap or are not exact, so the evidence does not establish that the first-ranked plan is more desirable. Any of the passing plans meets the requirements.'}
        </p>
      )}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Which plans meet the requirements</h4>
          <ul className="mt-1 space-y-1 text-[13px] text-ink-2">
            {d.requirements.map(({ entry, text }) => {
              const el = eligibilityOf(entry)
              const key = keyConstraint(entry)
              return (
                <li key={entry.scenario.id} className="flex items-start gap-2">
                  <ScenarioChip s={entry.scenario} size="sm" />
                  <span className="min-w-0">
                    {el && <span className="mr-1 align-[1px]"><EligibilityBadge eligibility={el} /></span>}
                    {withRoles(text, entries, roles)}
                    {key && key.kind !== 'tightest' && <span className="block text-[12px] text-ink-3">{key.text}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
        <div>
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Why</h4>
          <ul className="mt-1 space-y-1 text-[13px] text-ink-2">
            {d.evidence.slice(0, 2).map((x) => <li key={x}>{withRoles(x, entries, roles)}</li>)}
            {!d.evidence.length && passing.length === 0 && <li>Only plans that pass every requirement can be recommended; none does here.</li>}
            {!d.evidence.length && d.kind === 'lone' && <li>Nothing else shares its requirements, duration and data basis, so there is no comparison to make.</li>}
            {d.uncertainty.length > 0 && (
              <li className="flex gap-1.5 text-ink-3"><Icon name="unknown" size={14} className="mt-0.5" />{d.uncertainty[0]}{d.uncertainty.length > 1 ? ` (+${d.uncertainty.length - 1} more under Decision reasoning)` : ''}</li>
            )}
          </ul>
        </div>
      </div>
    </article>
  )
}

export function DecisionOverview({ entries, groups, pairs, rankingCurrent, notes, reportAction }: {
  entries: Entry[]
  groups: RankingGroup[]
  pairs: PairEvidence[]
  rankingCurrent: boolean
  notes: string[]
  reportAction?: ReactNode
}) {
  const ctx = useCompareStore((s) => s.rescueContext)
  const roles = rolesOf(ctx, entries)
  const state = overallState(entries, groups, pairs, rankingCurrent)
  const report = state.kind === 'decided' ? state.report : null
  const primary = report?.groups.find((g) => g.group.primary) ?? report?.groups[0] ?? null
  const recommended = primary && (primary.kind === 'recommended' || primary.kind === 'single_pass' || primary.kind === 'lone') ? primary.recommended : null
  const target = recommended ?? entries.find((e) => e.result) ?? entries[0]
  const openInPlanner = (e: Entry) => runInPlanner(e.scenario.name, toTeamScenario(e.scenario))
  // Mission Rescue context: if the top-ranked plan is the pre-change original, say so plainly.
  const origFirst = recommended && roles[recommended.scenario.id]?.role === 'original'
  const bestAvailable = origFirst && primary
    ? entries.filter((e) => e.ranking?.group === primary.group.id && e.ranking.rank !== null && roles[e.scenario.id]?.role !== 'original')
      .sort((a, b) => (a.ranking!.rank ?? 0) - (b.ranking!.rank ?? 0))[0]
    : null

  return (
    <div className="space-y-4">
      {state.kind === 'loading' && (
        <p className="flex items-center gap-2 rounded-xl border border-line bg-surface p-4 text-sm text-ink-2" role="status" data-testid="decision-loading">
          <span className="h-2 w-2 rounded-full bg-cyan-600 motion-safe:animate-pulse" aria-hidden="true" />
          Assessing {state.count} plan{state.count === 1 ? '' : 's'} with the canonical engine. No recommendation is shown until every plan has a current result.
        </p>
      )}
      {state.kind === 'error' && (
        <p className="flex items-start gap-2 rounded-xl bg-red-950 p-4 text-sm text-red-200" role="alert"><Icon name="warning" className="mt-0.5" />No plan could be assessed: {state.message}</p>
      )}
      {report && report.groups.length === 0 && (
        <p className="rounded-xl border border-line bg-surface p-4 text-sm text-ink-2" data-testid="decision-brief" data-kind="unassessed">
          None of the selected plans has a canonical assessment (no data for these sites and dates), so no plan can be judged and nothing is recommended.
        </p>
      )}
      {report?.groups.map((d) => <GroupBrief key={d.group.id} d={d} pairs={pairs} entries={entries} roles={roles} multi={report.groups.length > 1} />)}
      {report && (report.notes.length > 1 || bestAvailable || origFirst) && (
        <ul className="space-y-1 text-[12px] leading-snug text-ink-3">
          {origFirst && (
            <li className="flex gap-1.5 text-amber-300"><Icon name="info" size={14} className="mt-0.5" />
              The top-ranked plan is the original, pre-change plan. If the change is real it can no longer be flown{bestAvailable ? `; the best-ranked alternative is Scenario ${bestAvailable.scenario.label} (${bestAvailable.scenario.site.name})` : ''}.</li>
          )}
          {report.notes.slice(0, -1).map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Next actions">
        {target?.result && (
          <button type="button" className={btn} onClick={() => openInPlanner(target)} title="Open this plan as the running plan in the Mission Planner (3D view, assessment, Rescue)">
            Open {target.scenario.label} in Planner
          </button>
        )}
        {reportAction}
        <ExportButtons entries={entries} groups={groups} pairs={pairs} notes={notes} ready={rankingCurrent && entries.every((e) => e.state?.state !== 'loading')} />
      </div>
    </div>
  )
}
