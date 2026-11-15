// Section 8: the decision. Which plan is preferable under the selected requirements, why, on what evidence, with
// what trade-offs, and what remains uncertain. Built only from the engine's verdicts, ranking and pairwise evidence
// (decision.ts) and from measured metrics; the per-metric highlights stay available underneath.
import type { ReactNode } from 'react'

import { PassHeadroom, PassHeadroomBadge } from '../../ui/PassHeadroom'
import { buildSummary, eligibilityOf, headroomOfEntry, isLimitedHeadroom, type Entry } from './analysis'
import { buildDecision, tradeoffSentence, type DecisionKind, type GroupDecision } from './decision'
import type { PairEvidence, RankingGroup } from './types'
import { EligibilityBadge, Icon, ReqIcon, ScenarioChip } from './ui'
import { AskButton } from './assistant/AskButton'

const KIND: Record<DecisionKind, { label: string; cls: string; icon: 'check' | 'close' | 'unknown' | 'info' }> = {
  recommended: { label: 'Preferred option', cls: 'border-emerald-800 bg-emerald-950 text-emerald-300', icon: 'check' },
  single_pass: { label: 'Only option that meets the requirements', cls: 'border-emerald-800 bg-emerald-950 text-emerald-300', icon: 'check' },
  lone: { label: 'Passes, nothing to compare against', cls: 'border-slate-600 bg-slate-800 text-slate-200', icon: 'info' },
  insufficient: { label: 'No conclusion: insufficient evidence', cls: 'border-slate-500 bg-slate-800 text-slate-200', icon: 'unknown' },
  none_pass: { label: 'No option meets the requirements', cls: 'border-red-800 bg-red-950 text-red-300', icon: 'close' },
}

const LIMITED_KIND_LABEL: Partial<Record<DecisionKind, string>> = {
  recommended: 'Preferred option (limited headroom)',
  single_pass: 'Only passing option (limited headroom)',
  lone: 'Passes with limited headroom, nothing to compare against',
}

function Block({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="border-t border-line pt-3">
      <h4 className="text-xs font-medium text-slate-200">{title}</h4>
      <p className="mb-1.5 text-[11px] text-slate-500">{note}</p>
      {children}
    </div>
  )
}

/** The question the "Ask why" button asks about this decision (none for a lone scenario: nothing to compare). */
function decisionQuestion(d: GroupDecision): string | null {
  const r = d.recommended ? `Scenario ${d.recommended.scenario.label}` : null
  switch (d.kind) {
    case 'recommended': return `Why is ${r} preferred over the other scenarios?`
    case 'single_pass': return `Why is ${r} the only option that meets every requirement?`
    case 'none_pass': return 'Why does no scenario meet the requirements?'
    case 'insufficient': return 'Why can the comparison not reach a conclusion?'
    default: return null
  }
}

function GroupCard({ d, showGroup }: { d: GroupDecision; showGroup: boolean }) {
  const k = KIND[d.kind]
  const recHr = d.recommended ? headroomOfEntry(d.recommended) : null
  const recLimited = isLimitedHeadroom(recHr)
  const badgeCls = recLimited && LIMITED_KIND_LABEL[d.kind] ? 'border-warn/45 bg-inset text-warn' : k.cls
  const badgeIcon = recLimited && LIMITED_KIND_LABEL[d.kind] ? 'warning' : k.icon
  const badgeLabel = (recLimited ? LIMITED_KIND_LABEL[d.kind] : undefined) ?? k.label
  return (
    <article aria-label={`Decision${showGroup ? ` for group ${d.group.id}` : ''}`} className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <header data-tour="compare-tradeoffs" className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${badgeCls}`}>
          <Icon name={badgeIcon} size={14} /> {badgeLabel}
        </span>
        {d.recommended && <ScenarioChip s={d.recommended.scenario} />}
        {d.recommended && (
          <PassHeadroomBadge headroom={recHr} eligibility={eligibilityOf(d.recommended) ?? undefined} surface="compare" />
        )}
        {showGroup && <span className="text-[11px] text-slate-500">Group {d.group.id}{d.group.primary ? ' (main comparison)' : ''}</span>}
        {decisionQuestion(d) && <AskButton question={decisionQuestion(d)!} label="Ask why" className="ml-auto" />}
      </header>
      <p className="text-sm leading-relaxed text-slate-100">{d.headline}</p>
      {recHr && <PassHeadroom headroom={recHr} surface="compare" compact showScreeningNote />}

      <Block title="1 · Requirements" note="The viability engine's verdict on each scenario under the selected mission requirements.">
        <ul className="space-y-1 text-sm text-slate-300">
          {d.requirements.map(({ entry, text }) => {
            const el = eligibilityOf(entry)
            const entryHr = el === 'pass' ? headroomOfEntry(entry) : null
            return (
              <li key={entry.scenario.id} className="flex items-start gap-2">
                {el && <ReqIcon status={el} />}
                <span className="flex flex-wrap items-center gap-1.5">
                  <span>{text}</span>
                  {el === 'pass' && isLimitedHeadroom(entryHr) && (
                    <PassHeadroomBadge headroom={entryHr} eligibility={el} surface="compare" />
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </Block>

      {(d.evidence.length > 0 || d.engineText) && (
        <Block title="2 · Ranking evidence" note="From the engine's canonical ranking: why one scenario is placed above another and how decisive that is.">
          <ul className="space-y-1 text-sm text-slate-300">{d.evidence.map((x) => <li key={x}>{x}</li>)}</ul>
          {d.engineText && (
            <details className="mt-2 text-[11px] text-slate-400">
              <summary className="cursor-pointer select-none">Engine explanation (verbatim)</summary>
              <p className="mt-1 leading-relaxed">{d.engineText}</p>
            </details>
          )}
        </Block>
      )}

      {d.tradeoffs.length > 0 && (
        <Block title="3 · Measured trade-offs" note="Individual metrics from the engine, compared one by one (only meaningful differences). These are not the ranking.">
          <ul className="space-y-1 text-sm text-slate-300">{d.tradeoffs.map((t) => <li key={`${t.a.scenario.id}-${t.b.scenario.id}`}>{tradeoffSentence(t)}</li>)}</ul>
        </Block>
      )}

      {d.uncertainty.length > 0 && (
        <Block title="4 · Uncertainty" note="What the available evidence cannot establish.">
          <ul className="space-y-1 text-[13px] text-slate-400">{d.uncertainty.map((x) => <li key={x} className="flex gap-1.5"><Icon name="unknown" size={14} className="mt-0.5 shrink-0" />{x}</li>)}</ul>
        </Block>
      )}
    </article>
  )
}

export function SummaryPanel({ entries, groups = [], pairs = [] }: { entries: Entry[]; groups?: RankingGroup[]; pairs?: PairEvidence[] }) {
  const decision = buildDecision(entries, groups, pairs)
  const sum = buildSummary(entries)
  const byId = Object.fromEntries(entries.map((e) => [e.scenario.id, e.scenario]))
  return (
    <div className="space-y-4">
      {decision.groups.length === 0 ? (
        <p className="text-sm text-slate-400">The decision appears once the selected scenarios have been assessed.</p>
      ) : (
        decision.groups.map((d) => <GroupCard key={d.group.id} d={d} showGroup={decision.groups.length > 1} />)
      )}
      {decision.unassessed.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-400">
          {decision.unassessed.map((e) => (
            <li key={e.scenario.id} className="flex items-center gap-2">
              <ScenarioChip s={e.scenario} size="sm" />
              {e.ranking ? <EligibilityBadge eligibility={e.ranking.eligibility} /> : null}
              <span>not assessed, so not part of the decision</span>
            </li>
          ))}
        </ul>
      )}
      <ul className="list-disc space-y-1 pl-4 text-xs text-ink-4">
        {decision.notes.map((c) => <li key={c}>{c}</li>)}
      </ul>

      <details className="rounded-xl border border-line p-3">
        <summary className="cursor-pointer select-none text-sm font-medium text-ink">Per-metric highlights</summary>
        <div className="mt-3 space-y-3">
          {sum.bests.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              {sum.bests.map((b) => (
                <div key={b.label} className="rounded-lg border border-line bg-inset p-2.5">
                  <div className="text-[11px] text-slate-500">{b.label}</div>
                  <div className="mt-1 flex flex-wrap gap-1">{b.ids.map((id) => <ScenarioChip key={id} s={byId[id]} />)}</div>
                  <div className="mt-1 text-[11px] text-slate-300">{b.detail}</div>
                </div>
              ))}
            </div>
          )}
          {sum.overall.length > 0 && (
            <div className="rounded-lg bg-inset p-3 text-sm leading-relaxed text-ink-2">
              {sum.overall.map((p) => <p key={p} className="mb-1.5 last:mb-0">{p}</p>)}
            </div>
          )}
          {sum.highlights.length > 0 && (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {sum.highlights.map((hl) => (
                <div key={hl.entry.scenario.id} className="rounded-lg border border-line p-2.5 text-xs">
                  <div className="mb-1 flex items-center gap-2"><ScenarioChip s={hl.entry.scenario} size="sm" />
                    <span className="truncate text-slate-200">{hl.entry.scenario.name}</span></div>
                  {hl.strengths.map((s) => <p key={s} className="text-emerald-300">＋ {s}</p>)}
                  {hl.cautions.map((s) => <p key={s} className="text-warn">! {s}</p>)}
                  {hl.weaknesses.map((s) => <p key={s} className="text-red-300">－ {s}</p>)}
                  {hl.uncertain.map((s) => <p key={s} className="text-slate-300">? {s}</p>)}
                  {!hl.strengths.length && !hl.cautions.length && !hl.weaknesses.length && !hl.uncertain.length && <p className="text-slate-500">No stand-out differences.</p>}
                </div>
              ))}
            </div>
          )}
          <ul className="list-disc space-y-1 pl-4 text-xs text-ink-4">{sum.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      </details>
    </div>
  )
}
