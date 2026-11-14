import type { Scenario } from '../../types'
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
