// The comparison page's sections, in reading order. Shared by the section links, the Mission Assistant (which
// may only point users at sections that exist) and the tour. Each section lives in one of three views.
import { create } from 'zustand'

export const COMPARE_SECTIONS = [
  ['cmp-scenarios', 'Scenarios'], ['cmp-overview', 'At a glance'], ['cmp-metrics', 'Key metrics'], ['cmp-summary', 'Decision'],
  ['cmp-timeline', 'Timeline'], ['cmp-performance', 'Ranking'], ['cmp-charts', 'Elevation'], ['cmp-terrain', 'Terrain'],
  ['cmp-tradeoff', 'Trade-off'], ['cmp-assessment', 'Assessment'], ['cmp-assumptions', 'Assumptions'],
  ['cmp-science', 'Science vs engineering'], ['cmp-rescue', 'Mission Rescue'],
] as const

export type CompareSectionId = (typeof COMPARE_SECTIONS)[number][0]

export type CompareTab = 'overview' | 'evidence' | 'detail'

export const COMPARE_TABS: readonly { id: CompareTab; label: string; hint: string }[] = [
  { id: 'overview', label: 'Overview', hint: 'The decision, the decisive evidence and what to do next' },
  { id: 'evidence', label: 'Evidence', hint: 'Metrics and requirements, the sunlight and Earth-contact timeline, ranking and outages' },
  { id: 'detail', label: 'Detailed analysis', hint: 'Elevation charts, terrain horizon and the trade-off radar' },
]

/** Which view holds a section. The scenario strip sits above the views, so it has none. */
export const SECTION_TAB: Record<CompareSectionId, CompareTab | null> = {
  'cmp-scenarios': null,
  'cmp-overview': 'overview', 'cmp-summary': 'overview', 'cmp-rescue': 'overview',
  'cmp-metrics': 'evidence', 'cmp-timeline': 'evidence', 'cmp-performance': 'evidence',
  'cmp-assessment': 'evidence',
  'cmp-charts': 'detail', 'cmp-terrain': 'detail', 'cmp-tradeoff': 'detail', 'cmp-assumptions': 'detail', 'cmp-science': 'detail',
}

/** The section a view's URL remembers (the Overview is the page itself, so it remembers none). */
export const TAB_ENTRY: Record<CompareTab, CompareSectionId | null> = { overview: null, evidence: 'cmp-metrics', detail: 'cmp-charts' }

export const tabOfSection = (id: string | null | undefined): CompareTab | null =>
  id && id in SECTION_TAB ? SECTION_TAB[id as CompareSectionId] : null

/** The active view, shared by the dashboard, the tour and deep links. */
export const useCompareView = create<{ tab: CompareTab; setTab: (t: CompareTab) => void }>((set) => ({
  tab: 'overview',
  setTab: (tab) => set({ tab }),
}))
