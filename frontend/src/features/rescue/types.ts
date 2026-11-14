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
  include_synthetic?: boolean | null // null = only if the plan itself has no real data
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

export interface Robustness {
  checked_points: number
  passing_points: number
  pass_rate: number
  worst_score: number
  verdict: 'robust' | 'sensitive' | 'fragile'
  note: string
}

export interface Alternative {
  rank: number
  kind: AltKind
  is_catalog_site: boolean
  scenario: Scenario
  viability: ViabilityResult
  rank_score: number
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
  synthetic_candidates_excluded: number
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
  include_synthetic?: boolean | null
}

export interface SensitivityPoint {
  date_offset_hours: number
  distance_km: number
  bearing_deg: number | null
  lat: number
  lon: number
  passes: boolean
  score: number
  failing_constraints: RequirementKey[]
}

export interface SensitivityResponse {
  base: ViabilityResult
  points: SensitivityPoint[]
  date_pass_rate: number | null
  position_pass_rate: number | null // null = not checked (no real data around the site)
  safe_date_window_hours: [number, number] | null
  score_min: number
  score_max: number
  most_sensitive_constraint: RequirementKey | null
  skipped_points: number
  verdict: 'robust' | 'sensitive' | 'fragile' | 'fails'
  explanation: string
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
  sites: (Site & { description: string; source: string; approximate: boolean; has_real_data: boolean })[]
  psrs: { id: string; name: string; lat: number; lon: number; radius_km: number; ice_interest: number }[]
  note: string
}
