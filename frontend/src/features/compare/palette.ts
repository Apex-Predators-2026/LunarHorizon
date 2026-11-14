// Comparison colours, taken from the shared design tokens (src/ui/tokens.ts).
// Scenario identity is never colour alone: every series also carries its letter and dash pattern.
import { chart, color, series, seriesDash as dashes } from '../../ui/tokens'

export const SERIES_COLORS = series
export const SERIES_DASH = dashes
export const MAX_COMPARED = SERIES_COLORS.length

export const seriesColor = (slot: number) => SERIES_COLORS[((slot % 4) + 4) % 4]
export const seriesDash = (slot: number) => SERIES_DASH[((slot % 4) + 4) % 4]

// State colours for timelines and chart chrome (state, not identity).
export const STATE = {
  sun: color.sun,
  dark: color.night,
  earth: color.earth,
  blackout: color.blackout,
  grid: chart.grid,
  axis: chart.axis,
  ink: color.ink,
  muted: color.ink3,
  surface: color.surface,
} as const
