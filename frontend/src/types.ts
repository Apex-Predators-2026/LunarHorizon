// Mirrors docs/interfaces.md and backend/app/models.py. Keep all three in sync.

// A location. Shared by every feature (e.g. inside a rescue Scenario), so keep it minimal.
export interface Site {
  id: string
  name: string
  lat: number // degrees, negative = south
  lon: number // degrees east
}

// ---------------------------------------------------------------------------
// Data engine (Andrew): site info, horizon, timelines, terrain.
// ---------------------------------------------------------------------------

export interface SiteSummaryStats {
  sunlit_pct: number
  mean_sun_fraction_pct: number
  earth_visible_pct: number
  horizon_min_deg: number
  horizon_max_deg: number
}

// A Site plus what the data engine knows about it (returned by /api/sites).
export interface SiteInfo extends Site {
  source: string
  ground_height_m: number // relative to the 1737.4 km reference sphere
  observer_height_m: number
  summary: SiteSummaryStats
  data_start_utc: string
  data_stop_utc: string
}

export interface Horizon {
  azimuth_deg: number[] // clockwise from north, every 0.5 deg
  elevation_deg: number[] // terrain horizon elevation per azimuth
  distance_m: number[] // how far away the blocking terrain is
  ground_height_m: number
  observer_height_m: number
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

export interface SiteStatus extends TimelineStep {
  next_sunset_utc: string | null
  next_sunrise_utc: string | null
  next_earthset_utc: string | null
  next_earthrise_utc: string | null
}

// Rows run north -> south, columns west -> east, centred on the site.
// For 3D: x = east, z = -north, y = height.
export interface TerrainGrid {
  size: number
  half_width_m: number
  spacing_m: number
  site_height_m: number
  min_height_m: number
  max_height_m: number
  heights_m: number[] // row-major, size * size
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
  is_unknown: boolean // true = undecided because data is missing, not a real failure
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

export type Eligibility = 'pass' | 'fail' | 'unknown'

export interface ViabilityResult {
  scenario: Scenario
  passes: boolean // true only when eligibility is 'pass'
  eligibility: Eligibility | null // null = evaluator didn't say; then use `passes`
  score: number | null // 0..100, null = not scored
  metrics: ViabilityMetrics
  violations: Violation[]
  source: string // which viability implementation
  data_source: string // which timeline source (e.g. "synthetic-placeholder")
}

/** pass / fail / unknown, falling back to `passes` when the evaluator gave no eligibility. */
export const verdictOf = (v: Pick<ViabilityResult, 'passes' | 'eligibility'>): Eligibility =>
  v.eligibility ?? (v.passes ? 'pass' : 'fail')
