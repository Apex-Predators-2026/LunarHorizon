// Mission assessment: the canonical viability verdict for the running plan (or the alternative picked in Rescue),
// every configured requirement with its threshold, measurement and margin, the risk screen, score, data
// provenance and limitations, and a "Show why" action that points the 3D view at the evidence (viz/evidence.ts).
// Every status and number is the engine's (POST /api/viability/assess-scenario); nothing is recomputed here.
import { useEffect, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { Scenario } from '../../types'
import { showEvidence, useEvidence } from '../../viz/evidence'
import { ASSESSMENT_ID, returnFromEvidence } from './evidenceReturn'
import { EligibilityBadge } from '../compare/ui'
import { fmtUtc } from '../rescue/format'
import { useRescueStore } from '../rescue/useRescueStore'
import { evidenceForConstraint, fmtMetric, fmtValue, orderedConstraints, PLAIN, planDecision, previewChangedPlan, STATUS_LABEL, thresholdText, VERDICT_SENTENCE } from './logic'
import type { AssessResponse, ConstraintEvaluation, RiskLevel } from './types'
import { scenarioKey, useAssessmentStore } from './useAssessmentStore'

export { ASSESSMENT_ID } from './evidenceReturn'

const STATUS_CLASS: Record<ConstraintEvaluation['status'], string> = {
  pass: 'bg-emerald-950 text-emerald-300',
  fail: 'bg-red-950 text-red-300',
  unknown: 'bg-amber-950 text-amber-200',
  not_applicable: 'bg-slate-800 text-slate-400',
}
const STATUS_ICON: Record<ConstraintEvaluation['status'], string> = { pass: '✓', fail: '✕', unknown: '?', not_applicable: '–' }
const RISK_CLASS: Record<RiskLevel, string> = {
  low: 'border-emerald-800 text-emerald-300',
  moderate: 'border-amber-800 text-amber-300',
  high: 'border-red-800 text-red-300',
  unknown: 'border-slate-700 text-slate-400',
}

function ScoreLine({ r }: { r: AssessResponse }) {
  const rs = r.ranking_status
  let text: string
  if (rs.score_status === 'known' && rs.score !== null) text = rs.score.toFixed(1)
  else if (rs.score_status === 'bounded' && rs.score_bounds?.lower != null && rs.score_bounds.upper != null)
    text = `${rs.score_bounds.lower.toFixed(1)}–${rs.score_bounds.upper.toFixed(1)} (data partly missing)`
  else if (rs.score_status === 'eligibility_unknown') text = 'Not scored – eligibility undecided'
  else if (rs.score_status === 'no_scorable_components') text = 'Not scored – nothing to score under this configuration'
  else text = 'Not scored'
  return (
    <p className="text-xs text-slate-400" data-tip="Desirability among plans that pass, from how comfortably each requirement is met. Not a probability of mission success.">
      Score <span className="font-semibold tabular-nums text-slate-100">{text}</span>
      {rs.eligibility === 'fail' && rs.score !== null && <span> · descriptive only, not ranked (fails requirements)</span>}
      {rs.rank_eligible && <span> · rank-eligible</span>}
    </p>
  )
}

function ConstraintRow({ r, c, skey }: { r: AssessResponse; c: ConstraintEvaluation; skey: string }) {
  const showing = useAssessmentStore((s) => s.showing)
  const setShowing = useAssessmentStore((s) => s.setShowing)
  const clearShowing = useAssessmentStore((s) => s.clearShowing)
  const key = `${skey}|${c.constraint_id}`
  const active = showing === key
  const a = r.assessment
  const ev = evidenceForConstraint(a, c)
  const margin = a.margins.find((m) => m.related_constraint === c.constraint_id)
  const why = () => {
    if (!ev) return
    const res = showEvidence({ ...ev.request, origin: { kind: 'assessment', label: 'Mission assessment' } })
    if (res.ok) setShowing(key)
  }
  return (
    <li className={`rounded-xl border p-3 transition-colors ${active ? 'border-coral bg-coral/10' : 'border-slate-800 bg-panel-fill/60'}`} aria-label={`${c.name}: ${STATUS_LABEL[c.status]}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-xs font-semibold text-slate-100">{c.name}</p>
        <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${STATUS_CLASS[c.status]}`}>
          <span aria-hidden>{STATUS_ICON[c.status]} </span>{STATUS_LABEL[c.status]}
        </span>
      </div>
      <dl className="mt-1 grid grid-cols-3 gap-1 text-[11px]">
        <div><dt className="text-slate-500">Required</dt><dd className="tabular-nums text-slate-200">{thresholdText(c)}</dd></div>
        <div><dt className="text-slate-500">{c.measured.status === 'bounded' ? 'Measured (range)' : 'Measured'}</dt><dd className="tabular-nums text-slate-200">{fmtMetric(c.measured)}</dd></div>
        <div><dt className="text-slate-500">Margin</dt><dd className="tabular-nums text-slate-200">{margin ? (margin.value.status === 'known' && margin.value.value !== null ? `${margin.value.value >= 0 ? '+' : '−'}${fmtValue(Math.abs(margin.value.value), margin.value.unit)}` : fmtMetric(margin.value)) : '-'}</dd></div>
      </dl>
      <p className="mt-1 text-[11px] leading-snug text-slate-400">{PLAIN[c.constraint_id] ?? c.message}</p>
      {c.status === 'unknown' && (
        <p className="mt-1 text-[11px] text-amber-300">
          Undecided because {c.unknown_reason === 'no_data' ? 'there is no data for part of the mission' : 'part of the mission has incomplete data'}; the true value lies in the range shown. This is not a measured failure.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {ev ? (
          active ? (
            <button type="button" className="md-btn h-8 border border-coral px-3 text-xs text-coral" onClick={clearShowing} aria-label={`Back to the assessment from ${c.name}`}>Back to assessment</button>
          ) : (
            <button type="button" className="md-btn h-8 bg-coral px-3 text-xs text-[#1f2326] hover:brightness-110" onClick={why} aria-label={`Show why: ${c.name}`} data-tip={`Jump the 3D view and timeline to this moment and look toward the ${ev.request.body === 'earth' ? 'Earth' : 'Sun'}`}>
              Show why
            </button>
          )
        ) : (
          <span className="text-[11px] text-slate-500">No time window to show for this requirement.</span>
        )}
        {ev && <span className="text-[11px] text-slate-500">{ev.role === 'illustrative' ? 'Illustration: ' : ev.role === 'missing_data' ? 'Data missing here: ' : ''}{ev.caption}</span>}
      </div>
    </li>
  )
}

function AssessmentBody({ r, skey, requested }: { r: AssessResponse; skey: string; requested?: Scenario }) {
  const a = r.assessment
  const ds = r.input_dataset
  const summary = r.explanation_details?.find((d) => d.key === 'summary.eligibility')?.explanation.message
  const riskSummary = r.explanation_details?.find((d) => d.key === 'summary.risk')?.explanation.message
  const notable = a.risks.filter((x) => x.level !== 'low')
  const prov = ds.provenance
  const all = orderedConstraints(a)
  const attention = all.filter((c) => c.status === 'fail' || c.status === 'unknown')
  const met = all.filter((c) => c.status === 'pass')
  const decision = planDecision(a)
  const windowLine = `Evaluated ${fmtUtc(a.evaluated_start_utc)} → ${fmtUtc(a.evaluated_end_utc)} on the hourly grid${requested ? `; requested ${fmtUtc(requested.landing_utc)}, ${requested.duration_days} d` : ''}.`
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <EligibilityBadge eligibility={a.eligibility} />
        <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${RISK_CLASS[a.overall_risk]}`} data-tip="Screening risk from the engine's documented rules. It never changes the verdict; a passing plan can still carry high risk.">
          Risk: {a.overall_risk}
        </span>
        {prov.is_synthetic && <span className="rounded-md bg-amber-950 px-1.5 py-0.5 text-[11px] text-amber-200">Synthetic data</span>}
      </div>
      <p className="text-xs leading-snug text-slate-200">{VERDICT_SENTENCE[a.eligibility]}</p>
      <ScoreLine r={r} />
      {!ds.mission_within_coverage && (
        <p role="note" className="rounded-lg bg-amber-950 px-3 py-2 text-[11px] text-amber-200">
          Part of this mission falls outside the site data ({fmtUtc(ds.coverage_start_utc)} – {fmtUtc(ds.coverage_end_utc)}). That time is treated as unknown, never extrapolated.
        </p>
      )}
      {summary && <p className="text-[11px] leading-snug text-slate-400">{summary}</p>}
      <p className="text-xs text-slate-300" data-testid="assessment-decision">
        {decision.text || (a.eligibility === 'pass' ? 'Every configured requirement is met.' : '')}
        {decision.margin && <span className="text-slate-400"> · margin {decision.margin}</span>}
      </p>
      <p className="text-[11px] text-slate-500" data-testid="assessment-window">{windowLine}</p>
      {attention.length > 0 && (
        <ul className="space-y-2" aria-label="Requirements that fail or cannot be decided">
          {attention.map((c) => <ConstraintRow key={c.constraint_id} r={r} c={c} skey={skey} />)}
        </ul>
      )}
      {met.length > 0 && (
        <details className="rounded-xl border border-slate-800 px-3 py-2" open={attention.length === 0}>
          <summary className="cursor-pointer text-xs text-slate-300">{met.length} requirement{met.length > 1 ? 's' : ''} met</summary>
          <ul className="mt-2 space-y-2" aria-label="Requirements that are met">
            {met.map((c) => <ConstraintRow key={c.constraint_id} r={r} c={c} skey={skey} />)}
          </ul>
        </details>
      )}
      {notable.length > 0 && (
        <details className="rounded-xl border border-slate-800 px-3 py-2 text-[11px]">
          <summary className="cursor-pointer text-xs text-slate-300">Risk screen ({notable.length} above low)</summary>
          {riskSummary && <p className="mt-1 text-slate-400">{riskSummary}</p>}
          <ul className="mt-1 space-y-1">
            {notable.map((x) => (
              <li key={x.code}><span className={`mr-1 rounded border px-1 ${RISK_CLASS[x.level]}`}>{x.level}</span><span className="text-slate-300">{x.message}</span></li>
            ))}
          </ul>
        </details>
      )}
      <details className="rounded-xl border border-slate-800 px-3 py-2 text-[11px] text-slate-400">
        <summary className="cursor-pointer text-xs text-slate-300">Data, assumptions and limitations</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>Ephemeris: {prov.ephemeris_source}</li>
          <li>Terrain: {prov.terrain_source.split(';')[0]}{prov.terrain_source.includes(';') ? ' and coarser LOLA tiers' : ''}; horizon every {prov.horizon_azimuth_step_deg ?? '?'}° of azimuth</li>
          <li>Hourly samples ({ds.sample_count.toLocaleString()} in {ds.site_file}), each held until the next sample; window edges are no more precise than one hour.</li>
          <li>Sun: {ds.sun_criterion.replace(/_/g, ' ')} criterion · Earth: {ds.earth_criterion} criterion · data {fmtUtc(ds.coverage_start_utc)} – {fmtUtc(ds.coverage_end_utc)}</li>
          {(a.data_quality.warnings ?? []).map((w) => <li key={w} className="text-amber-300">{w}</li>)}
          {a.limitations.map((l) => <li key={l}>{l}</li>)}
          <li className="break-all">Dataset SHA-256 {ds.sha256.slice(0, 16)}… · engine {r.methods.engine}</li>
        </ul>
      </details>
    </div>
  )
}

/** The assessment panel for the Mission Planner sidebar. */
export function MissionAssessment() {
  const original = useRescueStore((s) => s.original)
  const selected = useRescueStore((s) => s.selected)
  const rescued = useRescueStore((s) => s.rescue?.changed.scenario ?? null)
  const change = useRescueStore((s) => s.change)
  // Before Rescue runs, a change entered in the Rescue form (e.g. a launch delay) is assessed as the same plan Rescue
  // will build, so "After change" is available straight away; Rescue's own changed plan takes over once it exists.
  const preview = useMemo(() => (original ? previewChangedPlan(original, change) : null), [original, change])
  const changed = rescued ?? preview
  const target = useAssessmentStore((s) => s.target)
  const setTarget = useAssessmentStore((s) => s.setTarget)
  // Follow the latest Rescue step: a new result shows the changed plan (what broke), a pick shows the pick.
  useEffect(() => setTarget(changed ? 'changed' : 'original'), [changed, setTarget])
  useEffect(() => {
    if (selected) setTarget('selected')
  }, [selected, setTarget])
  const scenario: Scenario | null =
    target === 'selected' && selected ? selected : target === 'changed' && changed ? changed : original
  const tabs = (['original', 'changed', 'selected'] as const).filter(
    (t) => t === 'original' || (t === 'changed' && changed) || (t === 'selected' && selected),
  )
  const TAB_LABEL = { original: 'Original plan', changed: 'After change', selected: 'Rescue pick' } as const
  const skey = scenario ? scenarioKey(scenario) : ''
  const state = useAssessmentStore((s) => (skey ? s.results[skey] : undefined))
  const assess = useAssessmentStore((s) => s.assess)
  const clearShowing = useAssessmentStore((s) => s.clearShowing)
  useEffect(() => {
    if (scenario) void assess(scenario)
  }, [skey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearShowing(), [clearShowing])

  return (
    <section id={ASSESSMENT_ID} aria-label="Mission assessment" tabIndex={-1} className="outline-none">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">Mission assessment</h2>
        {original && tabs.length > 1 && (
          <div role="tablist" aria-label="Which plan to assess" className="flex rounded-full border border-slate-700 text-[11px]">
            {tabs.map((t) => (
              <button key={t} role="tab" type="button" aria-selected={target === t} onClick={() => setTarget(t)}
                className={`rounded-full px-2.5 py-1 ${target === t ? 'bg-coral text-white' : 'text-slate-400'}`}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
        )}
      </div>
      {!scenario ? (
        <p className="rounded-2xl border border-dashed border-slate-700 p-4 text-xs text-slate-400">Run a plan (or press “Try a mission”) to see whether it meets its requirements and why.</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-slate-400">{scenario.site.name} · {fmtUtc(scenario.landing_utc)} · {scenario.duration_days} d</p>
          {!state || state.status === 'loading' ? (
            <p role="status" className="animate-pulse text-xs text-slate-400">Assessing with the canonical viability engine… The first assessment of a site loads five years of hourly data (a few seconds).</p>
          ) : state.status === 'error' ? (
            <div role="alert" className="space-y-2 rounded-xl bg-red-950 p-3 text-xs text-red-300">
              <p>{state.httpStatus === 404 ? `${scenario.site.name} has no precomputed scientific data, so it cannot be assessed here. ${state.message}` : state.message}</p>
              <button type="button" className="md-btn h-8 border border-red-800 px-3" onClick={() => void assess(scenario)}>Retry</button>
            </div>
          ) : (
            <AssessmentBody r={state.response} skey={skey} requested={scenario} />
          )}
        </>
      )}
    </section>
  )
}

const BODY_NAME = { sun: 'Sun', earth: 'Earth' } as const

/**
 * Floating explanation over the 3D view while evidence is shown: the requirement, its threshold, the measured value
 * or bounds, what the shaded window is, and the way back. Also explains a request the view could not show.
 * Mount once in the planner.
 */
export function EvidenceBanner() {
  // Rendered in <body> so it floats over the 3D view whichever sidebar container mounts it (no portal on the server).
  const host = (node: ReactNode) => (typeof document !== 'undefined' ? createPortal(node, document.body) : node)
  const h = useEvidence((s) => s.highlight)
  const problem = useEvidence((s) => s.problem)
  const request = useEvidence((s) => s.request)
  const left = 'left-1/2'
  if (problem && request?.id === problem.id) {
    return (
      host(<div role="alert" data-testid="evidence-banner" className={`ui-chrome pointer-events-auto fixed ${left} top-[calc(clamp(14px,2.5vw,34px)+clamp(22px,2.7vw,40px)+24px)] z-40 w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 rounded-2xl bg-black/80 px-4 py-3 text-xs text-white shadow-lg backdrop-blur`}>
        <p className="font-semibold">Cannot show this evidence{request.title ? `: ${request.title}` : ''}</p>
        <p className="mt-0.5 text-white/80">{problem.message}</p>
        <button type="button" onClick={() => returnFromEvidence(request)} className="mt-2 rounded-full border border-white/40 px-3 py-1 text-white hover:bg-white/10">
          {request.origin?.kind === 'comparison' ? 'Back to comparison' : 'Close'}
        </button>
      </div>)
    )
  }
  if (!h) return null
  const other = (h.bodies ?? []).find((b) => b !== h.body)
  const when = h.endMs === null || h.endMs === h.startMs
    ? `the moment ${h.startUtc.slice(0, 16).replace('T', ' ')} UTC`
    : 'the shaded window on the time strip'
  return (
    host(<div role="status" aria-live="polite" data-testid="evidence-banner" className={`ui-chrome pointer-events-auto fixed ${left} top-[calc(clamp(14px,2.5vw,34px)+clamp(22px,2.7vw,40px)+24px)] z-40 w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 rounded-2xl bg-black/75 px-4 py-3 text-xs text-white shadow-lg backdrop-blur`}>
      <p className="font-semibold">
        Show me why: {h.title ?? 'selected moment'}
        {h.origin && <span className="font-normal text-white/60"> · from {h.origin.label}</span>}
      </p>
      {h.dataMissing && <p className="mt-0.5 font-medium text-amber-200">Data missing</p>}
      {(h.requirement || h.measured) && (
        <p className="mt-0.5 tabular-nums text-white/90">
          {h.requirement && <>Required {h.requirement}</>}{h.requirement && h.measured && ' · '}{h.measured && <>Measured {h.measured}</>}
        </p>
      )}
      {h.detail && <p className="mt-0.5 text-white/80">{h.detail}</p>}
      {h.note && <p className="mt-0.5 text-amber-200">{h.note}</p>}
      <p className="mt-1 text-white/60">
        {h.dataMissing
          ? 'There are no usable samples in this period, so the requirement is undecided, not failed. The view shows the site at that time, but nothing there is a confirmed physical obstruction.'
          : `Looking toward the ${BODY_NAME[h.body]} from the lander at the start of ${when}. The horizon and blocker line come from LOLA terrain.`}
        {other && ` This requirement needs the Sun and Earth together; the ${BODY_NAME[h.body]} is only one side of it.`}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => returnFromEvidence(h)} className="rounded-full border border-white/40 px-3 py-1 text-white hover:bg-white/10">
          {h.origin?.kind === 'comparison' ? 'Back to comparison' : h.origin?.kind === 'guide' ? 'Exit evidence view' : h.origin?.returnTo ? `Back to ${h.origin.label}` : 'Back to assessment'}
        </button>
        {other && (
          <button type="button" onClick={() => showEvidence({ ...h, body: other })} className="rounded-full border border-white/40 px-3 py-1 text-white hover:bg-white/10">
            Look toward the {BODY_NAME[other]}
          </button>
        )}
      </div>
    </div>)
  )
}
