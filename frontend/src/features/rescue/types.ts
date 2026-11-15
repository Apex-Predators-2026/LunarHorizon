// Mission Rescue & Optimization (Member 5): request/response types.
// Mirrors backend/app/rescue/schemas.py. Shared types (Site, Scenario, ViabilityResult...)
// live in src/types.ts. Keep all of them in sync with the backend and docs/interfaces.md.
import type { MissionRequirements, RequirementKey, Scenario, Site, ViabilityResult } from '../../types'

// ---------------------------------------------------------------- inputs

export type RequirementOverrides = Partial<MissionRequirements>

export interface PlanChange {
  launch_delay_days?: number
  new_duration_days?: number | null
  requirement_overrides?: RequirementOverrides
  reason?: string | null
}

export interface SearchOptions {
  date_window_days?: number
  date_step_hours?: number
  allow_earlier_dates?: boolean
  earlier_window_days?: number
  candidate_site_ids?: string[] | null
  max_site_distance_km?: number | null
  include_nearby_points?: boolean
  nearby_radii_km?: number[]
  nearby_bearings?: number
  top_n?: number
  min_separation_hours?: number
  date_penalty_per_day?: number
  distance_penalty_per_km?: number
  clearance_bonus_per_deg?: number
  robustness_check?: boolean
  include_synthetic?: boolean | null // simulation mode: true = synthetic placeholder data allowed; off = real data only (else UNKNOWN)
}

export interface RescueRequest {
  original: Scenario
  change?: PlanChange
  search?: SearchOptions
}

// ---------------------------------------------------------------- outputs

export type AltKind = 'unchanged' | 'date_shift' | 'site_change' | 'site_and_date'

export interface MetricDelta {
  metric: string
  label: string
  unit: 'fraction' | 'h' | 'points'
  before: number | null
  after: number | null
  delta: number | null
  better: boolean | null
}

export interface DateSlipCheck {
  date_offset_hours: number
  status: SensitivityStatus
  passes: boolean
  darkness_headroom_h?: number | null
  comms_headroom_h?: number | null
  closest_label?: string | null
  closest_headroom_text?: string | null
  headroom_status?: string | null
  failing_constraints: RequirementKey[]
  reason?: UndecidedReason | null
}

export interface Robustness {
  checked_points: number
  passing_points: number
  pass_rate: number | null // null = nothing could be checked
  worst_score: number | null // null = none of the checks was scored
  verdict: 'robust' | 'sensitive' | 'fragile' | 'unchecked'
  note: string
  date_checks?: DateSlipCheck[]
  date_passing?: number
  date_checked?: number
  date_note?: string | null
}

export interface Alternative {
  rank: number
  kind: AltKind
  is_catalog_site: boolean
  scenario: Scenario
  viability: ViabilityResult
  rank_score: number | null // null = unscored result (ranked after scored ones, never as 0)
  date_shift_hours: number // vs the delayed landing time
  distance_km: number // vs the original site
  improvements: MetricDelta[] // vs the changed (broken) plan
  robustness: Robustness | null
  headline: string
  reasons: string[]
}

export interface NearMiss {
  kind: AltKind
  scenario: Scenario
  viability: ViabilityResult
  closeness: number
  date_shift_hours: number
  distance_km: number
  why_it_fails: string[]
}

export interface RequirementChange {
  constraint: RequirementKey
  label: string
  unit: 'fraction' | 'h'
  current: number
  suggested: number
  change_percent: number
}

export interface LooseningSuggestion {
  changes: RequirementChange[]
  total_relative_change: number
  keeps_original_plan: boolean
  unlocks: Scenario
  unlocks_score: number | null
  message: string
}

export interface SearchStats {
  candidates_evaluated: number
  locations_considered: number
  passing: number
  synthetic_candidates_excluded: number // skipped: no real data there (only searched in simulation mode)
  undecided: number // eligibility "unknown" (missing data)
  date_range_start: string
  date_range_end: string
}

export type RescueStatus = 'still_viable' | 'rescued' | 'no_viable_alternative'

export interface RescueResponse {
  status: RescueStatus
  summary: string
  original: ViabilityResult
  changed: ViabilityResult
  changed_robustness?: Robustness | null
  alternatives: Alternative[]
  near_misses: NearMiss[]
  loosening: LooseningSuggestion[]
  stats: SearchStats
  data_source: string
  assumptions: string[]
}

// ---------------------------------------------------------------- sensitivity

export interface SensitivityRequest {
  scenario: Scenario
  date_offsets_hours?: number[]
  position_offsets_km?: number[]
  bearings?: number
  include_synthetic?: boolean | null // simulation mode, as in SearchOptions
}

// pass/fail = decided; unknown = evaluated but real data is incomplete; not_evaluated = skipped
export type SensitivityStatus = 'pass' | 'fail' | 'unknown' | 'not_evaluated'

/** Why a point has no pass/fail answer (backend `UndecidedReason`). Absent on older responses. */
export type UndecidedReason = 'incomplete_data' | 'outside_coverage' | 'no_real_data' | 'position_unsupported'

export interface SensitivityPoint {
  date_offset_hours: number
  distance_km: number
  bearing_deg: number | null
  lat: number
  lon: number
  passes: boolean // kept for compatibility: true only when status is 'pass'
  score: number | null
  failing_constraints: RequirementKey[]
  status: SensitivityStatus
  darkness_headroom_h?: number | null
  comms_headroom_h?: number | null
  closest_label?: string | null
  closest_headroom_text?: string | null
  headroom_status?: string | null
  reason?: UndecidedReason | null // set only for unknown and not_evaluated points
  undecided_constraints?: string[] // requirements the available data can't decide
}

export interface SensitivityCounts {
  requested: number
  evaluated: number // passed + failed + unknown
  skipped: number // not evaluated
  passed: number
  failed: number
  unknown: number
  by_reason?: Partial<Record<UndecidedReason, number>> // unknown + not_evaluated points by reason
}

export interface SensitivityResponse {
  base: ViabilityResult
  points: SensitivityPoint[] // every requested point, skipped ones included
  counts: SensitivityCounts | null
  date_pass_rate: number | null
  position_pass_rate: number | null // null = not checked (no real data around the site)
  safe_date_window_hours: [number, number] | null // run of tested offsets that pass; never bridges gaps
  safe_date_window_tested: number
  score_min: number | null
  score_max: number | null
  most_sensitive_constraint: RequirementKey | null
  skipped_points: number // legacy: unknown + not evaluated
  // unknown = no real data for the plan; not_assessed = no neighbouring point could be evaluated
  verdict: 'robust' | 'sensitive' | 'fragile' | 'fails' | 'unknown' | 'not_assessed'
  explanation: string
  date_limited_offsets_hours?: number[]
  tightest_passing_headroom?: string | null
  screening_note?: string
}

// ---------------------------------------------------------------- science vs engineering

export interface ScienceGoal {
  target?: Site | null
  target_psr_id?: string | null
  max_traverse_km?: number
  min_science_score?: number
}

export interface CompromiseRequest {
  scenario: Scenario
  science?: ScienceGoal
  engineering_weight?: number
  science_weight?: number
  search?: SearchOptions
}

export interface CompromiseOption {
  scenario: Scenario
  viability: ViabilityResult
  engineering_score: number // 0..1
  science_score: number // 0..1
  combined_score: number
  meets_engineering: boolean
  meets_science: boolean
  distance_to_science_km: number
  pareto_optimal: boolean
  explanation: string
}

export interface CompromiseResponse {
  status: 'both_met' | 'tradeoff_required'
  summary: string
  best: CompromiseOption | null
  best_for_engineering: CompromiseOption | null
  best_for_science: CompromiseOption | null
  pareto_front: CompromiseOption[]
  suggestions: string[]
  loosening: LooseningSuggestion[]
  stats: SearchStats
  data_source: string
  assumptions: string[]
}

// ---------------------------------------------------------------- GET /api/rescue/sites

export interface RescueCatalog {
  sites: (Site & {
    description: string
    source: string
    approximate: boolean
    has_real_data: boolean
    data_start_utc: string | null // the period the site's real data covers (null = no real data)
    data_end_utc: string | null
  })[]
  psrs: { id: string; name: string; lat: number; lon: number; radius_km: number; ice_interest: number }[]
  note: string
}
