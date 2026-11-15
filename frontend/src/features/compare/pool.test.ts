import { describe, expect, it } from 'vitest'

import { METRIC_BY_ID, bestIds, bestOutcome, buildSummary, type Entry } from './analysis'
import { HEADLINES, headlineBest, headlineRows } from './glance'
import { comparisonPool, contenderOf, exact, pickBest, type Contender } from './pool'
import type { CanonicalMetric, CompareResult, ComparisonScenario, DataKind } from './types'

const known = (v: number, unit = '%'): CanonicalMetric => ({ status: 'known', unit, value: v, lower: null, upper: null, reason: null })
const bounded = (lo: number, hi: number, unit = '%'): CanonicalMetric => ({ status: 'bounded', unit, value: null, lower: lo, upper: hi, reason: 'partial data' })

interface Opts {
  kind?: DataKind
  metrics?: Record<string, CanonicalMetric>
  solar?: { mean_visible_fraction: number; longest_dark_hours: number | null } | null
  earth?: { visible_fraction: number; longest_blackout_hours: number | null } | null
  loading?: boolean
  noData?: boolean
}

function entry(id: string, o: Opts = {}): Entry {
  const scenario = { id, label: id, colorSlot: 0, site: { id: 's', name: 's', lat: -89, lon: 0 }, landing_utc: '2027-01-01T00:00:00Z', duration_days: 7 } as unknown as ComparisonScenario
  if (o.loading) return { scenario, state: { state: 'loading' }, result: null, offsetHours: 0, ranking: null }
  if (o.noData) {
    const r = { key: id, status: 'unavailable', data_kind: 'unavailable' } as unknown as CompareResult
    return { scenario, state: { state: 'done', result: r }, result: null, offsetHours: 0, ranking: null }
  }
  const result = {
    key: id,
    status: 'ok',
    data_kind: o.kind ?? 'real',
    assessment: { metrics: o.metrics ?? {}, constraints: [] },
    solar: o.solar === undefined ? null : o.solar ? { ...o.solar, mean_elevation_deg: 1, mean_clearance_lit_deg: null } : null,
    earth: o.earth === undefined ? null : o.earth,
    viability: null,
    ranking: null,
  } as unknown as CompareResult
  return { scenario, state: { state: 'done', result }, result, offsetHours: 0, ranking: null }
}

const sunlight = HEADLINES.find((h) => h.key === 'mean_solar_disk_fraction')!
const disk = (f: number) => ({ mean_solar_disk_fraction: known(f, 'fraction') })

describe('comparison pool: real and synthetic never compete', () => {
  it('keeps real results only when any exist, with no fallback that mixes in demonstration results', () => {
    const es = [entry('A', { metrics: disk(0.5) }), entry('B', { kind: 'demonstration', metrics: disk(0.9) }), entry('C', { kind: 'demonstration', metrics: disk(0.1) })]
    const pool = comparisonPool(es)
    expect(pool.dataKind).toBe('real')
    expect(pool.members.map((e) => e.scenario.id)).toEqual(['A'])
    expect(pool.outside.map((x) => [x.entry.scenario.id, x.reason])).toEqual([['B', 'other_data_kind'], ['C', 'other_data_kind']])
    // One real value: nothing to compare. (Before: the pool fell back to all three and crowned the synthetic B.)
    expect(headlineBest(sunlight, es).reason).toBe('too_few')
    expect(headlineRows(sunlight, es).some((r) => r.best)).toBe(false)
  })

  it('lets demonstration results compete among themselves when there is no real result', () => {
    const es = [entry('B', { kind: 'demonstration', metrics: disk(0.9) }), entry('C', { kind: 'demonstration', metrics: disk(0.1) })]
    expect(comparisonPool(es).dataKind).toBe('demonstration')
    expect([...headlineBest(sunlight, es).ids]).toEqual(['B'])
  })

  it('keeps scenarios with no data at all outside the pool (said so, not a silent competitor)', () => {
    const es = [entry('A', { metrics: disk(0.9) }), entry('B', { metrics: disk(0.2) }), entry('N', { noData: true })]
    const pool = comparisonPool(es)
    expect(pool.outside).toEqual([{ entry: es[2], reason: 'no_data' }])
    expect([...headlineBest(sunlight, es).ids]).toEqual(['A'])
  })
})

describe('every pool member counts', () => {
  const lower = (vals: Contender[]) => {
    const es = vals.map((_, i) => entry(String.fromCharCode(65 + i)))
    return pickBest(comparisonPool(es), (e) => vals[es.indexOf(e)], 'lower', 'h')
  }

  it('gives no winner when a competitor is unavailable (it might be better)', () => {
    expect(lower([exact(4), exact(12), { kind: 'none' }])).toMatchObject({ reason: 'incomplete' })
    expect(lower([exact(4), exact(12)])).toMatchObject({ reason: 'winner' })
  })

  it('never lets a bound win, and lets it block a lead it could hide', () => {
    expect(lower([exact(4), { kind: 'range', lower: 2, upper: 30 }]).reason).toBe('incomplete') // could be 2 h
    expect([...lower([exact(4), { kind: 'range', lower: 20, upper: 30 }]).ids]).toEqual(['A']) // at best 20 h: clearly behind
    expect(lower([{ kind: 'range', lower: 1, upper: 2 }, { kind: 'range', lower: 20, upper: 30 }]).reason).toBe('incomplete')
  })

  it('needs a meaningful lead over every member, and no winner in an exact tie', () => {
    expect(lower([exact(10), exact(11), exact(40)]).reason).toBe('not_meaningful') // 1 h < max(2 h, 10%)
    expect(lower([exact(10), exact(10)]).reason).toBe('tie')
    expect([...lower([exact(10), exact(10), exact(40)]).ids].sort()).toEqual(['A', 'B']) // tied leaders share
  })

  it('waits for every answer before marking a best', () => {
    const es = [entry('A', { metrics: disk(0.9) }), entry('B', { metrics: disk(0.2) }), entry('L', { loading: true })]
    expect(headlineBest(sunlight, es).reason).toBe('pending')
  })

  it('reads canonical metrics as exact, range or none', () => {
    expect(contenderOf(known(0.5, 'fraction'), 100)).toEqual({ kind: 'exact', v: 50 })
    expect(contenderOf(bounded(0.2, 0.4, 'fraction'), 100)).toEqual({ kind: 'range', lower: 20, upper: 40 })
    expect(contenderOf({ status: 'unavailable', unit: '%', value: null, lower: null, upper: null, reason: 'no data' })).toEqual({ kind: 'none' })
  })
})

describe('the table, headlines and summary share the rules', () => {
  it('table: a withheld competitor blocks the "best" instead of being dropped', () => {
    const a = entry('A', { solar: { mean_visible_fraction: 0.9, longest_dark_hours: 2 } })
    const b = entry('B', { solar: { mean_visible_fraction: 0.3, longest_dark_hours: 40 } })
    const withheld = entry('W', { solar: null })
    expect([...bestIds([a, b], METRIC_BY_ID.mean_disk)]).toEqual(['A'])
    expect(bestIds([a, b, withheld], METRIC_BY_ID.mean_disk).size).toBe(0)
    expect(bestOutcome([a, b, withheld], METRIC_BY_ID.mean_disk).reason).toBe('incomplete')
  })

  it('headlines: a bounded competitor that could be ahead blocks the mark', () => {
    const es = [entry('A', { metrics: disk(0.6) }), entry('B', { metrics: { mean_solar_disk_fraction: bounded(0.4, 0.8, 'fraction') } })]
    expect(headlineBest(sunlight, es).reason).toBe('incomplete')
  })

  it('summary: no "best" or "worst" while a real scenario has withheld statistics, and it is not called demonstration data', () => {
    const solar = (f: number, d: number) => ({ mean_visible_fraction: f, longest_dark_hours: d })
    const earth = (f: number, b: number) => ({ visible_fraction: f, longest_blackout_hours: b })
    const a = entry('A', { solar: solar(0.9, 2), earth: earth(1, 0) })
    const b = entry('B', { solar: solar(0.3, 40), earth: earth(0.5, 50) })
    const w = entry('W', { solar: null, earth: earth(1, 0) })
    const full = buildSummary([a, b])
    expect(full.bests.map((x) => x.label)).toContain('Best solar performance')
    const s = buildSummary([a, b, w])
    expect(s.bests.find((x) => x.label === 'Best solar performance')).toBeUndefined()
    expect(s.highlights.flatMap((x) => x.weaknesses)).not.toContain('Least solar availability (30.0%)')
    expect(s.caveats.join(' ')).toMatch(/Scenario W has withheld or unavailable Sun\/Earth statistics/)
    expect(s.caveats.join(' ')).not.toMatch(/Scenario W use demonstration data/)
    expect(s.highlights.map((x) => x.entry.scenario.id)).toContain('W') // its verdicts are still summarised
  })
})
