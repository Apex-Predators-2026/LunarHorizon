// The shared comparison-pool rules: who competes for a "best" mark, and when a lead is fair. Every "best" in the
// Comparison (At a glance headlines, the metrics table, the written summary, the assistant context) goes through
// pickBest, so they all follow the same rules:
//
//  1. One kind of data per pool. Real (JPL Horizons + LOLA) results compete only with real results. Demonstration
//     (synthetic) results compete only among themselves, and only when there is no real result at all. There is
//     no fallback that mixes the two when too few real values exist.
//  2. Nobody is left out to make a winner. Every pool member counts: a member whose value is unavailable, withheld
//     or not applicable means no winner (it might be better), and while a scenario is still loading there is no
//     winner yet. Scenarios with no data at all are outside the pool (said so separately), not silent competitors.
//  3. Bounds cannot fake a lead. Only an exact value can win. A bounded competitor blocks the mark unless the
//     leader beats the most favourable end of its range by a meaningful margin.
//  4. A lead must be meaningful (MEANINGFUL, per unit) over every other member; exact ties share nothing ("best"
//     needs someone to be ahead of).
// Pure functions; no React.
import type { CanonicalMetric } from './types'
import type { Entry } from './analysis'

export type MetricUnit = 'h' | '%' | 'deg' | 'W' | 'x' | 'count' | 'pts' | 'score' | 'factor'

/**
 * Smallest difference worth calling a difference, per unit. Below it two values are "similar": no "best" mark
 * and no better/worse colour. These are display thresholds for readability, not scientific tolerances.
 */
export const MEANINGFUL: Record<MetricUnit, (ref: number) => number> = {
  '%': () => 1, pts: () => 1, h: (ref) => Math.max(2, 0.1 * Math.abs(ref)), deg: () => 0.1, W: () => 10,
  x: () => 0.05, factor: () => 0.02, score: () => 1, count: () => 1,
}

export const isMeaningfulDiff = (unit: MetricUnit, a: number, b: number) =>
  Math.abs(a - b) >= MEANINGFUL[unit](Math.max(Math.abs(a), Math.abs(b))) - 1e-9

// ---------------------------------------------------------------- the pool

export interface PoolExclusion {
  entry: Entry
  reason: 'other_data_kind' | 'no_data'
}

export interface ComparisonPool {
  /** The data kind that competes (null: no result yet). */
  dataKind: 'real' | 'demonstration' | null
  members: Entry[]
  outside: PoolExclusion[]
  /** Some scenario is still loading: no winner until every answer is in. */
  pending: boolean
}

const isPending = (e: Entry) => !e.state || e.state.state === 'loading'

/** The scenarios that compete with each other (rule 1), and those left outside, with why. */
export function comparisonPool(entries: Entry[]): ComparisonPool {
  const withResult = entries.filter((e) => e.result)
  const real = withResult.filter((e) => e.result!.data_kind === 'real')
  const dataKind = real.length ? 'real' : withResult.length ? 'demonstration' : null
  const members = real.length ? real : withResult
  const outside: PoolExclusion[] = []
  for (const e of entries) {
    if (members.includes(e) || isPending(e)) continue
    outside.push({ entry: e, reason: e.result ? 'other_data_kind' : 'no_data' })
  }
  return { dataKind, members, outside, pending: entries.some(isPending) }
}

// ---------------------------------------------------------------- one member's value for a metric

export type Contender =
  | { kind: 'exact'; v: number }
  | { kind: 'range'; lower: number; upper: number }
  | { kind: 'none' } // unavailable, withheld, not applicable or not reported

export const exact = (v: number | null | undefined): Contender =>
  v === null || v === undefined || !Number.isFinite(v) ? { kind: 'none' } : { kind: 'exact', v }

/** A canonical metric as a contender (scaled for display, e.g. fraction -> %). */
export function contenderOf(m: CanonicalMetric | null | undefined, scale = 1): Contender {
  if (!m) return { kind: 'none' }
  if (m.status === 'known' && m.value !== null) return { kind: 'exact', v: m.value * scale }
  if (m.status === 'bounded' && m.lower !== null && m.upper !== null) {
    const a = m.lower * scale, b = m.upper * scale
    return { kind: 'range', lower: Math.min(a, b), upper: Math.max(a, b) }
  }
  return { kind: 'none' }
}

// ---------------------------------------------------------------- the winner

export type BestReason =
  | 'winner'
  | 'no_direction' // the metric has no better direction
  | 'pending' // a scenario is still loading
  | 'too_few' // fewer than two scenarios compete
  | 'incomplete' // a member's value is unavailable, or a bound could hide a lead
  | 'tie' // every member has the same value
  | 'not_meaningful' // the leader is not meaningfully ahead of every other member

export interface BestOutcome {
  ids: Set<string> // empty unless reason is 'winner'
  reason: BestReason
  /** Members whose exact value is within the meaningful threshold of the leader (for "similar" wording). */
  similar: Entry[]
}

const none = (reason: BestReason, similar: Entry[] = []): BestOutcome => ({ ids: new Set(), reason, similar })

/** The fairly best member(s) of the pool for one metric (rules 2-4). */
export function pickBest(
  pool: ComparisonPool,
  valueOf: (e: Entry) => Contender,
  better: 'higher' | 'lower' | null,
  unit: MetricUnit,
): BestOutcome {
  if (!better) return none('no_direction')
  if (pool.pending) return none('pending')
  if (pool.members.length < 2) return none('too_few')
  const vals = pool.members.map((e) => ({ e, c: valueOf(e) }))
  if (vals.some((x) => x.c.kind === 'none')) return none('incomplete')
  const exacts = vals.filter((x): x is { e: Entry; c: { kind: 'exact'; v: number } } => x.c.kind === 'exact')
  if (!exacts.length) return none('incomplete')
  const ahead = (a: number, b: number) => (better === 'higher' ? a > b : a < b)
  const lead = exacts.reduce((best, x) => (ahead(x.c.v, best.c.v) ? x : best)).c.v
  const tied = (v: number) => Math.abs(v - lead) <= 1e-9
  const leaders = exacts.filter((x) => tied(x.c.v))
  const similar = exacts.filter((x) => !isMeaningfulDiff(unit, lead, x.c.v)).map((x) => x.e)
  const others = vals.filter((x) => !(x.c.kind === 'exact' && tied(x.c.v)))
  if (!others.length) return none('tie', similar)
  for (const { c } of others) {
    if (c.kind === 'exact') {
      if (!isMeaningfulDiff(unit, lead, c.v)) return none('not_meaningful', similar)
    } else if (c.kind === 'range') {
      // The most favourable value the range allows must still be meaningfully behind the leader.
      const bestCase = better === 'higher' ? c.upper : c.lower
      if (!ahead(lead, bestCase) || !isMeaningfulDiff(unit, lead, bestCase)) return none('incomplete', similar)
    }
  }
  return { ids: new Set(leaders.map((x) => x.e.scenario.id)), reason: 'winner', similar }
}

/** Why there is no "best" mark, in words (for a tooltip or a caveat). Null for a winner. */
export function bestReasonText(o: BestOutcome, pool: ComparisonPool): string | null {
  switch (o.reason) {
    case 'winner':
      return null
    case 'no_direction':
      return 'Neither higher nor lower is better for this metric.'
    case 'pending':
      return 'Waiting for every scenario’s result before marking a best.'
    case 'too_few':
      return pool.outside.some((x) => x.reason === 'other_data_kind')
        ? 'Fewer than two real-data scenarios: real and demonstration results never compete for “best”.'
        : 'Fewer than two scenarios with results to compare.'
    case 'incomplete':
      return 'At least one compared scenario has no exact value here (unavailable, withheld or only bounded), so no lead can be proven.'
    case 'tie':
      return 'All compared scenarios have the same value.'
    case 'not_meaningful':
      return 'The difference is too small to call one scenario better.'
  }
}
