// CSV / JSON export of the comparison (Phase 7). Pure functions over the data the dashboard displays.
//
// Integrity rules:
//   - a missing value stays missing (JSON null, empty CSV cell with its status in a *_status column), never 0;
//   - UNKNOWN stays "unknown";
//   - a canonical rank is only exported for an eligible PASS scenario, inside its comparable group;
//   - "recommended" is only true for the scenario the decision panel actually recommends;
//   - the mission window is the one the backend evaluated (missionTime.ts); the user's request is kept under
//     requested_*, and an evaluated field is null when nothing was evaluated (never the request, never 0).
//
// Rev. 2 (format still comparison-export-v1): landing_utc / duration_days are UNCHANGED and are the *requested* values
// (they are not the assessed window). The evaluated window is added as mission_time (JSON) and evaluated_* columns (CSV).
import { SCREENING_NOTE, formatMarginMetric } from '../../lib/headroom'
import type { ClosestRequirementInfo, Eligibility, HeadroomStatus, MarginMetricValue, MarginStatus, MissionRequirements, OperationalHeadroom } from '../../types'
import { eligibilityOf, headroomOfEntry, requirementSummary, type Entry } from './analysis'
import { buildDecision, withLabels } from './decision'
import { METRIC_FIELDS_ORDER } from './exportFields'
import { missionTime, type EvaluationStatus } from './missionTime'
import type { CanonicalMetric, PairEvidence, RankingGroup, SpacecraftConfig } from './types'

export const EXPORT_VERSION = 'comparison-export-v1' // format name unchanged: every v1 field keeps its meaning
/** Additive revision within v1. Rev. 2 adds mission_time and the evaluated_* / requested_* CSV columns; nothing is removed. */
export const EXPORT_REVISION = 2

export interface ExportedMetric {
  status: CanonicalMetric['status'] | 'missing'
  unit: string | null
  value: number | null
  lower: number | null
  upper: number | null
}

export interface ExportedRequirement {
  id: string
  name: string
  status: 'pass' | 'fail' | 'unknown' | 'not_applicable'
  comparison: string | null
  threshold: number | null
  measured: ExportedMetric
}

export interface ExportedScenario {
  label: string
  name: string
  origin: string
  site: { id: string; name: string; lat: number; lon: number }
  landing_utc: string // REQUESTED landing (v1 field, unchanged)
  duration_days: number // REQUESTED duration (v1 field, unchanged)
  mission_time: ExportedMissionTime
  requirements: MissionRequirements
  spacecraft: SpacecraftConfig
  data: {
    kind: string | null // real | demonstration | unavailable | null (not loaded)
    source: string | null
    dataset_id: string | null
    engine_version: string | null
    scoring_method_version: string | null
    sun_coverage_percent: number | null
    earth_coverage_percent: number | null
  }
  eligibility: Eligibility | null // null = not loaded / not assessed (never guessed)
  assessed: boolean
  canonical_rank: number | null // PASS only, within ranking_group
  ranking_group: string | null
  ranking_group_primary: boolean | null
  recommended: boolean
  score: { status: string | null; exact: number | null; lower: number | null; upper: number | null }
  overall_risk: string | null
  failed_requirements: string[]
  undecided_requirements: string[]
  requirement_verdicts: ExportedRequirement[]
  headroom: ExportedHeadroom | null
  margins: ExportedMargin[]
  metrics: Record<string, ExportedMetric>
  ranking_explanation: string | null
  message: string | null
}

/** The mission window: what the backend evaluated (null when nothing was) and what the user requested. */
export interface ExportedMissionTime {
  evaluation_status: EvaluationStatus
  evaluated_landing_utc: string | null
  evaluated_duration_days: number | null
  evaluated_duration_hours: number | null
  evaluated_end_utc: string | null
  requested_landing_utc: string
  requested_duration_days: number
  requested_duration_hours: number
  requested_end_utc: string
  time_adjusted: boolean | null // null = nothing evaluated
  time_note: string | null // the backend's explanation when it adjusted the request
}

export interface ExportedMargin {
  id: string
  name: string
  short_label: string
  unit: string
  margin_class: MarginStatus
  margin: ExportedMetric
  narrow_reason: string | null
}

export interface ExportedHeadroom {
  status: HeadroomStatus
  qualified_verdict: string
  limited_constraints: string[]
  closest_constraint: ClosestRequirementInfo | null
  darkness_headroom: ExportedMetric | null
  comms_blackout_headroom: ExportedMetric | null
  initial_sunlight: OperationalHeadroom['initial_sunlight']
  initial_earth: OperationalHeadroom['initial_earth']
  screening_note: string
}

export interface ComparisonExport {
  format: typeof EXPORT_VERSION
  export_revision: number // additive revision inside v1 (2 = mission_time, evaluated window)
  generated_at: string
  ranking_method: string | null
  ranking_groups: { id: string; primary: boolean; ranked: string[]; members: string[]; separate_reason: string | null; data_basis: string | null }[]
  decisions: { group: string; kind: string; recommended: string | null; headline: string; requirements: string[]; evidence: string[]; tradeoffs: string[]; uncertainty: string[] }[]
  scenarios: ExportedScenario[]
  notes: string[]
  warnings: string[] // inconsistencies found and corrected on export (should be empty)
}

const metric = (m: CanonicalMetric | undefined | null): ExportedMetric =>
  m ? { status: m.status, unit: m.unit, value: m.status === 'known' ? m.value : null,
    lower: m.status === 'bounded' ? m.lower : null, upper: m.status === 'bounded' ? m.upper : null }
    : { status: 'missing', unit: null, value: null, lower: null, upper: null }

const exportMarginValue = (m: MarginMetricValue): ExportedMetric => ({
  status: m.status,
  unit: m.unit,
  value: m.status === 'known' ? (m.value ?? null) : null,
  lower: m.status === 'bounded' ? (m.lower ?? null) : null,
  upper: m.status === 'bounded' ? (m.upper ?? null) : null,
})

export function exportMissionTime(e: Pick<Entry, 'scenario' | 'state'>): ExportedMissionTime {
  const t = missionTime(e)
  return {
    evaluation_status: t.status,
    evaluated_landing_utc: t.evaluated?.landing_utc ?? null,
    evaluated_duration_days: t.evaluated?.duration_days ?? null,
    evaluated_duration_hours: t.evaluated?.duration_hours ?? null,
    evaluated_end_utc: t.evaluated?.end_utc ?? null,
    requested_landing_utc: t.requested.landing_utc,
    requested_duration_days: t.requested.duration_days,
    requested_duration_hours: t.requested.duration_hours,
    requested_end_utc: t.requested.end_utc,
    time_adjusted: t.adjusted,
    time_note: t.time_note,
  }
}

export function buildExport(entries: Entry[], groups: RankingGroup[], pairs: PairEvidence[], notes: string[], now = new Date()): ComparisonExport {
  const decision = buildDecision(entries, groups, pairs)
  const recommended = new Set(decision.groups.filter((d) => d.kind === 'recommended' || d.kind === 'single_pass')
    .map((d) => d.recommended?.scenario.id).filter((x): x is string => !!x))
  const labelOfKey = new Map(entries.filter((e) => e.result).map((e) => [e.result!.key, e.scenario.label]))
  const warnings: string[] = []

  const scenarios = entries.map((e): ExportedScenario => {
    const r = e.result, a = r?.assessment, rk = e.ranking
    const el = eligibilityOf(e)
    let rank = rk?.rank ?? null
    if (rank !== null && el !== 'pass') {
      warnings.push(`Scenario ${e.scenario.label}: a rank was reported for a ${el ?? 'non-assessed'} scenario and was not exported.`)
      rank = null
    }
    const req = requirementSummary(e)
    const hr = headroomOfEntry(e)
    const group = rk?.group ? groups.find((g) => g.id === rk.group) : undefined
    const rawMargins = a?.margins ?? hr?.constraints ?? []
    const resolveExportMetric = (k: string): ExportedMetric => {
      if (a?.metrics[k]) return metric(a.metrics[k])
      if (a && k === 'time_to_first_sunset_h' && a.metrics['initial_sunlight_h']?.status === 'known') {
        const hrEnd = hr?.initial_sunlight.first_end_hours
        if (hrEnd && (hrEnd.status === 'known' || hrEnd.status === 'bounded')) return exportMarginValue(hrEnd)
        const end = r?.viability?.metrics.hours_to_first_sunset ?? null
        if (end !== null) return { status: 'known', unit: 'h', value: end, lower: null, upper: null }
      }
      if (a && k === 'time_to_first_earthset_h' && a.metrics['initial_earth_h']?.status === 'known') {
        const hrEnd = hr?.initial_earth.first_end_hours
        if (hrEnd && (hrEnd.status === 'known' || hrEnd.status === 'bounded')) return exportMarginValue(hrEnd)
        const end = r?.viability?.metrics.hours_to_first_earthset ?? null
        if (end !== null) return { status: 'known', unit: 'h', value: end, lower: null, upper: null }
      }
      return metric(null)
    }
    return {
      label: e.scenario.label,
      name: e.scenario.name,
      origin: e.scenario.origin,
      site: { ...e.scenario.site },
      landing_utc: e.scenario.landing_utc,
      duration_days: e.scenario.duration_days,
      mission_time: exportMissionTime(e),
      requirements: { ...e.scenario.requirements },
      spacecraft: { ...e.scenario.spacecraft },
      data: {
        kind: e.state?.state === 'done' ? e.state.result.data_kind : null,
        source: e.state?.state === 'done' ? e.state.result.data_source : null,
        dataset_id: a?.dataset_id ?? null,
        engine_version: a?.engine_version ?? null,
        scoring_method_version: a?.scoring_method_version ?? null,
        sun_coverage_percent: a?.sun_coverage_percent ?? null,
        earth_coverage_percent: a?.earth_coverage_percent ?? null,
      },
      eligibility: el,
      assessed: !!a,
      canonical_rank: rank,
      ranking_group: rk?.group ?? null,
      ranking_group_primary: group ? group.primary : null,
      recommended: el === 'pass' && recommended.has(e.scenario.id),
      score: {
        status: rk?.score_status ?? null,
        exact: rk?.score_status === 'known' ? rk.score : null,
        lower: rk?.score_status === 'bounded' ? rk.score_lower : null,
        upper: rk?.score_status === 'bounded' ? rk.score_upper : null,
      },
      overall_risk: a?.overall_risk ?? null,
      failed_requirements: req ? req.failed.map((f) => f.name) : [],
      undecided_requirements: req ? req.undecided.map((f) => f.name) : [],
      requirement_verdicts: (a?.constraints ?? []).map((c) => ({
        id: c.id, name: c.name ?? c.id, status: c.status, comparison: c.comparison, threshold: c.threshold, measured: metric(c.measured),
      })),
      headroom: hr ? {
        status: hr.status,
        qualified_verdict: hr.qualified_verdict,
        limited_constraints: [...hr.limited_constraints],
        closest_constraint: hr.closest_constraint ? { ...hr.closest_constraint } : null,
        darkness_headroom: hr.darkness ? exportMarginValue(hr.darkness.margin) : null,
        comms_blackout_headroom: hr.communication_blackout ? exportMarginValue(hr.communication_blackout.margin) : null,
        initial_sunlight: { ...hr.initial_sunlight },
        initial_earth: { ...hr.initial_earth },
        screening_note: hr.screening_note || SCREENING_NOTE,
      } : null,
      margins: rawMargins.map((m) => ({
        id: m.id,
        name: m.name,
        short_label: m.short_label,
        unit: m.unit,
        margin_class: m.margin_class,
        margin: exportMarginValue(m.margin),
        narrow_reason: m.narrow_reason ?? null,
      })),
      metrics: Object.fromEntries(METRIC_FIELDS_ORDER.map((k) => [k, resolveExportMetric(k)])),
      ranking_explanation: rk?.explanation ? withLabels(rk.explanation, entries, pairs) : null,
      message: e.state?.state === 'done' ? e.state.result.message : e.state?.state === 'error' ? e.state.message : null,
    }
  })

  const lbl = (k: string) => labelOfKey.get(k) ?? k
  return {
    format: EXPORT_VERSION,
    export_revision: EXPORT_REVISION,
    generated_at: now.toISOString(),
    ranking_method: groups[0]?.method_version ?? null,
    ranking_groups: groups.map((g) => ({ id: g.id, primary: g.primary, ranked: g.ranked_keys.map(lbl), members: g.keys.map(lbl),
      separate_reason: g.separate_reason, data_basis: g.data_basis })),
    decisions: decision.groups.map((d) => ({
      group: d.group.id, kind: d.kind, recommended: d.kind === 'recommended' || d.kind === 'single_pass' ? d.recommended?.scenario.label ?? null : null,
      headline: d.headline, requirements: d.requirements.map((r) => r.text), evidence: d.evidence,
      tradeoffs: d.tradeoffs.map((t) => [...t.aBetter.map((x) => `${t.a.scenario.label}: ${x}`), ...t.bBetter.map((x) => `${t.b.scenario.label}: ${x}`)].join('; ')).filter(Boolean),
      uncertainty: d.uncertainty,
    })),
    scenarios,
    notes: [...decision.notes, ...notes],
    warnings,
  }
}

// ---------------------------------------------------------------- CSV

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '' // missing stays missing (its *_status column says why)
  const s = typeof v === 'string' ? v : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : JSON.stringify(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** One row per scenario. Every metric has value / lower / upper / status columns, so bounds and gaps survive. */
export function toCsv(x: ComparisonExport): string {
  const head = [
    'label', 'name', 'site_id', 'site_name', 'lat', 'lon', 'landing_utc', 'duration_days',
    'data_kind', 'data_source', 'dataset_id', 'engine_version', 'scoring_method_version', 'sun_coverage_percent', 'earth_coverage_percent',
    'eligibility', 'assessed', 'canonical_rank', 'ranking_group', 'ranking_group_primary', 'recommended',
    'score_status', 'score', 'score_lower', 'score_upper', 'overall_risk', 'failed_requirements', 'undecided_requirements',
    ...Object.keys(x.scenarios[0]?.requirements ?? {}).map((k) => `req_${k}`),
    ...METRIC_FIELDS_ORDER.flatMap((k) => [k, `${k}_lower`, `${k}_upper`, `${k}_status`]),
    'headroom_status', 'qualified_verdict', 'closest_constraint_id', 'closest_constraint_label', 'closest_constraint_status', 'closest_constraint_margin',
    'darkness_headroom', 'darkness_headroom_lower', 'darkness_headroom_upper', 'darkness_headroom_status',
    'comms_blackout_headroom', 'comms_blackout_headroom_lower', 'comms_blackout_headroom_upper', 'comms_blackout_headroom_status',
    'initial_sunlight_hours', 'time_to_first_sunset_hours', 'initial_earth_hours', 'time_to_first_earthset_hours',
    'margins_summary', 'screening_note',
    // rev. 2 additions (appended, so every v1 column keeps its position)
    'evaluation_status', 'evaluated_landing_utc', 'evaluated_duration_hours', 'evaluated_end_utc',
    'requested_landing_utc', 'requested_duration_days', 'requested_end_utc', 'time_adjusted', 'time_note',
  ]
  const rows = x.scenarios.map((s) => [
    s.label, s.name, s.site.id, s.site.name, s.site.lat, s.site.lon, s.landing_utc, s.duration_days,
    s.data.kind, s.data.source, s.data.dataset_id, s.data.engine_version, s.data.scoring_method_version,
    s.data.sun_coverage_percent, s.data.earth_coverage_percent,
    s.eligibility ?? 'not_assessed', s.assessed, s.canonical_rank, s.ranking_group, s.ranking_group_primary, s.recommended,
    s.score.status, s.score.exact, s.score.lower, s.score.upper, s.overall_risk,
    s.failed_requirements.join('; '), s.undecided_requirements.join('; '),
    ...Object.values(s.requirements),
    ...METRIC_FIELDS_ORDER.flatMap((k) => { const m = s.metrics[k]; return [m.value, m.lower, m.upper, m.status] }),
    s.headroom?.status ?? null,
    s.headroom?.qualified_verdict ?? null,
    s.headroom?.closest_constraint?.constraint_id ?? null,
    s.headroom?.closest_constraint?.label ?? null,
    s.headroom?.closest_constraint?.margin_class ?? null,
    s.headroom?.closest_constraint?.headroom_text ?? null,
    s.headroom?.darkness_headroom?.value ?? null,
    s.headroom?.darkness_headroom?.lower ?? null,
    s.headroom?.darkness_headroom?.upper ?? null,
    s.headroom?.darkness_headroom?.status ?? null,
    s.headroom?.comms_blackout_headroom?.value ?? null,
    s.headroom?.comms_blackout_headroom?.lower ?? null,
    s.headroom?.comms_blackout_headroom?.upper ?? null,
    s.headroom?.comms_blackout_headroom?.status ?? null,
    s.headroom?.initial_sunlight.duration.value ?? null,
    s.headroom?.initial_sunlight.first_end_hours.value ?? null,
    s.headroom?.initial_earth.duration.value ?? null,
    s.headroom?.initial_earth.first_end_hours.value ?? null,
    s.margins.map((m) => {
      const mv: MarginMetricValue = {
        status: m.margin.status === 'missing' ? 'unavailable' : m.margin.status as MarginMetricValue['status'],
        unit: m.unit,
        value: m.margin.value,
        lower: m.margin.lower,
        upper: m.margin.upper,
      }
      return `${m.id}:${formatMarginMetric(mv, true)}(${m.margin_class})`
    }).join('; '),
    s.headroom?.screening_note ?? SCREENING_NOTE,
    s.mission_time.evaluation_status, s.mission_time.evaluated_landing_utc, s.mission_time.evaluated_duration_hours,
    s.mission_time.evaluated_end_utc, s.mission_time.requested_landing_utc, s.mission_time.requested_duration_days,
    s.mission_time.requested_end_utc, s.mission_time.time_adjusted, s.mission_time.time_note,
  ].map(cell).join(','))
  return [head.join(','), ...rows].join('\r\n') + '\r\n'
}

/** Trigger a browser download of generated text (no network involved). */
export function downloadText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
