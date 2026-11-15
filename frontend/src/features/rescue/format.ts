import type { UndecidedReason } from './types'
import type { MissionRequirements, Scenario, ViabilityMetrics } from '../../types'
import type { AltKind, MetricDelta } from './types'

export const fmtValue = (v: number | null, unit: string): string => {
  if (v === null || Number.isNaN(v)) return 'n/a'
  if (unit === 'fraction') return `${Math.round(v * 100)}%`
  if (unit === 'points') return v.toFixed(0)
  return `${Math.round(v)} h`
}

export const fmtDelta = (m: Pick<MetricDelta, 'delta' | 'unit'>): string => {
  if (m.delta === null || Math.abs(m.delta) < 1e-9) return 'no change'
  const sign = m.delta > 0 ? '+' : '−'
  const abs = Math.abs(m.delta)
  if (m.unit === 'fraction') return `${sign}${Math.round(abs * 100)} pts`
  if (m.unit === 'points') return `${sign}${abs.toFixed(0)}`
  return `${sign}${Math.round(abs)} h`
}

export const fmtUtc = (iso: string): string =>
  new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

export const fmtShift = (hours: number): string => {
  if (Math.abs(hours) < 0.5) return 'same time'
  const when = hours > 0 ? 'later' : 'earlier'
  return Math.abs(hours) >= 24
    ? `${(Math.abs(hours) / 24).toFixed(1)} days ${when}`
    : `${Math.round(Math.abs(hours))} h ${when}`
}

/** "2027-01-07T00:00:00Z" -> "2027-01-07T00:00" for <input type="datetime-local"> (treated as UTC). */
export const toUtcInput = (iso: string): string => new Date(iso).toISOString().slice(0, 16)

/** Inverse of toUtcInput. */
export const fromUtcInput = (v: string): string => new Date(`${v}:00Z`).toISOString()

export const KIND_LABEL: Record<AltKind, string> = {
  unchanged: 'Same plan',
  date_shift: 'New date',
  site_change: 'New site',
  site_and_date: 'New site + date',
}

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(v) ?? 'null'

/**
 * Name of the saved plan the rescue scenario was captured from, and whether that plan was edited since.
 * An unknown source (no plan id, or the plan was deleted) gives no name and never a changed notice.
 */
export function planInfo(
  original: Scenario | null,
  planId: string | null,
  plans: { id: string; name: string; scenario: Scenario }[],
): { name: string | null; changed: boolean } {
  const plan = original && planId ? plans.find((p) => p.id === planId) : undefined
  if (!original || !plan) return { name: null, changed: false }
  return { name: plan.name, changed: plan.scenario !== original && canonical(plan.scenario) !== canonical(original) }
}

// ---- Operational headroom (how far a passing plan is from each requirement) ----

export interface HeadroomItem {
  key: string
  label: string
  /** Headroom in the requirement's own unit: hours, or percentage points for fractions. */
  amount: number
  unit: 'h' | 'pts'
  limitText: string
  /** Headroom as a share of the requirement (0 = exactly at the limit). */
  relative: number
  limited: boolean
}

type Req = MissionRequirements
type Met = ViabilityMetrics

/** Headroom is "limited" below 10% of the requirement, or below 6 h for hour limits. */
export const LIMITED_SHARE = 0.1
export const LIMITED_HOURS = 6

/**
 * Margins between a result's metrics and its requirements, from the values the engine already returns.
 * Only binding requirements are included (a minimum of 0 is not a constraint). These are model screening
 * margins, not guarantees.
 */
export function headroom(m: Met, r: Req): HeadroomItem[] {
  const out: HeadroomItem[] = []
  const hoursMax = (key: string, label: string, actual: number, limit: number) => {
    if (!(limit > 0) || !Number.isFinite(actual)) return
    const amount = limit - actual
    out.push({ key, label, amount, unit: 'h', limitText: `limit ${limit.toFixed(0)} h`, relative: amount / limit,
      limited: amount < LIMITED_HOURS || amount / limit < LIMITED_SHARE })
  }
  const hoursMin = (key: string, label: string, actual: number, need: number) => {
    if (!(need > 0) || !Number.isFinite(actual)) return
    const amount = actual - need
    out.push({ key, label, amount, unit: 'h', limitText: `needs ${need.toFixed(0)} h`, relative: amount / need,
      limited: amount < LIMITED_HOURS || amount / need < LIMITED_SHARE })
  }
  const fracMin = (key: string, label: string, actual: number, need: number) => {
    if (!(need > 0) || !Number.isFinite(actual)) return
    const amount = (actual - need) * 100
    out.push({ key, label, amount, unit: 'pts', limitText: `needs ${Math.round(need * 100)}%`,
      relative: (actual - need) / need, limited: (actual - need) / need < LIMITED_SHARE })
  }
  hoursMax('battery_hours', 'darkness', m.longest_dark_gap_hours, r.battery_hours)
  hoursMax('max_comms_gap_hours', 'comms blackout', m.longest_comms_gap_hours, r.max_comms_gap_hours)
  fracMin('min_sunlight_fraction', 'sunlight', m.sunlight_fraction, r.min_sunlight_fraction)
  fracMin('min_earth_visibility_fraction', 'Earth visibility', m.earth_visibility_fraction, r.min_earth_visibility_fraction)
  hoursMin('min_initial_sun_hours', 'sunlight after landing', m.initial_sun_hours, r.min_initial_sun_hours)
  hoursMin('min_initial_comms_hours', 'Earth contact after landing', m.initial_comms_hours, r.min_initial_comms_hours)
  return out
}

const amountText = (h: HeadroomItem) => `${Math.max(0, Math.round(h.amount))} ${h.unit === 'h' ? 'h' : 'pts'}`

/** One-line summary for a passing plan, e.g. "Passes with 35 h darkness and 48 h comms-blackout headroom". */
export function headroomSummary(items: HeadroomItem[]): { headline: string; closest: string | null } {
  const dark = items.find((h) => h.key === 'battery_hours')
  const comms = items.find((h) => h.key === 'max_comms_gap_hours')
  const parts = [dark, comms].filter((h): h is HeadroomItem => !!h)
  const limited = parts.filter((h) => h.limited)
  let headline: string
  if (!parts.length) headline = 'Passes (no darkness or blackout limit set)'
  else if (limited.length)
    headline = `Passes with limited ${limited.map((h) => `${h.label} headroom (${amountText(h)}, ${h.limitText})`).join(' and ')}`
  else headline = `Passes with ${parts.map((h) => `${amountText(h)} ${h.label}`).join(' and ')} headroom`
  const closest = items.length ? items.reduce((a, b) => (b.relative < a.relative ? b : a)) : null
  return {
    headline,
    closest: closest ? `Closest to its limit: ${closest.label}, ${amountText(closest)} to spare (${closest.limitText})` : null,
  }
}

/**
 * Rescue evaluates on the hourly data grid, so a landing time like 00:15 is evaluated at 00:00. Returns a
 * note when the evaluated time differs from the one the user entered, otherwise null.
 */
export function evaluatedTimeNote(requestedIso: string | null | undefined, evaluatedIso: string): string | null {
  if (!requestedIso) return null
  const a = Date.parse(requestedIso)
  const b = Date.parse(evaluatedIso)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null
  return `Evaluated at ${fmtUtc(evaluatedIso)} (rescue uses the hourly data grid; you entered ${fmtUtc(requestedIso)}).`
}

/** Why a point has no answer, in words. Unknown is never a failure; not evaluated was never run. */
export const REASON_LABEL: Record<UndecidedReason, string> = {
  incomplete_data: 'unknown: real data has missing samples here',
  outside_coverage: 'unknown: outside the dates the real data covers',
  no_real_data: 'unknown: no real data for this site',
  position_unsupported: 'not evaluated: no real terrain data around the site',
}

/** "2 missing samples, 1 outside the data" style breakdown of the undecided points; '' when there is none. */
export function reasonBreakdown(by: Partial<Record<UndecidedReason, number>> | undefined): string {
  if (!by) return ''
  const words: [UndecidedReason, string][] = [
    ['incomplete_data', 'missing samples'],
    ['outside_coverage', 'outside the data range'],
    ['no_real_data', 'no real data for the site'],
    ['position_unsupported', 'position check unsupported'],
  ]
  return words.filter(([k]) => (by[k] ?? 0) > 0).map(([k, w]) => `${by[k]} ${w}`).join(', ')
}
