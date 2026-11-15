// Comparison colours, taken from the shared design tokens (src/ui/tokens.ts).
// Scenario identity is never colour alone: every series also carries its letter and dash pattern.
import { color, series, seriesDash as dashes } from '../../ui/tokens'

export const SERIES_COLORS = series
export const SERIES_DASH = dashes
export const MAX_COMPARED = SERIES_COLORS.length

export const seriesColor = (slot: number) => SERIES_COLORS[((slot % 4) + 4) % 4]
export const seriesDash = (slot: number) => SERIES_DASH[((slot % 4) + 4) % 4]

// State colours for timelines and chart chrome (state, not identity). The comparison page uses the
// planner's light surfaces, so its chart chrome is light here; the data colours keep their meaning:
// Sun yellow, Earth blue, blackout red, and the timeline lanes stay a charcoal "night" so daylight reads.
export const STATE = {
  sun: color.sun,
  dark: '#2f3337',
  earth: color.earth,
  blackout: color.blackout,
  grid: '#e4e4e7',
  axis: '#5b6168',
  ink: '#3c4044',
  muted: '#6b7076',
  surface: '#ffffff',
  // Unknown (no data): a grey hatch, distinct from the night colour and from the red blackout hatch.
  unknown: '#8a9099',
  unknownBg: '#4a4f55',
} as const
