// The comparison's displayed entries, built from the store in one place so the dashboard, the guided mission and the
// summary report read exactly the same results (no second copy of scientific state).
import { axisOffsets, type Align, type Entry } from './analysis'
import { resultKey, selectionKey, validateScenario } from './scenario'
import type { ComparisonScenario, PairEvidence, RankingGroup, ResultState } from './types'
import type { CompareState } from './useCompareStore'

export function selectedScenarios(scenarios: ComparisonScenario[], selectedIds: string[]): ComparisonScenario[] {
  return selectedIds.map((id) => scenarios.find((s) => s.id === id)).filter((s): s is ComparisonScenario => !!s)
}

/** The canonical ranking belongs to one selected set; it is only valid while that set is selected. */
export const rankingIsCurrent = (selected: ComparisonScenario[], allowDemo: boolean, rankingSetKey: string | null) =>
  rankingSetKey === selectionKey(selected.filter((s) => !validateScenario(s).length), allowDemo)

export function buildEntries(
  selected: ComparisonScenario[],
  results: Record<string, ResultState>,
  allowDemo: boolean,
  align: Align,
  rankingCurrent: boolean,
): Entry[] {
  // Results are cached by resultKey (the scenario's inputs), so an edited scenario never shows the old result.
  const items = selected.map((s) => ({ scenario: s, state: results[resultKey(s, allowDemo)] }))
  // The shared axis is laid out on the windows the backend evaluated (missionTime.ts).
  const offsets = axisOffsets(items, align)
  return items.map(({ scenario: s, state }) => {
    const result = state?.state === 'done' && state.result.status === 'ok' ? state.result : null
    // Unassessed scenarios (e.g. no data) still carry their UNKNOWN ranking entry.
    const raw = state?.state === 'done' ? state.result : null
    const ranking = rankingCurrent && raw ? raw.ranking : null
    return { scenario: s, state, result, offsetHours: offsets[s.id] ?? 0, ranking }
  })
}

export interface ComparisonView {
  selected: ComparisonScenario[]
  entries: Entry[]
  rankingCurrent: boolean
  groups: RankingGroup[]
  pairs: PairEvidence[]
  loading: boolean
  /** Every selected scenario has a settled result (done or error) and the ranking matches the selection. */
  settled: boolean
}

/** Snapshot of what the dashboard shows, read outside React (guided mission, report). */
export function comparisonView(s: Pick<CompareState, 'scenarios' | 'selectedIds' | 'results' | 'allowDemo' | 'align' | 'rankingSetKey' | 'rankingGroups' | 'rankingPairs'>): ComparisonView {
  const selected = selectedScenarios(s.scenarios, s.selectedIds)
  const rankingCurrent = rankingIsCurrent(selected, s.allowDemo, s.rankingSetKey)
  const entries = buildEntries(selected, s.results, s.allowDemo, s.align, rankingCurrent)
  const loading = entries.some((e) => !e.state || e.state.state === 'loading')
  return {
    selected, entries, rankingCurrent,
    groups: rankingCurrent ? s.rankingGroups : [],
    pairs: rankingCurrent ? s.rankingPairs : [],
    loading,
    settled: !loading && rankingCurrent,
  }
}
