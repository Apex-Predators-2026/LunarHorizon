// Mirrors docs/interfaces.md and backend/app/models.py. Keep all three in sync.

export interface Site {
  id: string
  name: string
  lat: number // degrees, negative = south
  lon: number // degrees east
}

export interface BodyState {
  azimuth_deg: number
  elevation_deg: number
  horizon_deg: number // terrain horizon elevation at this azimuth
}

export interface SunState extends BodyState {
  visible_fraction: number // portion of the solar disk above terrain, 0..1
}

export interface EarthState extends BodyState {
  visible: boolean
  margin_deg: number // elevation_deg - horizon_deg
}

export interface TimelineStep {
  time_utc: string
  sun: SunState
  earth: EarthState
}

// ---------------------------------------------------------------------------
// Mission scenario + viability result. Proposed by Member 5 (rescue) as the contract
// between viability, rescue, comparison and the UI. Mirrors the same section of
// backend/app/models.py. Rescue-only types: src/features/rescue/types.ts.
// ---------------------------------------------------------------------------

export interface MissionRequirements {
  min_sunlight_fraction: number // 0..1, mean visible solar disk over the mission
  battery_hours: number // longest survivable period with panels dark
  panel_threshold: number // 0..1, visible solar disk below which panels count as dark
  min_earth_visibility_fraction: number // 0..1
  max_comms_gap_hours: number // longest allowed direct-to-Earth blackout
  min_initial_sun_hours: number // continuous sunlight right after landing
  min_initial_comms_hours: number // continuous Earth contact right after landing
}

export type RequirementKey = keyof MissionRequirements

export const DEFAULT_REQUIREMENTS: MissionRequirements = {
  min_sunlight_fraction: 0.5,
  battery_hours: 50,
  panel_threshold: 0.25,
  min_earth_visibility_fraction: 0.4,
  max_comms_gap_hours: 96,
  min_initial_sun_hours: 24,
  min_initial_comms_hours: 12,
}

export interface Scenario {
  site: Site
  landing_utc: string // ISO 8601, UTC
  duration_days: number
  requirements: MissionRequirements
}

export interface Violation {
  constraint: RequirementKey
  required: number
  actual: number
  unit: 'fraction' | 'h'
  shortfall: number // >= 0, in `unit`
  relative_shortfall: number // shortfall / required
  message: string
}

export interface ViabilityMetrics {
  sunlight_fraction: number
  equivalent_sun_hours: number
  longest_dark_gap_hours: number
  earth_visibility_fraction: number
  longest_comms_gap_hours: number
  initial_sun_hours: number
  initial_comms_hours: number
  hours_to_first_sunset: number | null // null = never sets during the mission
  hours_to_first_earthset: number | null
  mean_sun_clearance_deg: number | null
  mean_earth_clearance_deg: number | null
  mean_solar_elevation_deg: number
}

export interface ViabilityResult {
  scenario: Scenario
  passes: boolean
  score: number // 0..100
  metrics: ViabilityMetrics
  violations: Violation[]
  source: string // which viability implementation
  data_source: string // which timeline source (e.g. "synthetic-placeholder")
}
