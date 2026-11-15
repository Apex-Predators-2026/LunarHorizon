// Headline conditions for the "At a glance" panel: engine metrics, the requirement each is checked against, and a
// meaningful-difference rule for the "best" mark. Pure functions; no React.
import { bestOf, bestPool, cm, measuredText, type Candidate, type Entry } from './analysis'

export interface Headline {
  key: string
  label: string
  better: 'higher' | 'lower'
  constraint: string
  scale: number // display multiplier (fraction -> %)
  unit: '%' | 'h'
}

/** The four conditions a mission planner reads first (engine metrics and the requirement each is checked against). */
export const HEADLINES: Headline[] = [
  { key: 'mean_solar_disk_fraction', label: 'Sunlight (mean visible solar disk)', better: 'higher', constraint: 'min_mean_solar_disk_fraction', scale: 100, unit: '%' },
  { key: 'longest_power_darkness_h', label: 'Longest continuous darkness', better: 'lower', constraint: 'max_continuous_darkness', scale: 1, unit: 'h' },
  { key: 'earth_visible_percent', label: 'Earth in line of sight', better: 'higher', constraint: 'min_earth_visibility_percent', scale: 1, unit: '%' },
  { key: 'longest_blackout_h', label: 'Longest communication blackout', better: 'lower', constraint: 'max_communication_blackout', scale: 1, unit: 'h' },
]

const meaningful = (h: Headline, a: number, b: number) =>
  Math.abs(a - b) >= (h.unit === '%' ? 1 : Math.max(2, 0.1 * Math.max(Math.abs(a), Math.abs(b))))

export interface HeadlineRow {
  entry: Entry
  value: number | null // exact display value, null when bounded / unavailable / not assessed
  text: string
  status: string | null // the requirement verdict this metric is checked against
  best: boolean // a proven, meaningful lead on this quantity within the comparable pool (bestPool)
  illustrative: boolean // the lead is among demonstration results only
}

/**
 * Per headline metric: each scenario's exact value (or why there is none) and which one is meaningfully best. The
 * pool is the shared bestPool: real results compete only with real ones (two or more), demonstration-only pools
 * are illustrative, and a missing value or a mix of durations / requirements gives no "best". Bounded values
 * compete with their bounds (a winner must beat every other candidate's most favourable value).
 */
export function headlineRows(h: Headline, entries: Entry[]): HeadlineRow[] {
  const pool = bestPool(entries)
  const rows = entries.map((e) => {
    const m = cm(e.result, h.key)
    const value = m && m.status === 'known' && m.value !== null ? m.value * h.scale : null
    const status = e.result?.assessment?.constraints.find((c) => c.id === h.constraint)?.status ?? null
    return { entry: e, value, text: m ? measuredText(m) : e.result ? 'unavailable' : 'not assessed', status, best: false, illustrative: false }
  })
  const cands: Candidate[] = pool.entries.map((e) => {
    const m = cm(e.result, h.key)
    if (m?.status === 'known' && m.value !== null) return { id: e.scenario.id, lo: m.value * h.scale, hi: m.value * h.scale }
    if (m?.status === 'bounded' && m.lower !== null && m.upper !== null) return { id: e.scenario.id, lo: m.lower * h.scale, hi: m.upper * h.scale }
    return { id: e.scenario.id, lo: null, hi: null }
  })
  const winners = bestOf(cands, h.better, (a, b) => meaningful(h, a, b))
  for (const r of rows) if (winners.has(r.entry.scenario.id)) Object.assign(r, { best: true, illustrative: pool.basis === 'illustrative' })
  return rows
}

/** Why no "best" can be marked, or what a "best" means here (null when nothing needs saying). */
export const headlineNote = (entries: Entry[]) => bestPool(entries).note
