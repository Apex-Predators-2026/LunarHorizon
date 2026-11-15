// Multi-Scenario Comparison (Member 4).
// Request/response types mirror backend/app/compare/schemas.py (see docs/comparison.md).
// Shared types (Site, Scenario, MissionRequirements, ViabilityResult) live in src/types.ts.
import type {
  CanonicalMarginItem,
  Eligibility,
  MissionRequirements,
  OperationalHeadroom,
  Scenario,
  Site,
  ViabilityResult,
} from '../../types'

// ---------------------------------------------------------------- scenario objects

export type PanelMode = 'vertical_sun_tracking' | 'vertical_fixed' | 'horizontal' | 'two_axis'

export interface SpacecraftConfig {
  panel_mode: PanelMode
  panel_azimuth_deg: number
  panel_rated_power_w: number | null
  average_load_w: number | null
  battery_capacity_wh: number | null
}

export type ScenarioOrigin = 'user' | 'duplicate' | 'preset' | 'rescue' | 'external'

/** One saved scenario in the comparison workspace. `toTeamScenario` turns it into the team's Scenario. */
export interface ComparisonScenario {
  id: string
  label: string // single letter A, B, C... shown everywhere next to the colour
  name: string
  site: Site
  landing_utc: string
  duration_days: number
  requirements: MissionRequirements
  spacecraft: SpacecraftConfig
  origin: ScenarioOrigin
  notes?: string
  colorSlot: number // fixed colour slot; follows the scenario, never its rank
}

// ---------------------------------------------------------------- API

export interface CompareScenarioIn {
  key: string
  scenario: Scenario
  spacecraft: SpacecraftConfig
}

export interface CompareRequest {
  scenarios: CompareScenarioIn[]
  allow_demo_data?: boolean
  max_points?: number
}

export type DataKind = 'real' | 'demonstration' | 'unavailable'

export interface Window {
  start_hour: number
  end_hour: number
  duration_hours: number
  start_utc: string
  end_utc: string
  open_start: boolean
  open_end: boolean
  kind?: string | null // canonical window kind (darkness, sun_unknown, earth_unknown, ...)
}

export interface MissionEvent {
  type: 'sunrise' | 'sunset' | 'earthrise' | 'earthset'
  hour: number
  time_utc: string
}

export interface SolarStats {
  sunlit_hours: number
  sunlit_fraction: number
  mean_visible_fraction: number
  equivalent_full_sun_hours: number
  mean_elevation_deg: number
  mean_elevation_lit_deg: number | null
  max_elevation_deg: number
  min_elevation_lit_deg: number | null
  mean_clearance_lit_deg: number | null
  longest_dark_hours: number | null
  windows_count: number | null
}

export interface EarthStats {
  visible_hours: number
  visible_fraction: number
  longest_blackout_hours: number | null
  windows_count: number | null
  mean_elevation_visible_deg: number | null
  min_elevation_visible_deg: number | null
  mean_margin_visible_deg: number | null
  min_margin_visible_deg: number | null
}

export interface PowerStats {
  panel_mode: PanelMode
  mean_incidence_factor: number
  max_incidence_factor: number
  equivalent_full_power_hours: number
  idealized_mean_power_w: number | null
  idealized_energy_wh: number | null
  load_energy_wh: number | null
  idealized_energy_to_load_ratio: number | null
  battery_endurance_hours: number | null
  model: string
}

export interface SiteContext {
  ground_height_m: number | null
  observer_height_m: number | null
  horizon_min_deg: number | null
  horizon_max_deg: number | null
  coordinate_source: string
}

export interface ScienceContext {
  nearest_psr_id: string
  nearest_psr_name: string
  distance_to_psr_edge_km: number
  ice_interest: number
  source: string
}

/** Decimated mission timeline. `null` = unknown at that sample (terrain or ephemeris gap), never a measurement. */
export interface TimelineColumns {
  step_hours: number
  hour: number[]
  time_utc: string[]
  sun_elevation_deg: (number | null)[]
  sun_azimuth_deg: (number | null)[]
  sun_horizon_deg: (number | null)[]
  sun_visible_fraction: (number | null)[]
  earth_elevation_deg: (number | null)[]
  earth_azimuth_deg: (number | null)[]
  earth_horizon_deg: (number | null)[]
  earth_visible: (boolean | null)[]
  incidence_factor: (number | null)[]
}

/** A metric exactly as the viability engine reports it (display units: h, %, fraction, deg). */
export interface CanonicalMetric {
  status: 'known' | 'bounded' | 'unavailable' | 'not_applicable'
  unit: string
  value: number | null // known only
  lower: number | null // bounded only
  upper: number | null
  reason: string | null
}

export interface ConstraintItem {
  id: string
  name: string | null
  status: 'pass' | 'fail' | 'unknown' | 'not_applicable'
  comparison: 'at_least' | 'at_most' | null
  threshold: number | null
  measured: CanonicalMetric
  message: string
  requirement_field: string | null
  unknown_reason: string | null
  evidence_windows: EvidenceWindow[] // windows the engine cites for this verdict (e.g. the longest darkness)
}

export interface EvidenceWindow {
  kind: string // power_dark, communication_blackout, earth_visible, ...
  start_hour: number // hours after mission start
  end_hour: number
  duration_hours: number
  start_utc: string
  end_utc: string
  clipped_at_start: boolean
  clipped_at_end: boolean
}

/** Canonical evidence beyond pass/fail and score: metric states, constraints, risk, coverage, versions. */
export interface AssessmentInfo {
  engine_version: string
  scoring_method_version: string
  dataset_id: string
  data_basis: string
  is_synthetic: boolean
  overall_risk: string
  risks: { code: string; level: string; message: string }[]
  sun_coverage_percent: number
  earth_coverage_percent: number
  uncovered_hours: number
  metrics: Record<string, CanonicalMetric>
  constraints: ConstraintItem[]
  margins?: CanonicalMarginItem[]
  headroom?: OperationalHeadroom | null
  explanations: string[]
  limitations: string[]
}

/**
 * This scenario's place in the viability engine's canonical ranking (backend compare/ranking.py, which calls
 * app/viability/ranking.py). Only PASS entries have a rank, and only within their comparable group.
 * `score` is the exact score or null; null is never 0.
 */
export interface RankingInfo {
  eligibility: Eligibility
  assessed: boolean // false = never assessed by the engine (e.g. no data); eligibility is then UNKNOWN
  rank: number | null
  group: string | null
  group_size: number
  ranked_in_group: number
  explanation: string // the engine's own reason for this rank or absence of rank
  score_status: 'known' | 'bounded' | 'eligibility_unknown' | 'no_scorable_components' | null
  score: number | null
  score_lower: number | null
  score_upper: number | null
  overall_risk: string
  data_basis: string
}

/** The viability engine's evidence for the order of two scenarios (ranking_evidence.compare_scenarios). */
export interface PairEvidence {
  selected: string
  competitor: string
  selected_id: string // engine scenario ids as they appear in the texts
  competitor_id: string
  comparable: boolean
  comparability_issues: string[]
  higher: string | null
  deciding_criterion: string | null
  deciding_detail: string
  policy_tie_break: boolean // order decided by a policy tie-break, not a measured difference
  score_difference: {
    status: 'selected_higher' | 'competitor_higher' | 'not_established' | 'unavailable' | 'not_comparable'
    lower: number | null
    upper: number | null
    both_exact: boolean
    statement: string
  }
  components: { component: string; label: string; advantage: 'selected' | 'competitor' | 'equal' | 'not_established' | 'inactive' | 'unavailable' }[]
  limitations: string[]
  explanation: string
}

/** Scenarios that may share one ranking, in canonical order (PASS ranked, then UNKNOWN, then FAIL). */
export interface RankingGroup {
  id: string
  primary: boolean
  keys: string[]
  ranked_keys: string[]
  data_basis: string | null
  policy: string
  method_version: string
  separate_reason: string | null // why it cannot share the primary group's ranking
}

export interface CompareResult {
  key: string
  status: 'ok' | 'unavailable'
  message: string | null
  data_kind: DataKind
  data_source: string
  /** What was actually evaluated: the hourly data grid (backend app/timegrid.py). */
  evaluated_landing_utc?: string | null
  evaluated_duration_days?: number | null
  /** Plain note when the evaluated landing time or length differs from the request. */
  time_note?: string | null
  site_context: SiteContext | null
  science_context: ScienceContext | null
  viability: ViabilityResult | null
  ranking: RankingInfo | null // UNKNOWN with assessed=false when the engine never assessed it (e.g. no data)
  assessment: AssessmentInfo | null
  solar: SolarStats | null
  earth: EarthStats | null
  power: PowerStats | null
  sun_windows: Window[]
  dark_windows: Window[]
  earth_windows: Window[]
  blackout_windows: Window[]
  /** The engine's sun_unknown / earth_unknown windows: no data there, never darkness or a blackout. */
  unknown_windows?: Window[]
  events: MissionEvent[]
  timeline: TimelineColumns | null
  /** Mission hours with a known Sun / Earth state (null when not assessed). */
  sun_known_hours?: number | null
  earth_known_hours?: number | null
  /** solar / earth / power -> why that block of statistics is withheld (it is never shown as 0). */
  withheld?: Record<string, string>
}

export interface CompareResponse {
  results: CompareResult[]
  ranking_groups: RankingGroup[]
  ranking_method: string | null
  pairwise: PairEvidence[]
  viability_source: string
  notes: string[]
}

/** Client-side state of one scenario's result. */
export type ResultState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'done'; result: CompareResult }
