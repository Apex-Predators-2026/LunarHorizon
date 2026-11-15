// The comparison page's sections, in reading order. Shared by the section bar and the Mission Assistant (which
// may only point users at sections that exist).
export const COMPARE_SECTIONS = [
  ['cmp-scenarios', 'Scenarios'], ['cmp-overview', 'At a glance'], ['cmp-metrics', 'Key metrics'], ['cmp-summary', 'Decision'],
  ['cmp-timeline', 'Timeline'], ['cmp-performance', 'Ranking'], ['cmp-charts', 'Elevation'], ['cmp-terrain', 'Terrain'],
  ['cmp-tradeoff', 'Trade-off'],
] as const

export type CompareSectionId = (typeof COMPARE_SECTIONS)[number][0]
