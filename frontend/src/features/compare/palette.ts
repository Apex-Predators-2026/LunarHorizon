// Comparison colours, taken from the shared design tokens (src/ui/tokens.ts).
// Scenario identity is never colour alone: every series also carries its letter and dash pattern.
import { color, series, seriesDash as dashes } from '../../ui/tokens'

export const SERIES_COLORS = series
export const SERIES_DASH = dashes
export const MAX_COMPARED = SERIES_COLORS.length

export const seriesColor = (slot: number) => SERIES_COLORS[((slot % 4) + 4) % 4]
export const seriesDash = (slot: number) => SERIES_DASH[((slot % 4) + 4) % 4]

// State colours for timelines and chart chrome (state, not identity). Chart chrome follows the surface theme; data colours keep their meaning:
// Sun yellow, Earth blue, blackout red, and the timeline lanes stay a charcoal "night" so daylight reads.
export const STATE = {
  sun: color.sun,
  dark: '#2f3337',
  earth: color.earth,
  blackout: color.blackout,
  grid: 'var(--cmp-chart-grid)',
  axis: 'var(--color-ink-3)',
  ink: 'var(--color-ink-2)',
  muted: 'var(--color-ink-4)',
  surface: 'var(--color-surface)',
  // Unknown (no data): a grey hatch, distinct from the night colour and from the red blackout hatch.
  unknown: '#8a9099',
  unknownBg: '#4a4f55',
} as const
