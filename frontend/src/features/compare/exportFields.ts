// Canonical metric keys exported, in column order. Same keys as backend/app/compare/evidence.py METRIC_FIELDS.
export const METRIC_FIELDS_ORDER = [
  'sunlight_percent',
  'power_lit_percent',
  'mean_solar_disk_fraction',
  'longest_power_darkness_h',
  'longest_without_sun_h',
  'earth_visible_percent',
  'longest_blackout_h',
  'simultaneous_percent',
  'longest_simultaneous_h',
  'initial_sunlight_h',
  'time_to_first_sunset_h',
  'initial_earth_h',
  'time_to_first_earthset_h',
  'mean_sun_clearance_deg',
  'mean_earth_clearance_deg',
  'mean_solar_elevation_deg',
] as const
