// The canonical viability assessment of one Planner plan, in full: POST /api/viability/assess-scenario
// (backend/app/viability/api, docs/viability-api.md). One cached request per plan revision serves both the plan
// card's verdict (planVerdict.ts) and the Mission assessment panel (features/assessment), so they never disagree.
//
// Nothing is decided here: every status, number, bound, margin and reason is the engine's. The helpers below
// only convert units for display. UNKNOWN stays UNKNOWN, a bound stays a range, unavailable stays unavailable.
import { useEffect } from 'react'

import { useAssessmentStore, type AssessState as StoreState } from '../features/assessment/useAssessmentStore'
import type { Eligibility, Scenario } from '../types'

// ---------------------------------------------------------------- wire types (subset of AssessResponse)

export type MetricStatus = 'known' | 'bounded' | 'unavailable' | 'not_applicable'
export type ConstraintStatus = 'pass' | 'fail' | 'unknown' | 'not_applicable'
export type RiskLevel = 'low' | 'moderate' | 'high' | 'unknown'
export type Severity = 'info' | 'warning' | 'critical'

export interface WireMetric {
  status: MetricStatus
  unit: string // 's' | 'percent' | 'fraction' | 'deg'
  value: number | null
  lower: number | null
  upper: number | null
  reason: string | null
}

export interface WireWindow {
  kind: string
  start_utc: string
  end_utc: string
  duration_s: number
  clipped_at_start: boolean
  clipped_at_end: boolean
}

export interface WireConstraint {
  constraint_id: string
  name: string
  status: ConstraintStatus
  comparison: 'at_least' | 'at_most' | null
  threshold: number | null
  unit: string
  measured: WireMetric
  message: string
  requirement_field: string | null
  metric_field: string | null
  unknown_reason: string | null
  condition_unknown_duration_s?: number | null
  evidence_windows: WireWindow[]
}

export interface WireMargin {
  margin_id: string
  related_constraint: string | null
  reference: number | null
  value: WireMetric
  description: string
}

export interface WireRisk {
  code: string
  level: RiskLevel
  rule: string
  evidence: WireMetric | null
  message: string
}

export interface WireExplanation {
  category: string // summary | constraint | margin | risk | data_quality | limitation | ...
  severity: Severity
  message: string
  related_constraint: string | null
}

export interface WireProvenance {
  is_synthetic: boolean
  ephemeris_source: string | null
  terrain_source: string | null
  terrain_resolution_m: number | null
  horizon_azimuth_step_deg: number | null
  generated_at_utc: string | null
  generator: string | null
  references: string[]
  coordinate_frame: string | null
  notes: string | null
}

export interface WireDataQuality {
  dataset_id: string
  calculation_basis: string
  angle_type: string
  sun_criterion: string
  earth_criterion: string
  sampling_policy: string
  evaluated_duration_s: number
  sample_count: number
  largest_sample_gap_s: number | null
  uncovered_duration_s: number
  coverage_gap_count: number
  sun_unknown_duration_s: number
  earth_unknown_duration_s: number
  sun_coverage_percent: number
  earth_coverage_percent: number
  assumptions: string[]
  warnings: string[]
}

export interface WireAssessment {
  scenario_id: string
  site: { id: string; name: string }
  evaluated_start_utc: string
  evaluated_end_utc: string
  eligibility: Eligibility
  constraints: WireConstraint[]
  margins: WireMargin[]
  risks: WireRisk[]
  overall_risk: RiskLevel
  explanations: WireExplanation[]
  data_quality: WireDataQuality
  limitations: string[]
  engine_version: string
}

export interface WireRankingStatus {
  eligibility: Eligibility
  rank_eligible: boolean
  score_status: 'known' | 'bounded' | 'eligibility_unknown' | 'no_scorable_components'
  score: number | null
  score_bounds: WireMetric | null
  overall_risk: RiskLevel
}

export interface WireInputDataset {
  site_file: string
  sha256: string
  dataset_id: string
  coverage_start_utc: string
  coverage_end_utc: string
  mission_within_coverage: boolean
  sample_count: number
  sampling: { nominal_interval_s: number; max_gap_s: number }
  calculation_basis: string
  sun_criterion: string
  earth_criterion: string
  observer_height_m: number | null
  provenance: WireProvenance
}

export interface AssessResponse {
  api_version: string
  assessment: WireAssessment
  ranking_status: WireRankingStatus
  explanation_details: { key: string; explanation: WireExplanation; risk_codes: string[]; details: string[] }[] | null
  input_dataset: WireInputDataset
  methods: Record<string, string>
}

export type AssessmentState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; response: AssessResponse }

// ---------------------------------------------------------------- fetching (one cached request per plan revision)

/** Everything the assessment depends on: site, exact landing instant, duration and every requirement. */
export function assessmentKey(sc: Scenario): string {
  return JSON.stringify([sc.site.id, Date.parse(sc.landing_utc) || sc.landing_utc, sc.duration_days, sc.requirements])
}

/** Adapter: the single request/cache layer is features/assessment/useAssessmentStore (one in-flight request and one
 * cached answer per exact mission), so this view of it and the Mission assessment panel can never disagree. */
function toState(s: StoreState): AssessmentState {
  if (s.status !== 'error') return s as unknown as AssessmentState
  return {
    status: 'error',
    message:
      s.httpStatus === 404
        ? s.message || 'no scientific data for this site'
        : s.httpStatus === 0
          ? 'backend unavailable'
          : `request failed (${s.httpStatus})${s.message ? `: ${s.message}` : ''}`,
  }
}

export function fetchAssessment(sc: Scenario): Promise<AssessmentState> {
  return useAssessmentStore.getState().assess(sc).then(toState)
}

/** Forget cached answers (tests). */
export const clearAssessmentCache = () => useAssessmentStore.setState({ results: {} })

/** The plan's full canonical assessment (loading until the engine has answered). Re-asked when the plan changes. */
export function useAssessment(sc: Scenario | null | undefined, enabled = true): AssessmentState | null {
  const key = sc && enabled && typeof fetch === 'function' ? assessmentKey(sc) : null
  const state = useAssessmentStore((s) => (key ? s.results[key] : undefined))
  useEffect(() => {
    if (!key || !sc) return
    void useAssessmentStore.getState().assess(sc)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the plan revision
  }, [key])
  if (!key) return null
  return state ? toState(state) : { status: 'loading' }
}

// ---------------------------------------------------------------- display (unit conversion only)

/** A duration in seconds as hours (and days too when over 4 days; limits like 50 h read best in hours). */
export function fmtDuration(s: number): string {
  const h = s / 3600
  const hText = `${Math.abs(h) >= 10 ? Math.round(h) : Number(h.toFixed(1))} h`
  return Math.abs(h) >= 96 ? `${(h / 24).toFixed(1)} d (${hText})` : hText
}

/** One value in the engine's unit, for display. `signed` adds + to positive values (margins). */
export function fmtValue(v: number, unit: string, signed = false): string {
  const sign = signed && v > 0 ? '+' : ''
  switch (unit) {
    case 's':
      return sign + fmtDuration(v)
    case 'percent':
      return `${sign}${Number(v.toFixed(1))} %`
    case 'fraction':
      return `${sign}${Number(v.toFixed(3))}`
    case 'deg':
      return `${sign}${Number(v.toFixed(2))}°`
    default:
      return `${sign}${Number(v.toFixed(3))} ${unit}`
  }
}

/** A metric exactly as the engine reports it: a value, a proven range, or why there is none. */
export function fmtMetric(m: WireMetric | null | undefined, signed = false): string {
  if (!m) return '—'
  if (m.status === 'known' && m.value !== null) return fmtValue(m.value, m.unit, signed)
  if (m.status === 'bounded') {
    const lo = m.lower === null ? '?' : fmtValue(m.lower, m.unit, signed)
    const hi = m.upper === null ? '?' : fmtValue(m.upper, m.unit, signed)
    return `between ${lo} and ${hi}`
  }
  if (m.status === 'not_applicable') return 'not applicable'
  return 'unavailable'
}

const COMPARISON_TEXT = { at_least: '≥', at_most: '≤' } as const

/** "≥ 500 h" / "≤ 50 h", or "not configured". */
export function fmtThreshold(c: Pick<WireConstraint, 'comparison' | 'threshold' | 'unit'>): string {
  if (c.threshold === null || c.comparison === null) return 'not configured'
  return `${COMPARISON_TEXT[c.comparison]} ${fmtValue(c.threshold, c.unit)}`
}

const UNKNOWN_REASON: Record<string, string> = {
  no_data: 'no data covers this part of the mission',
  partial_data: 'part of the mission has no data, and the known part cannot decide',
  outside_coverage: 'the mission runs past the end of the data',
}

/** Plain words for the engine's unknown_reason code (the code itself if it has no wording here). */
export const unknownReasonText = (code: string | null) => (code ? (UNKNOWN_REASON[code] ?? code.replace(/_/g, ' ')) : null)

const WINDOW_KIND_TEXT: Record<string, string> = {
  sunlight: 'Sunlight',
  darkness: 'Darkness',
  full_sunlight: 'Full sunlight',
  partial_sunlight: 'Partial sunlight',
  power_lit: 'Power-lit',
  power_dark: 'Power-dark',
  power_unknown: 'Power state unknown',
  sun_unknown: 'Sun unknown',
  earth_visible: 'Earth in view',
  communication_blackout: 'Communication blackout',
  earth_unknown: 'Earth unknown',
  unknown_data: 'No data',
}
export const windowKindText = (kind: string) => WINDOW_KIND_TEXT[kind] ?? kind.replace(/_/g, ' ')

/** One constraint with everything the engine says about it, ready to show. */
export interface ConstraintView {
  c: WireConstraint
  measured: string
  threshold: string
  margin: WireMargin | null
  marginText: string | null
  headroom: WireRisk | null // margin_headroom.<constraint_id>: the engine's screening level for this margin
  unknownReason: string | null
}

const STATUS_ORDER: Record<ConstraintStatus, number> = { fail: 0, unknown: 1, pass: 2, not_applicable: 3 }

/** Configured constraints first FAIL, then UNKNOWN, then PASS (the engine's explanation order); not-configured ones apart. */
export function constraintViews(a: WireAssessment): { configured: ConstraintView[]; notConfigured: WireConstraint[] } {
  const margins = new Map(a.margins.map((m) => [m.related_constraint ?? m.margin_id, m]))
  const risks = new Map(a.risks.map((r) => [r.code, r]))
  const configured = a.constraints
    .filter((c) => c.status !== 'not_applicable')
    .sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status])
    .map((c): ConstraintView => {
      const margin = margins.get(c.constraint_id) ?? null
      return {
        c,
        measured: fmtMetric(c.measured),
        threshold: fmtThreshold(c),
        margin,
        marginText: margin ? fmtMetric(margin.value, true) : null,
        headroom: risks.get(`margin_headroom.${c.constraint_id}`) ?? null,
        unknownReason: unknownReasonText(c.unknown_reason),
      }
    })
  return { configured, notConfigured: a.constraints.filter((c) => c.status === 'not_applicable') }
}

/** The score as the engine reports it: exact, a range, or why there is none (never 0 for "missing"). */
export function scoreText(r: WireRankingStatus): string {
  switch (r.score_status) {
    case 'known':
      return r.score === null ? '—' : `${Number(r.score.toFixed(1))} / 100`
    case 'bounded':
      return r.score_bounds?.lower !== null && r.score_bounds?.lower !== undefined && r.score_bounds.upper !== null
        ? `between ${Number(r.score_bounds.lower.toFixed(1))} and ${Number(r.score_bounds.upper.toFixed(1))}`
        : 'bounded (range unavailable)'
    case 'eligibility_unknown':
      return 'withheld: eligibility is UNKNOWN (not a score of 0)'
    case 'no_scorable_components':
      return 'no scorable components'
  }
}

/** Hours after the evaluated mission start (for "+12 h" labels on evidence windows). */
export const hoursAfter = (startUtc: string, t: string) => (Date.parse(t) - Date.parse(startUtc)) / 3_600_000
