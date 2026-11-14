// Multi-Scenario Comparison (Member 4).
// Request/response types mirror backend/app/compare/schemas.py (see docs/comparison.md).
// Shared types (Site, Scenario, MissionRequirements, ViabilityResult) live in src/types.ts.
import type { Eligibility, MissionRequirements, Scenario, Site, ViabilityResult } from '../../types'

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
  longest_dark_hours: number
  windows_count: number
}

export interface EarthStats {
  visible_hours: number
  visible_fraction: number
  longest_blackout_hours: number
  windows_count: number
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

export interface TimelineColumns {
  step_hours: number
  hour: number[]
  time_utc: string[]
  sun_elevation_deg: number[]
  sun_azimuth_deg: number[]
  sun_horizon_deg: number[]
  sun_visible_fraction: number[]
  earth_elevation_deg: number[]
  earth_azimuth_deg: number[]
  earth_horizon_deg: number[]
  earth_visible: boolean[]
  incidence_factor: number[]
}

/**
 * This scenario's place in the viability engine's canonical ranking (backend compare/ranking.py, which calls
 * app/viability/ranking.py). Only PASS entries have a rank, and only within their comparable group.
 * `score` is the exact score or null; null is never 0.
 */
export interface RankingInfo {
  eligibility: Eligibility
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
  site_context: SiteContext | null
  science_context: ScienceContext | null
  viability: ViabilityResult | null
  ranking: RankingInfo | null // null = no canonical assessment (e.g. no data)
  solar: SolarStats | null
  earth: EarthStats | null
  power: PowerStats | null
  sun_windows: Window[]
  dark_windows: Window[]
  earth_windows: Window[]
  blackout_windows: Window[]
  events: MissionEvent[]
  timeline: TimelineColumns | null
}

export interface CompareResponse {
  results: CompareResult[]
  ranking_groups: RankingGroup[]
  ranking_method: string | null
  viability_source: string
  notes: string[]
}

/** Client-side state of one scenario's result. */
export type ResultState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'done'; result: CompareResult }
