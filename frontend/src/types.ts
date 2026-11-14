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
