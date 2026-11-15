// Headline conditions for the "At a glance" panel: engine metrics, the requirement each is checked against, and a
// meaningful-difference rule for the "best" mark. Pure functions; no React.
import { cm, measuredText, type Entry } from './analysis'

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
  best: boolean
}

/** Per headline metric: each scenario's exact value (or why there is none) and which one is meaningfully best. */
export function headlineRows(h: Headline, entries: Entry[]): HeadlineRow[] {
  const rows = entries.map((e) => {
    const m = cm(e.result, h.key)
    const value = m && m.status === 'known' && m.value !== null ? m.value * h.scale : null
    const status = e.result?.assessment?.constraints.find((c) => c.id === h.constraint)?.status ?? null
    return { entry: e, value, text: m ? measuredText(m) : e.result ? 'unavailable' : 'not assessed', status, best: false }
  })
  const real = rows.filter((r) => r.value !== null && r.entry.result?.data_kind === 'real')
  const pool = real.length >= 2 ? real : rows.filter((r) => r.value !== null)
  if (pool.length >= 2) {
    const sorted = [...pool].sort((a, b) => (h.better === 'higher' ? b.value! - a.value! : a.value! - b.value!))
    const top = sorted.filter((r) => r.value === sorted[0].value)
    const next = sorted.find((r) => r.value !== sorted[0].value)
    if (next && meaningful(h, sorted[0].value!, next.value!)) top.forEach((r) => (r.best = true))
  }
  return rows
}

