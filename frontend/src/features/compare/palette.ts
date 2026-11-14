// Scenario identity colours for the dark mission UI.
// Slots 1-4 of the dataviz reference palette's dark steps (blue, orange, aqua, yellow), which pass the
// lightness, chroma and contrast checks on the navy surface. Four overlapping series cannot all clear
// the all-pairs colour-blind separation, so identity is never colour-alone: every series also carries
// its scenario letter and its own dash pattern.
export const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'] as const
export const SERIES_DASH = ['', '7 4', '2 3', '10 3 2 3'] as const
export const MAX_COMPARED = SERIES_COLORS.length

export const seriesColor = (slot: number) => SERIES_COLORS[((slot % 4) + 4) % 4]
export const seriesDash = (slot: number) => SERIES_DASH[((slot % 4) + 4) % 4]

// State colours for the timelines (state, not identity).
export const STATE = {
  sun: '#e8b84a',
  dark: '#111a2e',
  earth: '#5aa9f0',
  blackout: '#d03b3b',
  grid: '#22304d',
  axis: '#7d8bab',
  ink: '#e6e8ee',
  muted: '#93a0bd',
  surface: '#0d1628',
} as const

// Reserved status colours (always shown with an icon + label).
export const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' } as const
