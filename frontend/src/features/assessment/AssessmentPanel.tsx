// Mission assessment: the viability engine's full answer for one Planner plan (POST /api/viability/assess-scenario,
// read through lib/assessment.ts). Each requirement with its measured value or proven range, threshold, margin and
// screening headroom; the evidence windows behind each verdict (with "Show in 3D"); the other screening risks; the
// dataset's provenance, coverage and assumptions; the engine's limitations and method versions.
//
// Display only: every status, value, range, margin and sentence is the engine's. Nothing is re-derived here.
import { useState } from 'react'
import { createPortal } from 'react-dom'

import {
  constraintViews,
  fmtDuration,
  fmtMetric,
  hoursAfter,
  scoreText,
  useAssessment,
  windowKindText,
  type AssessResponse,
  type AssessmentState,
  type ConstraintView,
  type RiskLevel,
  type Severity,
  type WireWindow,
} from '../../lib/assessment'
import type { Scenario } from '../../types'
import { evidenceFromWindow, showEvidence, type EvidenceOrigin } from '../../viz/evidence'
import { EligibilityBadge, ReqIcon } from '../compare/ui'

const RISK_CLS: Record<RiskLevel, string> = {
  low: 'border-emerald-700/50 text-emerald-300',
  moderate: 'border-amber-600/50 text-amber-200',
  high: 'border-red-700/60 text-red-300',
  unknown: 'border-slate-600 text-slate-400',
}
const SEVERITY_CLS: Record<Severity, string> = { critical: 'text-red-300', warning: 'text-amber-200', info: 'text-slate-400' }
const STATUS_TEXT = { pass: 'Met', fail: 'Failed', unknown: 'Undecided', not_applicable: 'Not configured' } as const

function RiskChip({ level, label, title }: { level: RiskLevel; label?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${RISK_CLS[level]}`}>
      {label ? `${label}: ` : ''}
      {level.toUpperCase()}
    </span>
  )
}

const fmtUtc = (iso: string) => iso.replace('T', ' ').replace(/:00(\.000)?Z$/, ' UTC').replace(/Z$/, ' UTC')

function EvidenceRow({ w, siteId, missionStart, onShown, origin }: { w: WireWindow; siteId: string; missionStart: string; onShown?: () => void; origin?: EvidenceOrigin }) {
  const ev = evidenceFromWindow(siteId, w)
  const from = hoursAfter(missionStart, w.start_utc)
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="font-medium text-slate-200">{windowKindText(w.kind)}</span>
      <span className="text-slate-400">
        {fmtDuration(w.duration_s)} · {fmtUtc(w.start_utc)} → {fmtUtc(w.end_utc)} (from +{Number(from.toFixed(1))} h)
      </span>
      {(w.clipped_at_start || w.clipped_at_end) && (
        <span className="text-slate-500" title="Cut by the mission bounds: it continues beyond them, so it was not observed to start or end there.">
          {w.clipped_at_start && w.clipped_at_end ? 'spans the whole mission' : w.clipped_at_start ? 'already under way at landing' : 'still going at mission end'}
        </span>
      )}
      {ev && (
        <button
          type="button"
          className="ml-auto rounded-full border border-sky-700/60 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-sky-900/30"
          title="Jump the 3D view to this moment, looking at the body concerned from the lander"
          onClick={() => {
            showEvidence(origin ? { ...ev, origin } : ev)
            onShown?.()
          }}
        >
          Show in 3D
        </button>
      )}
    </li>
  )
}

function ConstraintRow({ v, siteId, missionStart, onShown, origin }: { v: ConstraintView; siteId: string; missionStart: string; onShown?: () => void; origin?: EvidenceOrigin }) {
  const { c } = v
  const tone = c.status === 'fail' ? 'border-red-800/60 bg-red-950/20' : c.status === 'unknown' ? 'border-slate-600 bg-slate-800/20' : 'border-slate-800'
  return (
    <li className={`rounded-xl border p-3 ${tone}`}>
      <details open={c.status !== 'pass'}>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1">
          <ReqIcon status={c.status} />
          <span className="text-sm font-medium text-slate-100">{c.name}</span>
          <span className={`text-[11px] font-semibold ${c.status === 'fail' ? 'text-red-300' : c.status === 'unknown' ? 'text-slate-300' : 'text-emerald-300'}`}>
            {STATUS_TEXT[c.status]}
          </span>
          {v.headroom && (
            <span className="ml-auto">
              <RiskChip level={v.headroom.level} label="Headroom" title={`${v.headroom.message}\n\nRule: ${v.headroom.rule}`} />
            </span>
          )}
        </summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-slate-500">Measured</dt>
          <dd className="tabular-nums text-slate-200" title={c.measured.reason ?? undefined}>
            {v.measured}
            {c.measured.status !== 'known' && c.measured.reason && <span className="ml-1 text-slate-500">({c.measured.reason})</span>}
          </dd>
          <dt className="text-slate-500">Required</dt>
          <dd className="tabular-nums text-slate-200">{v.threshold}</dd>
          {v.margin && (
            <>
              <dt className="text-slate-500">Margin</dt>
              <dd className="tabular-nums text-slate-200" title={v.margin.description}>
                {v.marginText}
                {v.margin.value.status === 'bounded' && <span className="ml-1 text-slate-500">(proven range, not an observation)</span>}
              </dd>
            </>
          )}
          {v.unknownReason && (
            <>
              <dt className="text-slate-500">Why undecided</dt>
              <dd className="text-slate-300">
                {v.unknownReason}
                {c.condition_unknown_duration_s ? ` · ${fmtDuration(c.condition_unknown_duration_s)} of unknown state` : ''}
              </dd>
            </>
          )}
        </dl>
        <p className="mt-2 text-xs leading-relaxed text-slate-300">{c.message}</p>
        {c.evidence_windows.length > 0 && (
          <div className="mt-2">
            <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">Evidence</div>
            <ul className="space-y-1 text-xs">
              {c.evidence_windows.map((w) => (
                <EvidenceRow key={`${w.kind}${w.start_utc}`} w={w} siteId={siteId} missionStart={missionStart} onShown={onShown} origin={origin} />
              ))}
            </ul>
          </div>
        )}
        {c.requirement_field && <p className="mt-1 text-[10px] text-slate-500">Requirement field: {c.requirement_field}</p>}
      </details>
    </li>
  )
}

function Field({ k, v, title }: { k: string; v: React.ReactNode; title?: string }) {
  return (
    <>
      <dt className="text-slate-500">{k}</dt>
      <dd className="min-w-0 break-words text-slate-200" title={title}>
        {v}
      </dd>
    </>
  )
}

function Provenance({ r }: { r: AssessResponse }) {
  const a = r.assessment
  const dq = a.data_quality
  const ds = r.input_dataset
  const p = ds.provenance
  return (
    <section aria-label="Data and provenance">
      <h3 className="mb-1.5 text-sm font-semibold text-slate-100">Data and provenance</h3>
      {p.is_synthetic && (
        <p className="mb-2 rounded-lg border border-amber-600/50 bg-amber-900/20 px-2 py-1 text-xs text-amber-200">
          Synthetic data: illustrates the tool only, not real lunar conditions.
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <Field k="Ephemeris" v={p.ephemeris_source ?? '—'} />
        <Field k="Terrain" v={p.terrain_source ?? '—'} />
        {p.horizon_azimuth_step_deg !== null && <Field k="Horizon mask" v={`every ${p.horizon_azimuth_step_deg}° of azimuth`} />}
        <Field k="Frame" v={p.coordinate_frame ?? '—'} />
        <Field k="Criteria" v={`Sun: ${ds.sun_criterion.replace(/_/g, ' ')} · Earth: ${ds.earth_criterion.replace(/_/g, ' ')} · ${ds.calculation_basis.replace(/_/g, ' ')}`} />
        {ds.observer_height_m !== null && <Field k="Observer" v={`${ds.observer_height_m} m above the ground`} />}
        <Field k="Dataset" v={ds.dataset_id} />
        <Field k="Site file" v={<span className="font-mono text-[11px]">{ds.site_file}</span>} />
        <Field k="SHA-256" v={<span className="font-mono text-[11px]">{ds.sha256.slice(0, 16)}…</span>} title={ds.sha256} />
        <Field k="Data covers" v={`${fmtUtc(ds.coverage_start_utc)} → ${fmtUtc(ds.coverage_end_utc)}${ds.mission_within_coverage ? '' : ' (the mission runs outside it)'}`} />
        <Field k="Sampling" v={`${dq.sample_count} samples, every ${fmtDuration(ds.sampling.nominal_interval_s)} (${dq.sampling_policy.replace(/_/g, '-')})`} />
        <Field
          k="Coverage"
          v={`Sun known ${Number(dq.sun_coverage_percent.toFixed(1))} % · Earth known ${Number(dq.earth_coverage_percent.toFixed(1))} %${dq.uncovered_duration_s > 0 ? ` · ${fmtDuration(dq.uncovered_duration_s)} with no sample` : ''}`}
        />
        {p.generator && <Field k="Generated by" v={`${p.generator}${p.generated_at_utc ? `, ${fmtUtc(p.generated_at_utc)}` : ''}`} />}
      </dl>
      {p.references.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-slate-400">
          {p.references.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      {dq.warnings.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-amber-200">
          {dq.warnings.map((t) => (
            <li key={t}>⚠ {t}</li>
          ))}
        </ul>
      )}
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-slate-400">Assumptions ({dq.assumptions.length})</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">
          {dq.assumptions.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </details>
    </section>
  )
}

/** The engine's full answer for one plan (or its loading / error state). */
export function AssessmentPanel({ state, onShown, origin }: { state: AssessmentState | null; onShown?: () => void; origin?: EvidenceOrigin }) {
  if (!state || state.status === 'loading') return <p className="text-xs text-slate-400">Assessing this plan with the viability engine…</p>
  if (state.status === 'error') return <p role="alert" className="text-xs text-red-300">Not assessed: {state.message}</p>
  const r = state.response
  const a = r.assessment
  const { configured, notConfigured } = constraintViews(a)
  const summary = a.explanations.filter((e) => e.category === 'summary')
  const otherRisks = a.risks.filter((k) => !k.code.startsWith('margin_headroom.'))
  return (
    <div className="space-y-4 text-slate-200" data-testid="assessment-panel">
      <section aria-label="Verdict" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <EligibilityBadge eligibility={a.eligibility} />
          <RiskChip level={a.overall_risk} label="Screening risk" title="Rule-based screening category, not a probability; LOW does not mean safe." />
          <span className="text-xs text-slate-400">Score: {scoreText(r.ranking_status)}</span>
        </div>
        <p className="text-xs text-slate-400">
          Evaluated {fmtUtc(a.evaluated_start_utc)} → {fmtUtc(a.evaluated_end_utc)} (hourly grid) · {a.site.name}
        </p>
        {summary.map((e) => (
          <p key={e.message} className={`text-xs leading-relaxed ${SEVERITY_CLS[e.severity]}`}>
            {e.message}
          </p>
        ))}
      </section>

      <section aria-label="Requirements">
        <h3 className="mb-1.5 text-sm font-semibold text-slate-100">Requirements</h3>
        <ul className="space-y-2">
          {configured.map((v) => (
            <ConstraintRow key={v.c.constraint_id} v={v} siteId={a.site.id} missionStart={a.evaluated_start_utc} onShown={onShown} origin={origin} />
          ))}
        </ul>
        {notConfigured.length > 0 && (
          <p className="mt-2 text-[11px] text-slate-500" title={notConfigured.map((c) => c.message).join('\n')}>
            Not configured, so not evaluated: {notConfigured.map((c) => c.name).join(' · ')}
          </p>
        )}
      </section>

      {otherRisks.length > 0 && (
        <section aria-label="Screening risks">
          <h3 className="mb-1.5 text-sm font-semibold text-slate-100">Screening risks</h3>
          <ul className="space-y-1 text-xs">
            {otherRisks.map((k) => (
              <li key={k.code} className="flex items-start gap-2">
                <RiskChip level={k.level} title={`Rule: ${k.rule}`} />
                <span className="text-slate-300">
                  {k.message}
                  {k.evidence && k.evidence.status !== 'not_applicable' && <span className="ml-1 text-slate-500">({fmtMetric(k.evidence)})</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-slate-500">Screening categories from stated rules (hover for each rule), not probabilities.</p>
        </section>
      )}

      <Provenance r={r} />

      <section aria-label="Limitations">
        <h3 className="mb-1.5 text-sm font-semibold text-slate-100">What this assessment cannot tell you</h3>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-slate-400">
          {a.limitations.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>

      {r.explanation_details && r.explanation_details.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-400">All engine explanations ({r.explanation_details.length})</summary>
          <ul className="mt-1 space-y-1.5">
            {r.explanation_details.map((d) => (
              <li key={d.key}>
                <p className={SEVERITY_CLS[d.explanation.severity]}>
                  <span className="mr-1 text-[10px] uppercase tracking-wide text-slate-500">{d.explanation.category.replace(/_/g, ' ')}</span>
                  {d.explanation.message}
                </p>
                {d.details.length > 0 && <p className="pl-2 font-mono text-[10px] text-slate-500">{d.details.join(' · ')}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-[10px] text-slate-500">
        Viability engine {a.engine_version} · {Object.entries(r.methods).map(([k, v]) => `${k} ${v}`).join(' · ')}
      </p>
    </div>
  )
}

/**
 * "Details" for a plan card: the full assessment in a dialog. "Show in 3D" closes it and opens the evidence; when
 * `onReopen` is given, the evidence banner's Back button brings this same dialog back (not the running plan's panel).
 */
export function AssessmentDialog({ title, scenario, onClose, onReopen }: { title: string; scenario: Scenario; onClose: () => void; onReopen?: () => void }) {
  const state = useAssessment(scenario)
  const origin: EvidenceOrigin | undefined = onReopen ? { kind: 'assessment', label: `${title} assessment`, returnTo: onReopen } : undefined
  const [closing, setClosing] = useState(false)
  const close = () => setClosing(true)
  return createPortal(
    <div
      className={`fixed inset-0 z-[60] flex items-center justify-center p-4 ${closing ? 'md-snack-out' : ''}`}
      onAnimationEnd={(e) => closing && e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && close()}
    >
      <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Mission assessment: ${title}`}
        className={`lp-light relative flex max-h-[90vh] w-[min(44rem,100%)] flex-col rounded-[28px] bg-opal-50 shadow-2xl shadow-black/50 ${closing ? '' : 'md-dialog-in'}`}
      >
        <div className="flex items-start justify-between gap-2 px-6 pb-2 pt-5">
          <div>
            <h2 className="text-xl leading-7">Mission assessment</h2>
            <p className="text-xs text-slate-400">
              {title} · viability engine, the same answer Comparison and Rescue use
            </p>
          </div>
          <button type="button" className="md-dp-text-button" onClick={close} autoFocus>
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <AssessmentPanel state={state} onShown={close} origin={origin} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
