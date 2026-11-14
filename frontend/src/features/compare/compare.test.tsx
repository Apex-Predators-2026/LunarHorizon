// Multi-Scenario Comparison tests. The fixture is a real /api/compare response (Horizons + LOLA data,
// 7-day missions from 2027-01-15 at three curated sites, plus one out-of-range scenario).
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  rankByViability,
  type Entry,
} from './analysis'
import fixture from './__fixtures__/compare-response.json'
import { MetricsTable } from './MetricsTable'
import { OverviewCards } from './OverviewCards'
import { MissionPerformance } from './PerformancePanels'
import { duplicateShifted, makeScenario, nextLabel, resultKey, toTeamScenario, validateScenario } from './scenario'
import { SummaryPanel } from './SummaryPanel'
import type { CompareResponse, CompareResult, ComparisonScenario } from './types'
import { sendToComparison, useCompareStore } from './useCompareStore'

const res = fixture as unknown as CompareResponse
const byKey = Object.fromEntries(res.results.map((r) => [r.key, r])) as Record<string, CompareResult>

const SITES = {
  A: { id: 'peak-near-shackleton', name: 'Peak Near Shackleton', lat: -89.01701, lon: 126.27302 },
  B: { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 },
  C: { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767 },
  D: { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 },
}

function entries(keys: (keyof typeof SITES)[] = ['A', 'B', 'C']): Entry[] {
  const labels: string[] = []
  return keys.map((k, i) => {
    const s = makeScenario({ site: SITES[k], landing_utc: k === 'D' ? '2030-01-15T00:00:00Z' : '2027-01-15T00:00:00Z', duration_days: 7, colorSlot: i }, labels)
    labels.push(s.label)
    const r = byKey[k]
    return { scenario: s, state: { state: 'done', result: r }, result: r.status === 'ok' ? r : null, offsetHours: 0 }
  })
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
    expect(d.value).toBe(byKey.B.solar!.longest_dark_hours - byKey.A.solar!.longest_dark_hours)
    expect(d.better).toBe(true) // shorter darkness is better
    expect(deltaVsBaseline(METRIC_BY_ID.dark_longest, e[0], e[0])).toBeNull()
  })

  it('ranks by the team viability result, passing first', () => {
    const { real, demo } = rankByViability(entries(['A', 'B', 'C', 'D']))
    expect(real.map((r) => r.entry.scenario.site.id)).toEqual(['connecting-ridge', 'malapert-massif', 'peak-near-shackleton'])
    expect(real[0].entry.result!.viability!.passes).toBe(true)
    expect(demo).toEqual([])
  })

  it('trade-off ranking follows the weights and exposes its inputs', () => {
    const e = entries()
    const power = computeTradeoff(e, WEIGHT_PRESETS.power.weights, 15)
    expect(power[0].entry.scenario.site.id).toBe('malapert-massif')
    const sci = computeTradeoff(e, { solar: 0, comms: 0, science: 1, safety: 0 }, 15)
    const closest = [...e].sort((a, b) => a.result!.science_context!.distance_to_psr_edge_km - b.result!.science_context!.distance_to_psr_edge_km)[0]
    expect(sci[0].entry.scenario.id).toBe(closest.scenario.id)
    expect(power[0].raw.solar).toMatch(/% mean disk/)
    for (const r of power) expect(r.weighted).toBeCloseTo(Object.values(r.contributions).reduce((a, b) => a + b, 0))
    expect(outageIndex(0, 50)).toBe(1)
    expect(outageIndex(50, 50)).toBe(0.5)
    expect(outageIndex(500, 50)).toBe(0)
  })

  it('explains why with numbers only from the data', () => {
    const sum = buildSummary(entries(['A', 'B', 'C', 'D']))
    const text = sum.overall.join(' ')
    expect(text).toContain('Scenario B provides the greatest solar availability')
    expect(text).toContain('95.7%')
    expect(text).toContain('same landing time')
    expect(sum.bests.find((b) => b.label === 'Best Earth communication')).toBeUndefined() // tied at 100%
    expect(sum.caveats.join(' ')).toMatch(/Scenario D has no scientific data/)
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
    expect(axisOffsets([a, b], 'met')).toEqual({ [a.id]: 0, [b.id]: 0 })
    expect(axisOffsets([a, b], 'utc')).toEqual({ [a.id]: 0, [b.id]: 336 })
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

  it('fetches only changed scenarios and caches results', async () => {
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
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).scenarios).toHaveLength(1)
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
})

describe('components render real results', () => {
  it('overview, metrics, performance and summary', () => {
    const e = entries(['A', 'B', 'C', 'D'])
    const html = renderToString(
      <>
        <OverviewCards entries={e} />
        <MetricsTable entries={e} />
        <MissionPerformance entries={e} />
        <SummaryPanel entries={e} />
      </>,
    )
    expect(html).toContain('Peak Near Shackleton')
    expect(html).toContain('JPL Horizons + LOLA')
    expect(html).toContain('title="Best among compared real-data scenarios">best</span>') // the best value is marked
    expect(html).toContain('Longest continuous darkness')
    expect(html).toContain('falls outside it') // D: unavailable message, not fabricated numbers
    expect(html).toContain('Real-data scenarios')
    expect(html).toContain('placeholder')
    expect(html).toContain('greatest solar availability')
  })

  it('renders safely with missing data', () => {
    const s = makeScenario({ site: SITES.A, landing_utc: '2027-01-15T00:00:00Z' }, []) as ComparisonScenario
    const e: Entry[] = [
      { scenario: s, state: undefined, result: null, offsetHours: 0 },
      { scenario: { ...s, id: 'x', label: 'B' }, state: { state: 'error', message: 'Backend unavailable' }, result: null, offsetHours: 0 },
    ]
    const html = renderToString(<><OverviewCards entries={e} /><MetricsTable entries={e} /><MissionPerformance entries={e} /><SummaryPanel entries={e} /></>)
    expect(html).toContain('Backend unavailable')
    expect(html).toContain('No viability results yet')
  })
})
