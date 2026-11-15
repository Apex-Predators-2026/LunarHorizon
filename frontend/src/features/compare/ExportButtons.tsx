// Export the comparison exactly as displayed (Phase 7). Enabled only once the canonical ranking for the current
// selection has loaded, so an export never mixes results from different selections.
import type { Entry } from './analysis'
import { rolesOf } from './decisionView'
import { buildExport, downloadText, toCsv } from './export'
import { selectionKeyOf } from './report'
import { resultKey } from './scenario'
import { useCompareStore } from './useCompareStore'
import type { PairEvidence, RankingGroup } from './types'
import { btn } from './ui'

export function ExportButtons({ entries, groups, pairs, notes, ready }: {
  entries: Entry[]
  groups: RankingGroup[]
  pairs: PairEvidence[]
  notes: string[]
  ready: boolean
}) {
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const make = () => {
    // The same additive context as the summary report: revisions, roles, data mode, preferences, mission time.
    const s = useCompareStore.getState()
    const roles = Object.fromEntries(Object.entries(rolesOf(s.rescueContext, entries)).map(([id, r]) => [id, r.label]))
    const base = entries.find((e) => e.scenario.id === s.baselineId)
    return buildExport(entries, groups, pairs, notes, new Date(), {
      selectionKey: selectionKeyOf(s), roles, allowDemo: s.allowDemo, timePolicy: s.timePolicy,
      preferences: { weights: { ...s.weights }, traverse_km: s.traverseKm },
      revisions: Object.fromEntries(entries.map((e) => [e.scenario.id, resultKey(e.scenario, s.allowDemo)])),
      baselineLabel: base?.scenario.label ?? null,
    })
  }
  const title = ready ? undefined : 'Available once every selected scenario has been assessed and ranked'
  return (
    <>
      <button type="button" className={btn} disabled={!ready || !entries.length} title={title}
        onClick={() => downloadText(`lunar-comparison-${stamp()}.json`, JSON.stringify(make(), null, 2) + '\n', 'application/json')}>
        Export JSON
      </button>
      <button type="button" className={btn} disabled={!ready || !entries.length} title={title}
        onClick={() => downloadText(`lunar-comparison-${stamp()}.csv`, toCsv(make()), 'text/csv')}>
        Export CSV
      </button>
    </>
  )
}
