// Multi-Scenario Comparison tests. The fixture is a real /api/compare response (Horizons + LOLA data, canonical
// viability engine). Same requirements for every scenario; 7-day missions landing 2027-01-15:
//   A Peak Near Shackleton  FAIL (score 61.7, never ranked)   B Malapert Massif  PASS #1   C Connecting Ridge  PASS #2
//   D Malapert 2035: no data (no assessment)   E Malapert, 3-day mission: PASS, rank 1 in separate group G2
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SCREENING_NOTE } from '../../lib/headroom'
import { useAppStore } from '../../store'
import { DEFAULT_REQUIREMENTS } from '../../types'
import {
  WEIGHT_PRESETS,
  axisOffsets,
  bestIds,
  buildSummary,
  computeTradeoff,
  conditionsAt,
  deltaVsBaseline,
  fullDomain,
  mergeSeries,
  METRIC_BY_ID,
  outageIndex,
  canonicalRanking,
  cm,
  eligibilityOf,
  inexactText,
  knownValue,
  marginOf,
  rankText,
  requirementMatrix,
  requirementSummary,
  scoreText,
  type Entry,
} from './analysis'
import fixture from './__fixtures__/compare-response.json'
import { MetricsTable } from './MetricsTable'
import { OverviewCards } from './OverviewCards'
import { AvailabilityCharts, MissionPerformance } from './PerformancePanels'
import { duplicateShifted, makeScenario, nextLabel, resultKey, toTeamScenario, validateScenario } from './scenario'
import { SummaryPanel } from './SummaryPanel'
import { TradeoffPanel } from './TradeoffPanel'
import type { CanonicalMetric, CompareResponse, CompareResult, ComparisonScenario, RankingInfo } from './types'
import { sendToComparison, useCompareStore } from './useCompareStore'

const res = fixture as unknown as CompareResponse
const byKey = Object.fromEntries(res.results.map((r) => [r.key, r])) as Record<string, CompareResult>

const SITES = {
  A: { id: 'peak-near-shackleton', name: 'Peak Near Shackleton', lat: -89.01701, lon: 126.27302 },
  B: { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 },
  C: { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767 },
  D: { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 },
  E: { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 },
}
// The requirements the fixture was generated with.
const REQ = { min_sunlight_fraction: 0.5, battery_hours: 100, panel_threshold: 0.25, min_earth_visibility_fraction: 0.3,
  max_comms_gap_hours: 150, min_initial_sun_hours: 0, min_initial_comms_hours: 0 }

function entries(keys: (keyof typeof SITES)[] = ['A', 'B', 'C']): Entry[] {
  const labels: string[] = []
  return keys.map((k, i) => {
    const s = makeScenario({ site: SITES[k], landing_utc: k === 'D' ? '2035-01-15T00:00:00Z' : '2027-01-15T00:00:00Z',
      duration_days: k === 'E' ? 3 : 7, requirements: REQ, colorSlot: i % 4 }, labels)
    labels.push(s.label)
    const r = byKey[k]
    const result = r.status === 'ok' ? r : null
    return { scenario: s, state: { state: 'done', result: r }, result, offsetHours: 0, ranking: r.ranking ?? null }
  })
}

/** A scenario the engine could not decide (UNKNOWN): A's data with an UNKNOWN verdict and an undecided requirement. */
function unknownEntry(label = 'U'): Entry {
  const [a] = entries(['A'])
  const ranking: RankingInfo = { ...a.ranking!, eligibility: 'unknown', rank: null, score: null, score_lower: null,
    score_upper: null, score_status: 'eligibility_unknown', explanation: 'Not ranked: eligibility is UNKNOWN (undetermined constraints: battery).' }
  const viability = { ...a.result!.viability!, passes: false, eligibility: 'unknown' as const, score: null,
    violations: [{ ...a.result!.viability!.violations[0], is_unknown: true, message: 'UNKNOWN: longest power gap cannot be decided (data missing).' }] }
  const result = { ...a.result!, key: `unknown-${label}`, viability, ranking }
  return { ...a, scenario: { ...a.scenario, id: `u-${label}`, label }, result, state: { state: 'done', result }, ranking }
}

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: 'x', json: async () => body }) as Response

beforeEach(() => {
  useCompareStore.setState({ results: {}, baselineId: null, cursor: null, view: null, allowDemo: false })
})
afterEach(() => vi.unstubAllGlobals())

describe('scenario objects', () => {
  it('assigns letters, duplicates with a date shift and converts to the team Scenario', () => {
    expect(nextLabel(['A', 'B', 'D'])).toBe('C')
    expect(nextLabel(Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)))).toBe('A2')
    const a = makeScenario({ site: SITES.B, landing_utc: '2027-01-15T00:00:00Z' }, [])
    const b = duplicateShifted(a, 14, ['A'])
    expect(b.label).toBe('B')
    expect(b.id).not.toBe(a.id)
    expect(b.landing_utc).toBe('2027-01-29T00:00:00.000Z')
    expect(b.name).toContain('Jan 29, 2027')
    expect(b.requirements).toEqual(a.requirements)
    expect(b.requirements).not.toBe(a.requirements) // deep copy
    expect(toTeamScenario(b)).toEqual({ site: SITES.B, landing_utc: b.landing_utc, duration_days: 14, requirements: DEFAULT_REQUIREMENTS })
  })

  it('validates incomplete scenarios instead of sending them', () => {
    const s = makeScenario({ site: SITES.A, landing_utc: '2027-01-15T00:00:00Z' }, [])
    expect(validateScenario(s)).toEqual([])
    expect(validateScenario({ ...s, duration_days: 0 }).join()).toMatch(/duration/)
    expect(validateScenario({ ...s, landing_utc: 'nope' }).join()).toMatch(/invalid/)
    expect(validateScenario({ ...s, requirements: { ...s.requirements, panel_threshold: 2 } }).join()).toMatch(/panel_threshold/)
  })

  it('cache key changes with any input that changes the answer', () => {
    const s = makeScenario({ site: SITES.A, landing_utc: '2027-01-15T00:00:00Z' }, [])
    expect(resultKey(s, false)).not.toBe(resultKey({ ...s, duration_days: 3 }, false))
    expect(resultKey(s, false)).not.toBe(resultKey(s, true))
    expect(resultKey(s, false)).toBe(resultKey({ ...s, name: 'renamed', colorSlot: 3 }, false))
  })
})

describe('analysis on real data', () => {
  it('finds the best values and leaves ties without a winner', () => {
    const e = entries()
    expect([...bestIds(e, METRIC_BY_ID.mean_disk)]).toEqual([e[1].scenario.id]) // Malapert: most sunlight
    expect([...bestIds(e, METRIC_BY_ID.dark_longest)]).toEqual([e[1].scenario.id])
    expect(bestIds(e, METRIC_BY_ID.earth_pct).size).toBe(0) // all three see Earth 100%
    expect(bestIds(e, METRIC_BY_ID.sun_el_mean).size).toBe(0) // neutral metric: never "best"
  })

  it('computes deltas against a baseline in the metric’s preferred direction', () => {
    const e = entries()
    const d = deltaVsBaseline(METRIC_BY_ID.dark_longest, e[1], e[0])!
    expect(d.value).toBe(byKey.B.solar!.longest_dark_hours! - byKey.A.solar!.longest_dark_hours!)
    expect(d.better).toBe(true) // shorter darkness is better
    expect(deltaVsBaseline(METRIC_BY_ID.dark_longest, e[0], e[0])).toBeNull()
  })

  it('shows exactly the canonical ranking from the backend: only PASS scenarios are ranked', () => {
    const e = entries(['A', 'B', 'C', 'D', 'E'])
    const { groups, unassessed } = canonicalRanking(e, res.ranking_groups)
    const g1 = groups.find((g) => g.group.id === 'G1')!
    expect(g1.ranked.map((x) => x.scenario.label)).toEqual(['B', 'C']) // backend order, not re-sorted
    expect(g1.ranked.map((x) => x.ranking!.rank)).toEqual([1, 2])
    expect(g1.failed.map((x) => x.scenario.label)).toEqual(['A'])
    expect(unassessed.map((x) => x.scenario.label)).toEqual(['D'])
    // Every rank shown equals the backend's, and only PASS has one.
    for (const x of e.filter((x) => x.result && x.ranking)) {
      expect(x.ranking!.rank !== null).toBe(x.ranking!.eligibility === 'pass')
      expect(x.ranking!.rank).toBe(byKey[x.result!.key].ranking!.rank)
    }
  })

  it('never ranks a FAIL scenario, even when its score is higher than nothing', () => {
    const [a] = entries(['A'])
    expect(eligibilityOf(a)).toBe('fail')
    expect(a.ranking!.score).toBeGreaterThan(0)
    expect(a.ranking!.rank).toBeNull()
    expect(rankText(a.ranking, 1)).toBeNull()
  })

  it('keeps a PASS in a different comparison group out of the main ranking', () => {
    const e = entries(['A', 'B', 'C', 'E'])
    const ex = e[3]
    expect(ex.ranking!.group).toBe('G2')
    expect(rankText(ex.ranking, 2)).toBe('only passing option in separate group G2') // no "#1 of 1": it beat nothing
    expect(rankText(e[1].ranking, 2)).toBe('#1 of 2')
    const sep = res.ranking_groups.find((g) => g.id === 'G2')!
    expect(sep.primary).toBe(false)
    expect(sep.separate_reason).toMatch(/duration/)
    expect(buildSummary(e).caveats.join(' ')).toMatch(/2 separate ranking groups/)
  })

  it('never turns a missing score into 0, and keeps a measured 0', () => {
    const base = entries(['B'])[0].ranking!
    const bounded: RankingInfo = { ...base, score: null, score_status: 'bounded', score_lower: 79.04, score_upper: 80.5 }
    expect(scoreText(bounded)).toBe('between 79.0 and 80.5')
    expect(scoreText({ ...base, score: null, score_status: 'eligibility_unknown', score_lower: null, score_upper: null }))
      .toBe('not scored: eligibility unknown')
    expect(scoreText({ ...base, score: null, score_status: 'no_scorable_components', score_lower: null, score_upper: null }))
      .toBe('not scored: no active score component')
    expect(scoreText(null, null)).toBe('-')
    expect(scoreText({ ...base, score: 0, score_status: 'known', score_lower: 0, score_upper: 0 })).toBe('0.0')
    expect(METRIC_BY_ID.score.better).toBeNull() // the canonical ranking, not a "best score" highlight, decides
  })

  it('keeps UNKNOWN as UNKNOWN: not a failure, not ranked, not scored', () => {
    const u = unknownEntry()
    expect(eligibilityOf(u)).toBe('unknown')
    const e = [...entries(['B', 'C']), u]
    const sum = buildSummary(e)
    const hl = sum.highlights.find((h) => h.entry === u)!
    expect(hl.uncertain).toHaveLength(1)
    expect(hl.weaknesses.join(' ')).not.toMatch(/UNKNOWN/)
    expect(sum.overall.join(' ')).toMatch(/cannot be decided from the available data \(UNKNOWN\)/)
    expect(METRIC_BY_ID.violations.get(u.result!, u.scenario)).toBe(0) // no proven failure
    expect(METRIC_BY_ID.undecided.get(u.result!, u.scenario)).toBe(1)
  })

  it('two UNKNOWN scenarios produce no winner', () => {
    const e = [unknownEntry('U'), unknownEntry('V')]
    const sum = buildSummary(e)
    expect(sum.bests.find((b) => b.label === 'Top canonical rank')).toBeUndefined()
    expect(e.every((x) => x.ranking!.rank === null)).toBe(true)
  })

  it('names the canonical rank 1 only when it was ranked against other PASS scenarios', () => {
    const e = entries(['A', 'B', 'C'])
    const top = buildSummary(e).bests.find((b) => b.label === 'Top canonical rank')!
    expect(top.ids).toEqual([e[1].scenario.id]) // B, the backend's rank 1
    expect(top.detail).toMatch(/#1 of 2 passing/)
    // A PASS that was the only passing scenario in its group is not presented as a ranked winner.
    const [a, b] = entries(['A', 'B'])
    const lone = { ...b, ranking: { ...b.ranking!, ranked_in_group: 1 } }
    expect(buildSummary([a, lone]).bests.find((x) => x.label === 'Top canonical rank')).toBeUndefined()
  })

  it('trade-off ranking follows the weights and exposes its inputs', () => {
    const e = entries()
    const power = computeTradeoff(e, WEIGHT_PRESETS.power.weights, 15)
    expect(power[0].entry.scenario.site.id).toBe('malapert-massif')
    const sci = computeTradeoff(e, { solar: 0, comms: 0, science: 1, safety: 0 }, 15)
    // Science weight orders the feasible options by PSR distance; the failing ones never go first.
    const closest = [...e].filter((x) => eligibilityOf(x) === 'pass')
      .sort((a, b) => a.result!.science_context!.distance_to_psr_edge_km - b.result!.science_context!.distance_to_psr_edge_km)[0]
    expect(sci[0].entry.scenario.id).toBe(closest.scenario.id)
    expect(power[0].raw.solar).toMatch(/% mean disk/)
    for (const r of power) expect(r.weighted).toBeCloseTo(Object.values(r.contributions).reduce<number>((a, b) => a + (b ?? 0), 0))
    expect(outageIndex(0, 50)).toBe(1)
    expect(outageIndex(50, 50)).toBe(0.5)
    expect(outageIndex(500, 50)).toBe(0)
  })

  it('explains why with numbers only from the data', () => {
    const sum = buildSummary(entries(['A', 'B', 'C', 'D']))
    const text = sum.overall.join(' ')
    expect(text).toContain('Plan B provides the greatest solar availability')
    expect(text).toContain('95.6%')
    expect(text).toContain('Plan B, Plan C pass every requirement')
    expect(text).toContain('same landing time')
    expect(sum.bests.find((b) => b.label === 'Best Earth communication')).toBeUndefined() // tied at 100%
    expect(sum.caveats.join(' ')).toMatch(/Plan D has no scientific data/)
    expect(sum.caveats.join(' ')).toMatch(/does not guarantee a working radio link/)
  })

  it('reads conditions at a time and says why a site is dark', () => {
    const e = entries()
    const a = e[0]
    const darkWin = byKey.A.dark_windows[0]
    const c = conditionsAt(a, darkWin.start_hour + 1)!
    expect(c.sunFraction).toBe(0)
    expect(c.sunReason).toMatch(/^Dark:/)
    expect(conditionsAt(a, -5)).toBeNull()
    expect(conditionsAt(a, 7 * 24 + 5)).toBeNull()
  })

  it('aligns scenarios by mission time or calendar date', () => {
    const a = makeScenario({ site: SITES.B, landing_utc: '2027-01-15T00:00:00Z' }, [])
    const b = duplicateShifted(a, 14, ['A'])
    const items = [{ scenario: a, state: undefined }, { scenario: b, state: undefined }]
    expect(axisOffsets(items, 'met')).toEqual({ [a.id]: 0, [b.id]: 0 })
    expect(axisOffsets(items, 'utc')).toEqual({ [a.id]: 0, [b.id]: 336 })
    const e = entries()
    expect(fullDomain(e)).toEqual([0, 168])
    const rows = mergeSeries(e, (tl, i) => tl.sun_elevation_deg[i], [0, 168])
    expect(rows.length).toBe(168)
    expect(Object.keys(rows[0])).toHaveLength(4) // x + 3 scenarios
  })
})

describe('compare store', () => {
  it('adds, selects (max 4, distinct colours), edits and removes scenarios', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const st = useCompareStore.getState()
    const ids = [st.addScenario(), st.addScenario(), st.addScenario(), st.addScenario(), st.addScenario()]
    let s = useCompareStore.getState()
    expect(s.scenarios.map((x) => x.label)).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(s.selectedIds).toHaveLength(4) // fifth saved but not selected
    expect(new Set(s.scenarios.filter((x) => s.selectedIds.includes(x.id)).map((x) => x.colorSlot)).size).toBe(4)
    s.toggleSelected(ids[4])
    expect(useCompareStore.getState().selectedIds).toHaveLength(4)
    s.toggleSelected(ids[0])
    s = useCompareStore.getState()
    s.toggleSelected(ids[4])
    s = useCompareStore.getState()
    expect(s.selectedIds).toContain(ids[4])
    expect(new Set(s.scenarios.filter((x) => s.selectedIds.includes(x.id)).map((x) => x.colorSlot)).size).toBe(4)
    s.updateScenario(ids[1], { duration_days: 30, label: 'Z' })
    expect(useCompareStore.getState().scenarios[1]).toMatchObject({ duration_days: 30, label: 'B' })
    s.setBaseline(ids[1])
    s.removeScenario(ids[1])
    s = useCompareStore.getState()
    expect(s.scenarios).toHaveLength(4)
    expect(s.baselineId).toBeNull()
  })

  it('duplicate & shift date keeps the site and moves the landing', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const id = useCompareStore.getState().addScenario({ site: SITES.B, landing_utc: '2027-01-15T00:00:00Z' })
    const copy = useCompareStore.getState().duplicateScenario(id, 7)!
    const c = useCompareStore.getState().scenarios.find((x) => x.id === copy)!
    expect(c.site.id).toBe('malapert-massif')
    expect(c.landing_utc).toBe('2027-01-22T00:00:00.000Z')
    expect(c.origin).toBe('duplicate')
  })

  it('ranks the whole selected set together and caches it until the set changes', async () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const st = useCompareStore.getState()
    st.addScenario({ site: SITES.A, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 })
    st.addScenario({ site: SITES.B, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 })
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      return jsonResponse({ ...res, results: body.scenarios.map((s: { key: string }, i: number) => ({ ...res.results[i], key: s.key })) })
    })
    vi.stubGlobal('fetch', fetchMock)
    await useCompareStore.getState().refresh()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/compare')
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sent.scenarios).toHaveLength(2)
    expect(sent.allow_demo_data).toBe(false)
    expect(Object.values(useCompareStore.getState().results).every((r) => r.state === 'done')).toBe(true)
    await useCompareStore.getState().refresh()
    expect(fetchMock).toHaveBeenCalledTimes(1) // cached
    const s = useCompareStore.getState()
    s.updateScenario(s.selectedIds[0], { duration_days: 3 })
    await useCompareStore.getState().refresh()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The canonical ranking compares the scenarios together, so the whole set is re-ranked.
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).scenarios).toHaveLength(2)
    expect(useCompareStore.getState().rankingSetKey).not.toBeNull()
  })

  it('marks scenarios as unavailable when the backend is down (no fake data)', async () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    useCompareStore.getState().addScenario({ site: SITES.A, landing_utc: '2027-01-15T00:00:00Z' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await useCompareStore.getState().refresh()
    const r = Object.values(useCompareStore.getState().results)[0]
    expect(r.state).toBe('error')
    expect(r.state === 'error' && r.message).toMatch(/Backend unavailable/)
  })

  it('accepts scenarios from Mission Rescue with the first as baseline', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const base = { site: SITES.B, landing_utc: '2027-02-15T00:00:00Z', duration_days: 7, requirements: DEFAULT_REQUIREMENTS }
    const ids = sendToComparison(
      [base, { ...base, landing_utc: '2027-03-01T00:00:00Z' }, { ...base, site: SITES.C }, { ...base, site: SITES.A }, { ...base, duration_days: 3 }],
      { origin: 'rescue', names: ['Original', 'Alt 1', 'Alt 2', 'Alt 3'] },
    )
    const s = useCompareStore.getState()
    expect(ids).toHaveLength(4) // capped at 4
    expect(s.selectedIds).toEqual(ids)
    expect(s.baselineId).toBe(ids[0])
    expect(s.scenarios.find((x) => x.id === ids[0])).toMatchObject({ name: 'Original', origin: 'rescue' })
  })

  it('mirrors the selected time into the shared app store for the 3D view', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const id = useCompareStore.getState().addScenario({ site: SITES.C, landing_utc: '2027-01-15T00:00:00Z' })
    useCompareStore.getState().setActive(id)
    useCompareStore.getState().setCursor(30)
    expect(useAppStore.getState().siteId).toBe('connecting-ridge')
    expect(useAppStore.getState().timeUtc).toBe('2027-01-16T06:00:00.000Z')
  })

  it('mirrors the evaluated (hourly-grid) landing, not the requested one, into the 3D view', () => {
    // The backend evaluates 00:15 as 00:00 (timegrid), so the charts' hour 5 is 05:00, not 05:15.
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const id = useCompareStore.getState().addScenario({ site: SITES.C, landing_utc: '2027-01-15T00:15:00Z' })
    useCompareStore.getState().setActive(id)
    useCompareStore.getState().setCursor(5)
    expect(useAppStore.getState().timeUtc).toBe('2027-01-15T05:00:00.000Z')
  })
})

describe('components render real results', () => {
  it('overview, metrics, performance and summary', () => {
    const e = entries(['A', 'B', 'C', 'D'])
    const html = renderToString(
      <>
        <OverviewCards entries={e} />
        <MetricsTable entries={e} />
        <MissionPerformance entries={e} groups={res.ranking_groups} />
        <SummaryPanel entries={e} />
      </>,
    )
    expect(html).toContain('Peak Near Shackleton')
    expect(html).toContain('JPL Horizons + LOLA')
    expect(html).toContain('title="A meaningful, proven lead among comparable real-data plans. Descriptive, not a recommendation.">best</span>') // the best value is marked
    expect(html).toContain('Longest continuous darkness')
    expect(html).toContain('falls outside it') // D: unavailable message, not fabricated numbers
    expect(html).toContain('Canonical ranking from the viability engine')
    expect(html).toContain('Fails a requirement, not ranked')
    expect(html).toContain('#1 of 2')
    expect(html).toContain('Not assessed')
    expect(html).toContain('greatest solar availability')
  })

  it('renders safely with missing data', () => {
    const s = makeScenario({ site: SITES.A, landing_utc: '2027-01-15T00:00:00Z' }, []) as ComparisonScenario
    const e: Entry[] = [
      { scenario: s, state: undefined, result: null, offsetHours: 0, ranking: null },
      { scenario: { ...s, id: 'x', label: 'B' }, state: { state: 'error', message: 'Backend unavailable' }, result: null, offsetHours: 0, ranking: null },
    ]
    const html = renderToString(<><OverviewCards entries={e} /><MetricsTable entries={e} /><MissionPerformance entries={e} groups={[]} /><SummaryPanel entries={e} /></>)
    expect(html).toContain('Backend unavailable')
    expect(html).toContain('No viability results yet')
  })
})

describe('UNKNOWN in the ranking panel', () => {
  it('lists UNKNOWN separately as "cannot be decided", never as failed or ranked', () => {
    const u = unknownEntry()
    const e = [...entries(['B', 'C']), u]
    const group = { ...res.ranking_groups[0], keys: ['B', 'C', u.result!.key], ranked_keys: ['B', 'C'] }
    const html = renderToString(<MissionPerformance entries={e} groups={[group]} />)
    expect(html).toContain('Cannot be decided (UNKNOWN), not ranked')
    expect(html).toContain('not scored: eligibility unknown')
    expect(html).not.toMatch(/Fails a requirement, not ranked/)
  })
})

// ---------------------------------------------------------------- Phase 3: canonical evidence

/** Copy of an entry whose canonical metric `key` is replaced (e.g. by a bounded or unavailable one). */
function withMetric(e: Entry, key: string, m: CanonicalMetric): Entry {
  const a = e.result!.assessment!
  const result = { ...e.result!, assessment: { ...a, metrics: { ...a.metrics, [key]: m } } }
  return { ...e, result, state: { state: 'done', result } }
}
const BOUNDED_H: CanonicalMetric = { status: 'bounded', unit: 'h', value: null, lower: 40, upper: 60, reason: null }
const UNAVAILABLE: CanonicalMetric = { status: 'unavailable', unit: 'h', value: null, lower: null, upper: null, reason: 'no data' }

describe('canonical evidence (Phase 3)', () => {
  it('every assessed result carries the engine metric states, risk, coverage and versions', () => {
    for (const e of entries(['A', 'B', 'C', 'E'])) {
      const a = e.result!.assessment!
      expect(a.engine_version).toBeTruthy()
      expect(a.dataset_id).toBeTruthy()
      expect(['low', 'moderate', 'high', 'unknown']).toContain(a.overall_risk)
      expect(a.metrics.longest_power_darkness_h.unit).toBe('h')
      expect(a.constraints.length).toBeGreaterThan(0)
    }
  })

  it('margins come from canonical metrics: exact, a range, or unavailable, never a worst-case number', () => {
    const [b] = entries(['B'])
    const req = b.scenario.requirements
    const dark = knownValue(cm(b.result, 'longest_power_darkness_h'))!
    expect(METRIC_BY_ID.battery_margin.get(b.result!, b.scenario)).toBeCloseTo(req.battery_hours - dark)
    expect(METRIC_BY_ID.battery_margin.text!(b.result!, b.scenario)).toBeNull() // exact: shown as a number

    const bounded = withMetric(b, 'longest_power_darkness_h', BOUNDED_H)
    expect(METRIC_BY_ID.battery_margin.get(bounded.result!, b.scenario)).toBeNull()
    expect(METRIC_BY_ID.battery_margin.text!(bounded.result!, b.scenario)).toBe('between 40 h and 60 h') // 100 - [40, 60]

    const missing = withMetric(b, 'longest_power_darkness_h', UNAVAILABLE)
    expect(METRIC_BY_ID.battery_margin.get(missing.result!, b.scenario)).toBeNull()
    expect(METRIC_BY_ID.battery_margin.text!(missing.result!, b.scenario)).toBe('unavailable')
  })

  it('marginOf keeps a real zero and orders a bounded range', () => {
    const zero: CanonicalMetric = { status: 'known', unit: 'h', value: 0, lower: null, upper: null, reason: null }
    expect(marginOf(zero, 50, -1).value).toBe(50)
    expect(marginOf({ ...zero, value: 50 }, 50, -1).value).toBe(-0) // exactly at the limit
    const r = marginOf(BOUNDED_H, 50, -1)
    expect([r.lower, r.upper]).toEqual([-10, 10])
    expect(inexactText(r, 'h')).toBe('between -10 h and 10 h')
    expect(marginOf(null, 50, -1).status).toBe('missing')
  })

  it('a scenario with an inexact measurement is "incomplete" in the trade-off, never ranked or zero-filled', () => {
    const [a, b, c] = entries(['A', 'B', 'C'])
    const rows = computeTradeoff([a, withMetric(b, 'longest_blackout_h', BOUNDED_H), c], WEIGHT_PRESETS.balanced.weights, 15)
    const inc = rows.find((r) => r.entry.scenario.id === b.scenario.id)!
    expect(inc.weighted).toBeNull()
    expect(inc.rank).toBeNull()
    expect(inc.scores.safety).toBeNull()
    expect(inc.missing.join(' ')).toMatch(/Operational safety/)
    expect(rows.filter((r) => r.rank !== null).map((r) => r.rank)).toEqual([1]) // C only: A fails, B incomplete
    expect(rows.indexOf(inc)).toBe(1) // after the complete feasible row, before the infeasible ones
    // With safety weighted 0 the bounded blackout is not needed, so the row is complete again.
    const noSafety = computeTradeoff([withMetric(b, 'longest_blackout_h', BOUNDED_H)], { solar: 1, comms: 1, science: 1, safety: 0 }, 15)
    expect(noSafety[0].weighted).not.toBeNull()
  })

  it('preference weights rank only feasible (PASS) options; a failing one is listed apart with its blocking requirement', () => {
    const e = entries(['A', 'B', 'C'])
    const a = e[0] // Peak Near Shackleton: FAIL
    expect(eligibilityOf(a)).toBe('fail')
    // Whatever the weights favour, the failing option gets no rank and comes after every feasible one.
    for (const w of [WEIGHT_PRESETS.balanced.weights, { solar: 0, comms: 0, science: 1, safety: 0 }, WEIGHT_PRESETS.power.weights]) {
      const rows = computeTradeoff(e, w, 15)
      const fail = rows.find((r) => r.entry.scenario.id === a.scenario.id)!
      expect(fail.rank).toBeNull()
      expect(fail.weighted).not.toBeNull() // still scored: it shows why it is attractive
      expect(rows.indexOf(fail)).toBe(rows.length - 1)
      expect(rows.filter((r) => r.rank !== null).every((r) => r.eligibility === 'pass')).toBe(true)
      expect(fail.blockers.length).toBeGreaterThan(0)
      expect(fail.blockers).toEqual(requirementSummary(a)!.failed.map((c) => c.name))
    }
  })

  it('the trade-off panel separates recommended feasible options from the others and never shows "#1" alone', () => {
    const html = renderToString(<TradeoffPanel entries={entries(['A', 'B', 'C'])} />)
    expect(html).toContain('Recommended feasible options')
    expect(html).toContain('Other options and trade-offs')
    expect(html).toContain('Ruled out by:')
    // With one feasible option there is nothing to rank it against.
    const lone = renderToString(<TradeoffPanel entries={entries(['A', 'B'])} />)
    expect(lone).toContain('The only option that meets every requirement')
    expect(lone).not.toMatch(/#1</)
  })

  it('a scenario without data is UNKNOWN (not assessed), not failed and not ranked', () => {
    const e = entries(['B', 'C', 'D'])
    const d = e[2]
    expect(d.result).toBeNull()
    expect(d.ranking!.eligibility).toBe('unknown')
    expect(d.ranking!.assessed).toBe(false)
    expect(d.ranking!.rank).toBeNull()
    expect(eligibilityOf(d)).toBe('unknown')
    const { unassessed } = canonicalRanking(e, res.ranking_groups)
    expect(unassessed).toContain(d)
    const html = renderToString(<MissionPerformance entries={e} groups={res.ranking_groups} />)
    expect(html).toContain('Not assessed')
    expect(html).toContain('falls outside it')
  })

  it('outage charts draw only exact values and list bounded or unavailable ones', () => {
    const [a, b, c] = entries(['A', 'B', 'C'])
    const html = renderToString(<AvailabilityCharts entries={[a, withMetric(b, 'longest_power_darkness_h', BOUNDED_H), withMetric(c, 'longest_blackout_h', UNAVAILABLE)]} />)
    expect(html).toContain('between 40 h and 60 h')
    expect(html).toContain('Not plotted')
    expect(html).toContain('unavailable')
  })

  it('unknown timeline samples read as unknown, not as darkness or blackout', () => {
    const [b] = entries(['B'])
    const tl = b.result!.timeline!
    const nulls = { ...tl, sun_visible_fraction: tl.sun_visible_fraction.map(() => null), sun_horizon_deg: tl.sun_horizon_deg.map(() => null),
      earth_visible: tl.earth_visible.map(() => null), earth_horizon_deg: tl.earth_horizon_deg.map(() => null) }
    const unknown = { ...b, result: { ...b.result!, timeline: nulls } }
    const c = conditionsAt(unknown, 10)!
    expect(c.sunFraction).toBeNull()
    expect(c.earthVisible).toBeNull()
    expect(c.sunReason).toMatch(/^Unknown/)
    expect(c.earthReason).toMatch(/^Unknown/)
    expect(mergeSeries([unknown], (t, i) => t.sun_visible_fraction[i], [0, 24]).every((r) => r[b.scenario.id] === null)).toBe(true)
  })
})

// ---------------------------------------------------------------- Phase 4: comparison interface

/** Server-rendered HTML without React's text-node separators, for plain-text assertions. */
const plain = (html: string) => html.replace(/<!-- -->/g, '')

describe('comparison interface (Phase 4)', () => {
  it('marks "best" only when the lead is meaningful', () => {
    const [a, b, c] = entries(['A', 'B', 'C'])
    expect([...bestIds([a, b, c], METRIC_BY_ID.dark_longest)]).toEqual([b.scenario.id]) // 4 h vs 12 h: meaningful
    // B leads C by only 0.5 percentage points: similar, so no winner even though A is far behind.
    const close = { ...c, result: { ...c.result!, solar: { ...c.result!.solar!, mean_visible_fraction: b.result!.solar!.mean_visible_fraction - 0.005 } } }
    expect(bestIds([a, b, close], METRIC_BY_ID.mean_disk).size).toBe(0)
  })

  it('a negligible change against the baseline is neither better nor worse', () => {
    const [b, c] = entries(['B', 'C'])
    const close = { ...c, result: { ...c.result!, solar: { ...c.result!.solar!, longest_dark_hours: b.result!.solar!.longest_dark_hours! + 1 } } }
    const d = deltaVsBaseline(METRIC_BY_ID.dark_longest, close, b)!
    expect(d.meaningful).toBe(false)
    expect(d.better).toBeNull()
    expect(deltaVsBaseline(METRIC_BY_ID.dark_longest, c, b)!.better).toBe(false) // 12 h vs 4 h: clearly worse
  })

  it('builds the requirements matrix from the engine verdicts', () => {
    const e = entries(['A', 'B', 'C'])
    const rows = requirementMatrix(e)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('max_continuous_darkness')
    expect(ids).not.toContain('min_sun_clearance') // not applicable to any scenario
    const disk = rows.find((r) => r.id === 'min_mean_solar_disk_fraction')!
    const a = disk.cells[e[0].scenario.id]!
    expect(a.status).toBe('fail')
    expect(a.measured).toBe('36.8%') // fraction shown as a percentage
    expect(a.threshold).toBe('≥ 50.0%')
    expect(disk.cells[e[1].scenario.id]!.status).toBe('pass')
    const sum = requirementSummary(e[0])!
    expect(sum.failed.map((f) => f.id)).toEqual(['min_mean_solar_disk_fraction'])
    expect(sum.passed + sum.failed.length + sum.undecided.length).toBe(sum.applicable)
  })

  it('overview cards lead with status and show requirement verdicts', () => {
    const html = plain(renderToString(<OverviewCards entries={entries(['A', 'B', 'C', 'D'])} />))
    expect(html).toContain('requirements met')
    expect(html).toContain('Minimum mean visible solar-disk fraction')
    // The fixture predates the evaluated fields: the card shows the request as the request, never as evaluated.
    expect(html).toContain('Evaluated: not reported by the backend')
    expect(html).toContain('Requested: 2027-01-15 00:00 UTC, 7 d')
    expect(html).toContain('89.017°S')
    expect(html).toContain('not ranked')
    expect(html).toContain('Cannot be decided') // D: no data
  })

  it('metrics table shows the requirements matrix and which direction is better', () => {
    const html = plain(renderToString(<MetricsTable entries={entries(['A', 'B', 'C'])} />))
    expect(html).toContain('Mission requirements (canonical viability engine)')
    expect(html).toContain('required ≥ 50.0%')
    expect(html).toContain('lower is better')
  })

  it('quick successive requirement edits never overwrite each other', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const id = useCompareStore.getState().addScenario({ site: SITES.B, landing_utc: '2027-01-15T00:00:00Z' })
    const st = useCompareStore.getState()
    st.updateRequirements(id, { battery_hours: 110 })
    st.updateRequirements(id, { min_initial_sun_hours: 0 })
    st.updateSpacecraft(id, { average_load_w: 120 })
    const s = useCompareStore.getState().scenarios.find((x) => x.id === id)!
    expect(s.requirements.battery_hours).toBe(110)
    expect(s.requirements.min_initial_sun_hours).toBe(0)
    expect(s.spacecraft.average_load_w).toBe(120)
  })

  it('a new scenario defaults to a curated landing candidate', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [], sites: [
      { id: 'apollo-11', name: 'Apollo 11', lat: 0.67, lon: 23.47, source: 'x', ground_height_m: null, isControl: false, summary: null, dataRange: null },
      { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326, source: 'x', ground_height_m: null, isControl: false, summary: null, dataRange: null },
    ] })
    const id = useCompareStore.getState().addScenario()
    expect(useCompareStore.getState().scenarios.find((x) => x.id === id)!.site.id).toBe('malapert-massif')
  })
})

describe('quick comparisons', () => {
  it('compares the delay against the original landing and the saved Rescue example', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    useCompareStore.getState().loadPreset('recovery')
    const { scenarios, selectedIds, baselineId } = useCompareStore.getState()
    expect(selectedIds).toEqual(scenarios.map((plan) => plan.id))
    expect(baselineId).toBe(scenarios[1].id)
    expect(scenarios.map((plan) => [plan.site.id, plan.landing_utc])).toEqual([
      ['connecting-ridge', '2027-02-08T00:00:00.000Z'],
      ['connecting-ridge', '2027-02-13T00:00:00.000Z'],
      ['malapert-massif', '2027-02-16T12:00:00.000Z'],
    ])
  })

  it('"Same date, 3 sites" uses the curated south-pole candidates', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [], sites: [
      { id: 'apollo-11', name: 'Apollo 11', lat: 0.67, lon: 23.47, source: 'x', ground_height_m: null, isControl: false, summary: null, dataRange: null },
      { id: 'apollo-12', name: 'Apollo 12', lat: -3.01, lon: 336.58, source: 'x', ground_height_m: null, isControl: false, summary: null, dataRange: null },
    ] })
    useCompareStore.getState().loadPreset('locations')
    const s = useCompareStore.getState()
    const sel = s.selectedIds.map((id) => s.scenarios.find((x) => x.id === id)!.site.id)
    expect(sel).toEqual(['peak-near-shackleton', 'malapert-massif', 'connecting-ridge'])
  })
})

function makeBatteryPassEntry(base: Entry, opts: {
  label: string
  darkHours: number
  batteryHours: number
  rank?: number | null
  initialSun?: number
  firstSunset?: number | null
  initialEarth?: number
  firstEarthset?: number | null
  boundedDark?: [number, number]
}): Entry {
  const r = base.result!
  const a = r.assessment!
  const v = r.viability!
  const darkMetric: CanonicalMetric = opts.boundedDark
    ? { status: 'bounded', unit: 'h', value: null, lower: opts.boundedDark[0], upper: opts.boundedDark[1], reason: 'missing span in darkness window' }
    : { status: 'known', unit: 'h', value: opts.darkHours, lower: null, upper: null, reason: null }
  const initSun = opts.initialSun ?? 0
  const initEarth = opts.initialEarth ?? 168
  const firstSunset = opts.firstSunset === undefined ? null : opts.firstSunset
  const firstEarthset = opts.firstEarthset === undefined ? null : opts.firstEarthset
  const constraints = a.constraints.map((c) => (
    c.id === 'max_continuous_darkness'
      ? { ...c, threshold: opts.batteryHours, status: 'pass' as const, measured: darkMetric }
      : c
  ))
  const metrics = {
    ...a.metrics,
    longest_power_darkness_h: darkMetric,
    initial_sunlight_h: { status: 'known' as const, unit: 'h', value: initSun, lower: null, upper: null, reason: null },
    initial_earth_h: { status: 'known' as const, unit: 'h', value: initEarth, lower: null, upper: null, reason: null },
    ...(firstSunset !== null
      ? { time_to_first_sunset_h: { status: 'known' as const, unit: 'h', value: firstSunset, lower: null, upper: null, reason: null } }
      : {}),
    ...(firstEarthset !== null
      ? { time_to_first_earthset_h: { status: 'known' as const, unit: 'h', value: firstEarthset, lower: null, upper: null, reason: null } }
      : {}),
  }
  const nextReq = { ...base.scenario.requirements, battery_hours: opts.batteryHours }
  const nextViability = {
    ...v,
    passes: true,
    eligibility: 'pass' as const,
    headroom: undefined,
    scenario: { ...v.scenario, requirements: nextReq },
    metrics: {
      ...v.metrics,
      longest_dark_gap_hours: opts.boundedDark ? opts.boundedDark[1] : opts.darkHours,
      initial_sun_hours: initSun,
      hours_to_first_sunset: firstSunset,
      initial_earth_hours: initEarth,
      hours_to_first_earthset: firstEarthset,
    },
  }
  const nextRanking = base.ranking ? { ...base.ranking, eligibility: 'pass' as const, rank: opts.rank ?? base.ranking.rank } : null
  const result: CompareResult = {
    ...r,
    key: opts.label,
    viability: nextViability,
    ranking: nextRanking,
    assessment: { ...a, headroom: undefined, margins: undefined, constraints, metrics },
  }
  return {
    ...base,
    scenario: { ...base.scenario, id: `s-${opts.label}`, label: opts.label, requirements: nextReq },
    result,
    state: { state: 'done', result },
    ranking: nextRanking,
  }
}

describe('operational headroom & margin distinction', () => {
  it('distinguishes 15 h vs 49 h darkness under 50 h battery limit across requirementMatrix, OverviewCards, MetricsTable, PerformancePanels', () => {
    const [b, c] = entries(['B', 'C'])
    const comfortable = makeBatteryPassEntry(b, { label: 'B', darkHours: 15, batteryHours: 50, rank: 1, initialSun: 12, firstSunset: 12, initialEarth: 24, firstEarthset: 24 })
    const limited = makeBatteryPassEntry(c, { label: 'C', darkHours: 49, batteryHours: 50, rank: 2, initialSun: 10, firstSunset: 10, initialEarth: 36, firstEarthset: 36 })

    const rows = requirementMatrix([comfortable, limited])
    const darkRow = rows.find((r) => r.id === 'max_continuous_darkness')!
    expect(darkRow.cells[comfortable.scenario.id]!.margin.value).toBe(35)
    expect(darkRow.cells[comfortable.scenario.id]!.marginClass).toBe('comfortable')
    expect(darkRow.cells[comfortable.scenario.id]!.narrowReason).toBeNull()
    expect(darkRow.cells[limited.scenario.id]!.margin.value).toBe(1)
    expect(darkRow.cells[limited.scenario.id]!.marginClass).toBe('narrow')
    expect(darkRow.cells[limited.scenario.id]!.narrowReason).toContain('<= 10%')

    const cardsHtml = plain(renderToString(<OverviewCards entries={[comfortable, limited]} />))
    expect(cardsHtml).toContain('Pass · comfortable')
    expect(cardsHtml).toContain('Pass · limited darkness')
    expect(cardsHtml).toContain('+35 h')
    expect(cardsHtml).toContain('+1 h')
    expect(cardsHtml).toContain('12 h continuous from landing (first sunset T+12 h)')
    expect(cardsHtml).toContain('168 h continuous from landing (first Earthset T+24 h)')
    expect(cardsHtml).toContain('Closest requirement to limit')
    expect(cardsHtml).toContain(SCREENING_NOTE)

    const tableHtml = plain(renderToString(<MetricsTable entries={[comfortable, limited]} />))
    expect(tableHtml).toContain('Pass · comfortable')
    expect(tableHtml).toContain('Pass · limited darkness')
    expect(tableHtml).toContain('Closest requirement to limit')
    expect(tableHtml).toContain('headroom +35 h')
    expect(tableHtml).toContain('headroom +1 h')
    expect(tableHtml).toContain('Limited')
    expect(tableHtml).toContain('Comfortable')
    expect(tableHtml).toContain('Time to first sunset')
    expect(tableHtml).toContain('Time to first Earthset')

    const chartsHtml = plain(renderToString(<AvailabilityCharts entries={[comfortable, limited]} />))
    expect(chartsHtml).toContain('text-warn')
    expect(chartsHtml).toContain('Limited')
    expect(chartsHtml).toContain('headroom +1 h')

    const perfHtml = plain(renderToString(<MissionPerformance entries={[comfortable, limited]} groups={res.ranking_groups.filter((g) => g.id === 'G1')} />))
    expect(perfHtml).toContain('Pass · limited darkness')
    expect(perfHtml).toContain('Passes with limited darkness margin (+1 h of 50 h limit)')
    expect(perfHtml).not.toContain('Every applicable requirement is met')
  })

  it('preserves bounded darkness margins without collapsing intervals to a point value', () => {
    const [b] = entries(['B'])
    const bounded = makeBatteryPassEntry(b, { label: 'B', darkHours: 49, batteryHours: 50, rank: 1, boundedDark: [42, 49] })
    const r = bounded.result!
    bounded.result = {
      ...r,
      assessment: {
        ...r.assessment!,
        margins: [{
          id: 'max_continuous_darkness',
          name: 'Maximum continuous power-darkness',
          short_label: 'Max continuous darkness',
          unit: 'h',
          measured: { status: 'bounded', unit: 'h', value: null, lower: 42, upper: 49 },
          margin: { status: 'bounded', unit: 'h', value: null, lower: 1, upper: 8 },
          margin_class: 'narrow',
          narrow_reason: 'Darkness headroom bounded within +[1..8] h against 50 h limit',
          description: 'Longest power-dark period vs battery limit',
        }],
      },
    }

    const rows = requirementMatrix([bounded])
    const cell = rows.find((row) => row.id === 'max_continuous_darkness')!.cells[bounded.scenario.id]!
    expect(cell.margin).toEqual({ status: 'bounded', unit: 'h', value: null, lower: 1, upper: 8 })
    expect(cell.marginClass).toBe('narrow')

    const tableHtml = plain(renderToString(<MetricsTable entries={[bounded]} />))
    expect(tableHtml).toContain('+[1..8] h')
    expect(tableHtml).toContain('between 42 h and 49 h')
    expect(tableHtml).not.toContain('45.5 h')

    const chartsHtml = plain(renderToString(<AvailabilityCharts entries={[bounded]} />))
    expect(chartsHtml).toContain('between 42 h and 49 h. Not plotted')
  })
})
