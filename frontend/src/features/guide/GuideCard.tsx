// The "Try a mission" card: progress, the stage's plain-English explanation (read from the live results), one clear
// primary action, Back / Restart / Exit, and honest working / error / outdated / modified states. Rendered once at the
// App level so it stays with the user between the Mission Planner and Scenario Comparison. It can be minimised so the
// normal tools stay reachable.
import { useEffect, useRef, useState } from 'react'

import { useNav } from './nav'
import { useEvidence } from '../../viz/evidence'
import { useAssessmentStore } from '../assessment/useAssessmentStore'
import { useReportStore } from '../compare/report'
import { useCompareStore } from '../compare/useCompareStore'
import { useRescueStore } from '../rescue/useRescueStore'
import { MISSION } from './missionDefinition'
import { showStoryEvidenceAgain, snapshot, stageModel, STAGES, useGuide, type StageModel } from './mission'

const SLOW_MS = 15_000

const TONE: Record<string, string> = {
  pass: 'text-emerald-300',
  fail: 'text-red-300',
  unknown: 'text-slate-200',
  neutral: 'text-white/90',
}
const STATUS_WORD: Record<string, string> = { pass: 'Pass', fail: 'Fail', unknown: 'Unknown', not_applicable: 'n/a' }

function useLiveModel(): StageModel {
  // Subscribe to everything a stage reads, so the card updates the moment a result arrives.
  useGuide((g) => g.stage)
  useGuide((g) => g.error)
  useGuide((g) => g.recovery)
  useGuide((g) => g.evidenceShown)
  useGuide((g) => g.reportOpened)
  useGuide((g) => g.compareIds)
  useNav((n) => n.view)
  useAssessmentStore((s) => s.results)
  useRescueStore((s) => s.rescueStatus)
  useRescueStore((s) => s.rescue)
  useRescueStore((s) => s.original)
  useRescueStore((s) => s.change)
  useCompareStore((s) => s.results)
  useCompareStore((s) => s.scenarios)
  useCompareStore((s) => s.selectedIds)
  useCompareStore((s) => s.rankingSetKey)
  useEvidence((e) => e.highlight)
  useEvidence((e) => e.problem)
  return stageModel(snapshot())
}

function Progress({ stage }: { stage: number }) {
  return (
    <ol aria-label="Progress" className="mt-2 grid grid-cols-8 gap-1">
      {STAGES.map((s, i) => (
        <li key={s.id} aria-current={i === stage ? 'step' : undefined} className="min-w-0">
          <span className={`block h-1 rounded-full ${i < stage ? 'bg-coral/70' : i === stage ? 'bg-coral' : 'bg-white/20'}`} aria-hidden="true" />
          <span className={`mt-1 block truncate text-[10px] ${i === stage ? 'font-semibold text-white' : 'text-white/55'}`}>
            {s.short}<span className="sr-only">{i < stage ? ' (done)' : i === stage ? ' (current)' : ''}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function StatusLine({ m, slow, onRetry }: { m: StageModel; slow: boolean; onRetry: () => void }) {
  if (m.status === 'working')
    return (
      <p className="mt-2 flex items-center gap-2 text-[13px] text-white/80" role="status">
        <span className="h-2 w-2 shrink-0 rounded-full bg-coral motion-safe:animate-pulse" aria-hidden="true" />
        <span>{slow ? 'This is taking longer than usual. You can wait, retry or exit.' : 'Working on it…'}</span>
        {slow && <button type="button" onClick={onRetry} className="ml-auto rounded-full border border-white/30 px-2.5 py-0.5 text-xs">Retry</button>}
      </p>
    )
  const label = { error: 'Something went wrong', outdated: 'Outdated example', modified: 'Inputs changed', elsewhere: 'Different view' } as const
  if (m.status === 'ready') return null
  const cls = m.status === 'error' ? 'border-red-400/40 bg-red-950/60 text-red-200' : m.status === 'elsewhere' ? 'border-white/20 bg-white/5 text-white/80' : 'border-amber-300/40 bg-amber-950/60 text-amber-100'
  return <p role={m.status === 'error' ? 'alert' : 'status'} className={`mt-2 rounded-lg border px-2.5 py-1 text-xs font-medium ${cls}`}>{label[m.status]}</p>
}

export function GuideCard() {
  const active = useGuide((g) => g.active)
  const stage = useGuide((g) => g.stage)
  const run = useGuide((g) => g.run)
  const m = useLiveModel()
  const view = useNav((n) => n.view)
  // Above the planner's time strip; lower on the scrolling pages.
  // Planner: bottom-left above the time strip. Scrolling pages: bottom-right, lower, so the decision text stays readable.
  const place = view === 'planner' ? 'left-4 bottom-[clamp(170px,24vh,210px)] max-h-[calc(100vh-clamp(170px,24vh,210px)-6rem)]' : 'left-4 bottom-4 max-h-[min(30rem,calc(100vh-8rem))]' // left, so it never covers the Ask Rover launcher (bottom right)
  const [min, setMin] = useState(false)
  const [slowKey, setSlowKey] = useState<string | null>(null)
  const cardRef = useRef<HTMLElement>(null)
  const headRef = useRef<HTMLHeadingElement>(null)

  // "Taking long" only offers retry / exit; it never advances the story.
  const workKey = `${m.status}:${run}`
  useEffect(() => {
    if (!workKey.startsWith('working:')) return
    const t = setTimeout(() => setSlowKey(workKey), SLOW_MS)
    return () => clearTimeout(t)
  }, [workKey])
  const slow = slowKey === workKey

  // Keyboard users who pressed a card button follow the story to the new stage heading.
  useEffect(() => {
    if (cardRef.current?.contains(document.activeElement)) headRef.current?.focus()
  }, [stage])

  if (!active) return null
  const g = useGuide.getState()
  const s = STAGES[stage]
  const onPrimary = () => {
    const a = m.primary.action
    if (a === 'next') g.next()
    else if (a === 'retry') g.retry()
    else if (a === 'view') g.go(stage)
    else if (a === 'restart') g.restart()
    else g.exit()
  }
  const onSecondary = (a: StageModel['secondary'][number]['action']) => {
    if (a === 'evidence') showStoryEvidenceAgain()
    else if (a === 'report') useReportStore.getState().reopen()
    else document.getElementById('cmp-summary')?.scrollIntoView({ block: 'start' })
  }

  if (min)
    return (
      <button type="button" onClick={() => setMin(false)} data-testid="guide-minimised"
        className="ui-chrome fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border border-white/20 bg-black/85 px-4 py-2 text-sm text-white shadow-2xl">
        <span className="h-2 w-2 rounded-full bg-coral" aria-hidden="true" />
        Try a mission · step {stage + 1} of {STAGES.length}: {s.title}
        <span className="text-white/60">· Show</span>
      </button>
    )

  return (
    <aside
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="guide-title"
      data-testid="guide-card"
      data-stage={s.id}
      data-status={m.status}
      className={`ui-chrome fixed z-50 flex ${place} w-[min(25rem,calc(100vw-2rem))] flex-col rounded-2xl border border-white/15 bg-black/90 text-sm text-white shadow-2xl backdrop-blur`}
    >
      <div className="shrink-0 px-4 pt-3">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-white/60">
          <span>Try a mission · step {stage + 1} of {STAGES.length}</span>
          <button type="button" onClick={() => setMin(true)} className="ml-auto rounded px-1.5 py-0.5 normal-case tracking-normal text-white/70 hover:text-white" aria-label="Minimise the guided mission">Minimise</button>
          <button type="button" onClick={g.exit} className="rounded px-1.5 py-0.5 normal-case tracking-normal text-white/70 hover:text-white" aria-label="Exit the guided mission">✕</button>
        </div>
        <Progress stage={stage} />
        <h2 id="guide-title" ref={headRef} tabIndex={-1} className="mt-2 text-base font-semibold outline-none">{s.title}</h2>
        <StatusLine m={m} slow={slow} onRetry={g.retry} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-1" aria-live="polite">
        <p className="mt-2 leading-snug text-white/90">{m.lead}</p>
        {m.rows.length > 0 && (
          <table className="mt-2 w-full text-left text-xs">
            <caption className="sr-only">Requirements that changed status</caption>
            <thead className="text-white/60"><tr><th className="py-1 font-normal">Requirement</th><th className="font-normal">Before</th><th className="font-normal">After</th></tr></thead>
            <tbody>
              {m.rows.map((r) => (
                <tr key={r.name} className="border-t border-white/10 align-top">
                  <td className="py-1 pr-2">{r.name}<div className="text-white/50">limit {r.limit}</div></td>
                  <td className={`py-1 pr-2 ${TONE[r.from] ?? ''}`}>{r.before}<div className="text-[11px]">{STATUS_WORD[r.from]}</div></td>
                  <td className={`py-1 ${TONE[r.to] ?? ''}`}>{r.after}<div className="text-[11px] font-semibold">{STATUS_WORD[r.to]}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {m.facts.length > 0 && (
          <dl className="mt-2 space-y-1 text-xs">
            {m.facts.map((f, i) => (
              <div key={`${f.label}-${i}`} className="grid grid-cols-[7.5rem_1fr] gap-2">
                <dt className="text-white/55">{f.label}</dt>
                <dd className={TONE[f.tone ?? 'neutral']}>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {m.note && <p className="mt-2 text-[11px] leading-snug text-white/60">{m.note}</p>}
      </div>

      <div className="shrink-0 border-t border-white/10 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={g.back} disabled={stage === 0} className="rounded-full border border-white/30 px-3 py-1 disabled:opacity-40">Back</button>
          {m.secondary.map((x) => (
            <button key={x.label} type="button" onClick={() => onSecondary(x.action)} className="rounded-full border border-white/30 px-3 py-1">{x.label}</button>
          ))}
          <button type="button" onClick={onPrimary} disabled={m.primary.disabled} data-testid="guide-primary"
            className="ml-auto rounded-full bg-coral px-4 py-1 font-medium text-white disabled:cursor-wait disabled:opacity-60">
            {m.primary.label}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-white/60">
          <button type="button" onClick={g.restart} className="underline-offset-2 hover:underline">Restart</button>
          <button type="button" onClick={g.exit} className="underline-offset-2 hover:underline">Exit and explore</button>
          <span className="ml-auto truncate" title={`Mission definition ${MISSION.id} v${MISSION.version}`}>{MISSION.id} v{MISSION.version}</span>
        </div>
      </div>
    </aside>
  )
}

/** Header entry point inside the navigator (start, or restart when running). */
export function TryMissionButton() {
  const active = useGuide((g) => g.active)
  return (
    <button
      type="button"
      onClick={() => (active ? useGuide.getState().restart() : useGuide.getState().start())}
      data-tip="A guided, real-data mission: a plan, a launch delay, the evidence for what breaks, a Mission Rescue recovery, the comparison and a summary report"
      className="pointer-events-auto rounded-full bg-coral px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-black/30 hover:brightness-110"
    >
      {active ? 'Restart the mission' : 'Try a mission'}
    </button>
  )
}
