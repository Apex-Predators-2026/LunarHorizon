// "best" across real and synthetic results, bounds, missing values and mixed missions. One rule (bestPool + bestOf)
// drives the At a glance bars, the metrics table and the written summary. Results are the real captured
// /api/compare results (compare-response.json), with data_kind or one canonical metric overridden per case.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import fixture from './__fixtures__/compare-response.json'
import { METRICS, bestIds, bestOf, bestPool, buildSummary, type Entry } from './analysis'
import { HeadlineConditions } from './AtAGlance'
import { HEADLINES, headlineRows } from './glance'
import { makeScenario } from './scenario'
import type { CanonicalMetric, CompareResponse, CompareResult } from './types'

const res = fixture as unknown as CompareResponse
const B = res.results.find((r) => r.key === 'B')! as CompareResult
const SITE = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }
const SOLAR = HEADLINES.find((h) => h.key === 'mean_solar_disk_fraction')!
const DARK = HEADLINES.find((h) => h.key === 'longest_power_darkness_h')!

const known = (value: number, unit: string): CanonicalMetric => ({ status: 'known', unit, value, lower: null, upper: null, reason: null })
const bounded = (lower: number, upper: number, unit: string): CanonicalMetric => ({ status: 'bounded', unit, value: null, lower, upper, reason: 'data incomplete' })

/** A result like B with the solar-disk fraction (and optionally other metrics) set, real or demonstration. */
function result(label: string, kind: 'real' | 'demonstration', metrics: Record<string, CanonicalMetric>): CompareResult {
  return { ...B, key: label, data_kind: kind, assessment: { ...B.assessment!, metrics: { ...B.assessment!.metrics, ...metrics } } }
}
function entry(label: string, r: CompareResult | null, extra: { duration?: number; battery?: number; state?: 'done' | 'loading' | 'error' } = {}): Entry {
  const base = makeScenario({ site: SITE, landing_utc: '2027-01-15T00:00:00Z' }, [])
  const scenario = {
    ...base, label, id: `s-${label}`, duration_days: extra.duration ?? base.duration_days,
    requirements: { ...base.requirements, battery_hours: extra.battery ?? base.requirements.battery_hours },
  }
  const st = extra.state ?? 'done'
  const state = st === 'loading' ? { state: 'loading' as const } : st === 'error' ? { state: 'error' as const, message: 'Backend unavailable' }
    : { state: 'done' as const, result: r ?? { ...B, status: 'unavailable', data_kind: 'unavailable' } as CompareResult }
  return { scenario, state, result: r, offsetHours: 0, ranking: r?.ranking ?? null } as Entry
}
const solar = (v: number, kind: 'real' | 'demonstration' = 'real') => result('x', kind, { mean_solar_disk_fraction: known(v, 'fraction') })
const bestLabels = (rows: ReturnType<typeof headlineRows>) => rows.filter((r) => r.best).map((r) => r.entry.scenario.label)

describe('real and synthetic results never compete for "best"', () => {
  it('one real (40%) and one synthetic (90%): no best at all, and the note says why', () => {
    const e = [entry('A', solar(0.4)), entry('S', solar(0.9, 'demonstration'))]
    expect(bestLabels(headlineRows(SOLAR, e))).toEqual([])
    expect(bestPool(e)).toMatchObject({ basis: 'none' })
    expect(bestPool(e).note).toMatch(/Only one scenario uses real data/)
    const sun = METRICS.find((m) => m.id === 'mean_visible_fraction') ?? METRICS.find((m) => m.better === 'higher')!
    expect([...bestIds(e, sun)]).toEqual([])
  })

  it('several real plus synthetic: only the real ones compete, even if the synthetic value is higher', () => {
    const e = [entry('A', solar(0.4)), entry('B', solar(0.6)), entry('S', solar(0.95, 'demonstration'))]
    const rows = headlineRows(SOLAR, e)
    expect(bestLabels(rows)).toEqual(['B'])
    expect(rows.find((r) => r.best)!.illustrative).toBe(false)
    expect(bestPool(e).note).toMatch(/do not compete with real-data ones/)
  })

  it('synthetic-only: a best is explicitly illustrative', () => {
    const e = [entry('S1', solar(0.4, 'demonstration')), entry('S2', solar(0.7, 'demonstration'))]
    const rows = headlineRows(SOLAR, e)
    expect(bestLabels(rows)).toEqual(['S2'])
    expect(rows.find((r) => r.best)!.illustrative).toBe(true)
    const html = renderToString(<HeadlineConditions entries={e} />)
    expect(html).toContain('best (illustrative)')
    expect(html).toContain('Demonstration data only')
  })
})

describe('bounds, missing values and ties', () => {
  it('exact values: a meaningful lead wins; equal values give no winner; a legitimate measured zero competes', () => {
    expect(bestLabels(headlineRows(DARK, [entry('A', result('A', 'real', { longest_power_darkness_h: known(0, 'h') })),
      entry('B', result('B', 'real', { longest_power_darkness_h: known(30, 'h') }))]))).toEqual(['A'])
    expect(bestLabels(headlineRows(SOLAR, [entry('A', solar(0.5)), entry('B', solar(0.5))]))).toEqual([])
    expect(bestLabels(headlineRows(SOLAR, [entry('A', solar(0.5)), entry('B', solar(0.505))]))).toEqual([]) // < 1 pp
  })

  it('a bounded candidate whose best case could beat the leader blocks the mark (overlapping bounds)', () => {
    const e = [entry('A', solar(0.6)), entry('B', result('B', 'real', { mean_solar_disk_fraction: bounded(0.3, 0.7, 'fraction') }))]
    expect(bestLabels(headlineRows(SOLAR, e))).toEqual([])
  })

  it('bounds that are entirely and meaningfully worse do not block a proven lead; a bounded leader can win too', () => {
    const behind = [entry('A', solar(0.6)), entry('B', result('B', 'real', { mean_solar_disk_fraction: bounded(0.2, 0.4, 'fraction') }))]
    expect(bestLabels(headlineRows(SOLAR, behind))).toEqual(['A'])
    const ahead = [entry('A', solar(0.3)), entry('B', result('B', 'real', { mean_solar_disk_fraction: bounded(0.5, 0.8, 'fraction') }))]
    expect(bestLabels(headlineRows(SOLAR, ahead))).toEqual(['B'])
  })

  it('a missing (unavailable) value in the pool gives no best', () => {
    const e = [entry('A', solar(0.6)), entry('B', result('B', 'real', { mean_solar_disk_fraction: { ...known(0, 'fraction'), status: 'unavailable', value: null } }))]
    expect(bestLabels(headlineRows(SOLAR, e))).toEqual([])
  })

  it('a scenario still loading or failed blocks every best; one with no data for its date is excluded and named', () => {
    const loading = [entry('A', solar(0.3)), entry('B', solar(0.8)), entry('C', null, { state: 'loading' })]
    expect(bestLabels(headlineRows(SOLAR, loading))).toEqual([])
    expect(bestPool(loading).note).toMatch(/Scenario C has no result yet/)
    const failed = [entry('A', solar(0.3)), entry('B', solar(0.8)), entry('C', null, { state: 'error' })]
    expect(bestLabels(headlineRows(SOLAR, failed))).toEqual([])
    const noData = [entry('A', solar(0.3)), entry('B', solar(0.8)), entry('D', null)]
    expect(bestLabels(headlineRows(SOLAR, noData))).toEqual(['B'])
    expect(bestPool(noData).note).toMatch(/Scenario D has no data for the chosen site and time and is not compared/)
  })

  it('bestOf: a single candidate never wins', () => {
    expect([...bestOf([{ id: 'a', lo: 1, hi: 1 }], 'higher', () => true)]).toEqual([])
  })
})

describe('different missions are described, not ranked', () => {
  it('different durations: no best in the bars, the table or the summary', () => {
    const e = [entry('A', solar(0.4), { duration: 7 }), entry('B', solar(0.8), { duration: 14 })]
    expect(bestLabels(headlineRows(SOLAR, e))).toEqual([])
    expect(bestPool(e).note).toMatch(/different mission durations/)
    for (const m of METRICS) expect(bestIds(e, m).size).toBe(0)
    const sum = buildSummary(e)
    expect(sum.bests.filter((b) => b.label !== 'Top canonical rank')).toEqual([])
    expect(sum.caveats.join(' ')).toMatch(/different mission durations/)
  })

  it('summary: a real scenario with withheld statistics is not dropped to make a winner, nor called demonstration data', () => {
    const withStats = (label: string, f: number, dark: number): CompareResult => ({
      ...B, key: label,
      solar: { ...B.solar!, mean_visible_fraction: f, longest_dark_hours: dark },
      earth: { ...B.earth!, visible_fraction: 1, longest_blackout_hours: 0 },
    })
    const a = entry('A', withStats('A', 0.9, 2)), b = entry('B', withStats('B', 0.3, 40))
    expect(buildSummary([a, b]).bests.map((x) => x.label)).toContain('Best solar performance')
    const w = entry('W', { ...withStats('W', 0.5, 10), solar: null, withheld: { solar: 'Sun unknown for 18 h' } })
    const sum = buildSummary([a, b, w])
    expect(sum.bests.filter((x) => x.label !== 'Top canonical rank')).toEqual([])
    expect(sum.caveats.join(' ')).toMatch(/Scenario W has withheld or unavailable Sun\/Earth statistics/)
    expect(sum.caveats.join(' ')).not.toMatch(/Scenario W use demonstration data/)
    expect(sum.highlights.map((x) => x.entry.scenario.label)).toContain('W') // its own verdicts still appear
  })

  it('different requirements: no best', () => {
    const e = [entry('A', solar(0.4), { battery: 50 }), entry('B', solar(0.8), { battery: 30 })]
    expect(bestLabels(headlineRows(SOLAR, e))).toEqual([])
    expect(bestPool(e).note).toMatch(/different requirements/)
  })
})

describe('bars', () => {
  it('a measured zero draws no bar; a positive value draws one', () => {
    const e = [entry('A', result('A', 'real', { longest_power_darkness_h: known(0, 'h') })), entry('B', result('B', 'real', { longest_power_darkness_h: known(30, 'h') }))]
    const html = renderToString(<HeadlineConditions entries={e} />)
    const darkBlock = html.slice(html.indexOf('Longest continuous darkness'), html.indexOf('Earth in line of sight'))
    const bars = darkBlock.match(/style="width:[^"]+"/g) ?? []
    expect(bars).toHaveLength(1) // only B's 30 h; A's 0 h has no bar
    expect(darkBlock).toContain('0 h')
  })
})
