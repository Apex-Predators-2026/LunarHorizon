// Raw token values for code that cannot use CSS classes (SVG attributes, Recharts props, three.js).
// Same numbers as the @theme block in src/index.css - change both together.
export const color = {
  canvas: '#070b14',
  surface: '#0c1220',
  raised: '#121b2d',
  inset: '#060a12',
  line: '#1d2940',
  lineStrong: '#2b3a57',
  ink: '#e6eaf2',
  ink2: '#b4bdd0',
  ink3: '#8691a9',
  ink4: '#5b6680',
  accent: '#22b8cf',
  accentStrong: '#5ad1e3',
  ok: '#3fb950',
  warn: '#d9a21b',
  crit: '#f0605a',
  unknown: '#8691a9',
  sun: '#e8b84a',
  earth: '#5aa9f0',
  night: '#111a2e',
  blackout: '#d03b3b',
} as const

/**
 * Categorical identity colours (scenario A-D). Dark steps of the dataviz reference palette; they pass
 * lightness, chroma and contrast checks on the surface. Four overlapping series cannot all clear the
 * colour-blind separation target, so identity is never colour alone: pair each with a letter and dash.
 */
export const series = ['#3987e5', '#d95926', '#199e70', '#c98500'] as const
export const seriesDash = ['', '7 4', '2 3', '10 3 2 3'] as const

/** Chart chrome: gridlines recede, axis text stays readable. */
export const chart = {
  grid: '#1a2539',
  axis: color.ink3,
  axisLine: color.line,
  cursor: color.ink,
  fontSize: 11,
} as const

export const font = {
  mono: 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const
