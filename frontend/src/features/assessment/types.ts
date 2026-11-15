// Response of POST /api/viability/assess-scenario (backend app/viability/api/schemas.py AssessResponse;
// docs/viability-api.md). Only the fields the UI reads are typed; values are displayed, never recomputed.
import type { Eligibility } from '../../types'

export type ScoreStatus = 'known' | 'bounded' | 'eligibility_unknown' | 'no_scorable_components'

export type MetricStatus = 'known' | 'bounded' | 'unavailable'
export type Unit = 's' | 'percent' | 'fraction' | 'deg' | string

export interface Metric {
  status: MetricStatus
  unit: Unit
  value: number | null // known only
  lower: number | null // bounded only
  upper: number | null
  reason: string | null
}

export type ConstraintStatus = 'pass' | 'fail' | 'unknown' | 'not_applicable'
export type RiskLevel = 'low' | 'moderate' | 'high' | 'unknown'

export interface EngineWindow {
  kind: string
  start_utc: string
  end_utc: string
  duration_s: number
  clipped_at_start: boolean
  clipped_at_end: boolean
}

export interface ConstraintEvaluation {
  constraint_id: string
  name: string
  status: ConstraintStatus
  threshold: number | null
  unit: Unit
  comparison: 'at_most' | 'at_least' | string
  measured: Metric
  message: string
  unknown_reason: 'incomplete_data' | 'no_data' | 'unsupported' | null
  evidence_windows: EngineWindow[]
}

export interface Margin {
  margin_id: string
  related_constraint: string | null
  reference: number | null
  value: Metric
  description: string
}

export interface Risk {
  code: string
  level: RiskLevel
  rule: string
  message: string
}

export interface Explanation {
  category: string
  severity: 'info' | 'warning' | 'critical' | string
  message: string
  related_constraint: string | null
}

export interface ExplanationDetail {
  key: string
  explanation: Explanation
  details: string[]
}

export interface Provenance {
  is_synthetic: boolean
  ephemeris_source: string
  terrain_source: string
  horizon_azimuth_step_deg: number | null
  generated_at_utc: string | null
  generator: string | null
  references?: string[]
}

export interface Assessment {
  scenario_id: string
  site: { id: string; name: string; lat: number; lon: number }
  evaluated_start_utc: string
  evaluated_end_utc: string
  eligibility: Eligibility
  constraints: ConstraintEvaluation[]
  windows: EngineWindow[]
  margins: Margin[]
  risks: Risk[]
  overall_risk: RiskLevel
  explanations: Explanation[]
  data_quality: { assumptions?: string[]; warnings?: string[]; provenance?: Provenance; [k: string]: unknown }
  limitations: string[]
}

export interface RankingStatus {
  eligibility: Eligibility
  rank_eligible: boolean
  score_status: ScoreStatus | null
  score: number | null
  score_bounds: Metric | null
  score_lower_bound: number | null
  overall_risk: RiskLevel
}

export interface InputDataset {
  site_file: string
  sha256: string
  coverage_start_utc: string
  coverage_end_utc: string
  mission_within_coverage: boolean
  sample_count: number
  sampling: { nominal_interval_s: number; max_gap_s: number }
  calculation_basis: string
  sun_criterion: string
  earth_criterion: string
  provenance: Provenance
}

export interface AssessResponse {
  api_version: string
  assessment: Assessment
  ranking_status: RankingStatus
  explanation_details: ExplanationDetail[] | null
  input_dataset: InputDataset
  methods: { engine: string; scoring: string; ranking: string; explanations: string; api: string }
}
