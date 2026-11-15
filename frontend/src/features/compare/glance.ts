// Headline conditions for the "At a glance" panel: engine metrics, the requirement each is checked against, and the
// shared comparison-pool rules (pool.ts) for the "best" mark. Pure functions; no React.
import { cm, measuredText, type Entry } from './analysis'
import { comparisonPool, contenderOf, pickBest, type BestOutcome } from './pool'

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

export interface HeadlineRow {
  entry: Entry
  value: number | null // exact display value, null when bounded / unavailable / not assessed
  text: string
  status: string | null // the requirement verdict this metric is checked against
  best: boolean
}

/** One headline's fair "best" outcome (pool.ts rules: one data kind, every member counts, bounds can block). */
export function headlineBest(h: Headline, entries: Entry[]): BestOutcome {
  return pickBest(comparisonPool(entries), (e) => contenderOf(cm(e.result, h.key), h.scale), h.better, h.unit)
}

/** Per headline metric: each scenario's exact value (or why there is none) and which one is fairly best. */
export function headlineRows(h: Headline, entries: Entry[]): HeadlineRow[] {
  const best = headlineBest(h, entries).ids
  return entries.map((e) => {
    const m = cm(e.result, h.key)
    const value = m && m.status === 'known' && m.value !== null ? m.value * h.scale : null
    const status = e.result?.assessment?.constraints.find((c) => c.id === h.constraint)?.status ?? null
    return { entry: e, value, text: m ? measuredText(m) : e.result ? 'unavailable' : 'not assessed', status, best: best.has(e.scenario.id) }
  })
}

