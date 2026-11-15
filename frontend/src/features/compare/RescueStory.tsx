// Mission Rescue story: original plan -> what changed -> the problem -> alternatives -> decision. Statuses are the
// comparison's own canonical re-assessment; Mission Rescue's wording is shown as Rescue's note.
import type { ReactNode } from 'react'

import { fmtUtc } from '../rescue/format'
import { eligibilityOf, rankText, groupCountOf, type Entry } from './analysis'
import { buildDecision } from './decision'
import { OUTCOME_TEXT, changedChanged, rescueSteps, type AltOutcome } from './rescueFlow'
import type { PairEvidence, RankingGroup } from './types'
import { EligibilityBadge, Icon, RankBadge, ScenarioChip } from './ui'
import { useCompareStore } from './useCompareStore'

const OUTCOME_STYLE: Record<AltOutcome, string> = {
  confirmed: 'text-emerald-300',
  passes_separately: 'text-slate-200',
  undecided: 'text-slate-200',
  still_fails: 'text-red-300',
  not_assessed: 'text-slate-400',
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="relative min-w-0 border-l-2 border-line pl-4">
      <span className="absolute -left-[11px] top-0 grid h-5 w-5 place-items-center rounded-full bg-surface text-[11px] font-medium text-slate-300 ring-2 ring-line">{n}</span>
      <h4 className="text-xs font-medium text-slate-200">{title}</h4>
      <div className="mt-1 space-y-1 text-[13px] text-slate-300">{children}</div>
    </li>
  )
}

const plan = (e: Entry) => `${e.scenario.site.name}, landing ${fmtUtc(e.scenario.landing_utc)}, ${e.scenario.duration_days} d`

export function RescueStory({ entries, groups, pairs }: { entries: Entry[]; groups: RankingGroup[]; pairs: PairEvidence[] }) {
  const ctx = useCompareStore((s) => s.rescueContext)
  const clear = useCompareStore((s) => s.setRescueContext)
  if (!ctx || changedChanged(ctx, entries)) return null
  const steps = rescueSteps(ctx, entries)
  const groupCount = groupCountOf(entries)
  const decision = buildDecision(entries, groups, pairs).groups.find((g) => g.group.primary)
  let n = 0
  return (
    <section aria-label="Mission Rescue: from problem to decision" className="mb-4 rounded-xl border border-line bg-surface p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-slate-100">Mission Rescue: from problem to decision</h3>
        <span className="text-[11px] text-slate-500">imported {fmtUtc(ctx.importedAt)}</span>
        <button type="button" className="ml-auto text-[11px] text-cyan-400 hover:underline" onClick={() => clear(null)}>Hide</button>
      </header>
      <ol className="ml-2.5 space-y-4">
        {steps.original && (
          <Step n={++n} title="Original plan">
            <p className="flex flex-wrap items-center gap-2"><ScenarioChip s={steps.original.scenario} size="sm" />{plan(steps.original)}
              {eligibilityOf(steps.original) && <EligibilityBadge eligibility={eligibilityOf(steps.original)!} />}</p>
          </Step>
        )}
        <Step n={++n} title="What changed">
          <ul className="list-disc pl-4">{ctx.change.map((c) => <li key={c}>{c}</li>)}</ul>
        </Step>
        {steps.changed && (
          <Step n={++n} title="The problem">
            <p className="flex flex-wrap items-center gap-2"><ScenarioChip s={steps.changed.scenario} size="sm" />{plan(steps.changed)}
              {eligibilityOf(steps.changed) && <EligibilityBadge eligibility={eligibilityOf(steps.changed)!} />}</p>
            {steps.changedProblems && steps.changedProblems.failed.length > 0 && (
              <p className="text-red-300"><Icon name="close" size={14} className="mr-1 align-[-2px]" />Fails {steps.changedProblems.failed.join(', ').toLowerCase()}.</p>
            )}
            {steps.changedProblems && steps.changedProblems.undecided.length > 0 && (
              <p><Icon name="unknown" size={14} className="mr-1 align-[-2px]" />Cannot decide {steps.changedProblems.undecided.join(', ').toLowerCase()} from the data.</p>
            )}
            {eligibilityOf(steps.changed) === 'pass' && <p className="text-emerald-300">The changed plan still meets every requirement.</p>}
          </Step>
        )}
        <Step n={++n} title="Alternatives from Mission Rescue, re-assessed here">
          {steps.alternatives.length === 0 ? <p className="text-slate-400">Mission Rescue found no alternative to compare.</p> : (
            <ul className="space-y-2">
              {steps.alternatives.map((a) => {
                const rank = rankText(a.entry.ranking, groupCount)
                return (
                  <li key={a.entry.scenario.id} className="rounded-lg border border-line bg-inset p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <ScenarioChip s={a.entry.scenario} size="sm" />
                      <span className="text-slate-200">{plan(a.entry)}</span>
                      {eligibilityOf(a.entry) && <EligibilityBadge eligibility={eligibilityOf(a.entry)!} />}
                      {rank && <RankBadge text={rank} />}
                    </div>
                    <p className={`mt-1 font-medium ${OUTCOME_STYLE[a.outcome]}`}>{OUTCOME_TEXT[a.outcome]}</p>
                    {a.fixes.length > 0 && <p className="text-emerald-300">Fixes: {a.fixes.join(', ').toLowerCase()}.</p>}
                    {a.remaining.length > 0 && <p className="text-slate-400">Still open: {a.remaining.join(', ').toLowerCase()}.</p>}
                    {a.disagreesWithRescue && (
                      <p className="text-[11px] text-amber-300">Mission Rescue reported {a.info.rescueVerdict?.toUpperCase()} for this plan; the re-assessment here says {eligibilityOf(a.entry)?.toUpperCase()}. The status shown here is the one used for the decision.</p>
                    )}
                    {a.info.headline && <p className="mt-1 text-[11px] text-slate-500">Rescue&apos;s note (#{a.info.rank}): {a.info.headline}</p>}
                  </li>
                )
              })}
            </ul>
          )}
        </Step>
        <Step n={++n} title="Decision">
          {decision ? <p className="text-slate-100">{decision.headline}</p> : <p className="text-slate-400">The decision appears once the plans have been assessed.</p>}
          <p className="text-[11px] text-slate-500">Full reasoning, trade-offs and uncertainty: see the comparison summary below.</p>
        </Step>
      </ol>
    </section>
  )
}
