// Export the comparison exactly as displayed (Phase 7). Enabled only once the canonical ranking for the current
// selection has loaded, so an export never mixes results from different selections.
import type { Entry } from './analysis'
import { buildExport, downloadText, toCsv } from './export'
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
  const make = () => buildExport(entries, groups, pairs, notes)
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
