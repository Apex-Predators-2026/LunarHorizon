// Missing-data integrity in the Scenario Comparison: unknown stays unknown through statistics, best-of claims, the
// written summary, chart rows, conditions and the availability lanes. Built from the real /api/compare fixture with
// controlled edits (each edit mirrors what the backend sends when a body's data are incomplete).
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { bestIds, buildSummary, conditionsAt, fmtMetric, mergeSeries, METRIC_BY_ID, sampleIndex, type Entry } from './analysis'
import fixture from './__fixtures__/compare-response.json'
import { OverviewCards } from './OverviewCards'
import { makeScenario } from './scenario'
import { sunPath } from './lanes'
import { SyncTimeline } from './SyncTimeline'
import type { CanonicalMetric, CompareResponse, CompareResult, TimelineColumns, Window } from './types'

const res = fixture as unknown as CompareResponse
const byKey = Object.fromEntries(res.results.map((r) => [r.key, r])) as Record<string, CompareResult>
const SITES = {
  A: { id: 'peak-near-shackleton', name: 'Peak Near Shackleton', lat: -89.01701, lon: 126.27302 },
  B: { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 },
  C: { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767 },
}

function entry(k: keyof typeof SITES, edit: (r: CompareResult) => CompareResult = (r) => r, label = k): Entry {
  const s = makeScenario({ site: SITES[k], landing_utc: '2027-01-15T00:00:00Z', duration_days: 7, colorSlot: 0 }, [])
  const result = edit(structuredClone(byKey[k]))
  return { scenario: { ...s, label }, state: { state: 'done', result }, result, offsetHours: 0, ranking: result.ranking ?? null }
}

const bounded = (unit: string, lower: number, upper: number): CanonicalMetric => ({ status: 'bounded', unit, value: null, lower, upper, reason: 'data incomplete' })
const unavailable = (unit: string): CanonicalMetric => ({ status: 'unavailable', unit, value: null, lower: null, upper: null, reason: 'no data' })

/** What the backend sends when the Sun's state is unknown for part of the mission: solar/power withheld, bounds. */
const sunIncomplete = (r: CompareResult): CompareResult => ({
  ...r, solar: null, power: null, sun_known_hours: 160, evaluated_hours: 168,
  withheld: { solar: 'Sun unknown for 8 h', power: 'Sun unknown for 8 h' },
  assessment: { ...r.assessment!, metrics: { ...r.assessment!.metrics,
    sunlight_percent: bounded('%', 60, 70), mean_solar_disk_fraction: bounded('fraction', 0.55, 0.62),
    longest_without_sun_h: bounded('h', 10, 18), mean_sun_clearance_deg: unavailable('deg') } },
})
const earthIncomplete = (r: CompareResult): CompareResult => ({
  ...r, earth: null, earth_known_hours: 150, evaluated_hours: 168, withheld: { ...(r.withheld ?? {}), earth: 'Earth unknown for 18 h' },
  assessment: { ...r.assessment!, metrics: { ...r.assessment!.metrics, earth_visible_percent: bounded('%', 70, 81), longest_blackout_h: unavailable('h') } },
})

describe('fully known data (the real fixture)', () => {
  it('reports exact whole-mission values and marks a best only among exact values', () => {
    const es = [entry('A'), entry('B'), entry('C')]
    const v = METRIC_BY_ID.sunlit_pct.get(es[1].result!, es[1].scenario)!
    expect(v).toBeCloseTo(byKey.B.solar!.sunlit_fraction * 100)
    expect(METRIC_BY_ID.sunlit_pct.text!(es[1].result!, es[1].scenario)).toBeNull()
    expect(bestIds(es, METRIC_BY_ID.mean_disk).size).toBeGreaterThan(0)
  })
})

describe('incomplete data never becomes a measurement', () => {
  it('missing Sun data: solar rows show the engine’s bounds or Unknown, never a number; Earth rows stand', () => {
    const b = entry('B', sunIncomplete)
    const r = b.result!
    expect(METRIC_BY_ID.sunlit_pct.get(r, b.scenario)).toBeNull()
    expect(METRIC_BY_ID.sunlit_pct.text!(r, b.scenario)).toBe('60.0% – 70.0% (bounds: data incomplete)')
    expect(METRIC_BY_ID.mean_disk.text!(r, b.scenario)).toBe('55.0% – 62.0% (bounds: data incomplete)')
    expect(METRIC_BY_ID.sunlit_hours.text!(r, b.scenario)).toMatch(/^101 h .* – 118 h .*bounds/) // 60-70 % of the 168 h mission
    expect(METRIC_BY_ID.sun_clear.text!(r, b.scenario)).toBe('Unknown (data incomplete)')
    expect(METRIC_BY_ID.incidence.text!(r, b.scenario)).toBe('Unknown (data incomplete)') // power depends on the Sun
    expect(METRIC_BY_ID.sun_windows.get(r, b.scenario)).toBeNull()
    expect(METRIC_BY_ID.earth_pct.get(r, b.scenario)).toBeCloseTo(byKey.B.earth!.visible_fraction * 100) // valid Earth kept
  })

  it('missing Earth data: Earth rows bounded/unknown, Sun rows exact', () => {
    const b = entry('B', earthIncomplete)
    expect(METRIC_BY_ID.earth_pct.text!(b.result!, b.scenario)).toBe('70.0% – 81.0% (bounds: data incomplete)')
    expect(METRIC_BY_ID.blackout_longest.text!(b.result!, b.scenario)).toBe('Unknown (data incomplete)')
    expect(METRIC_BY_ID.sunlit_pct.get(b.result!, b.scenario)).not.toBeNull()
  })

  it('all relevant information unknown: no number anywhere, and the overview says why', () => {
    const b = entry('B', (r) => earthIncomplete(sunIncomplete(r)))
    for (const id of ['sunlit_pct', 'mean_disk', 'earth_pct', 'blackout_longest', 'dark_longest', 'incidence', 'earth_el_min'])
      expect(METRIC_BY_ID[id].get(b.result!, b.scenario)).toBeNull()
    const html = renderToString(<OverviewCards entries={[b]} />).replace(/<!-- -->/g, '')
    expect(html).toContain('Data incomplete: Sun known 160 h, Earth known 150 h of 168 h')
    expect(html).toContain('between 55.0% and 62.0%') // the engine's bounds for the mean solar disk
    expect(html).toContain('between 70.0% and 81.0%') // ... and for Earth in view
    expect(html).not.toContain('NaN')
  })

  it('no “best” when a scenario lacks an exact value (it could be the best), and the summary says so', () => {
    const es = [entry('A'), entry('B', sunIncomplete), entry('C')]
    expect(bestIds(es, METRIC_BY_ID.mean_disk).size).toBe(0)
    expect(bestIds(es, METRIC_BY_ID.sunlit_pct).size).toBe(0)
    expect(bestIds(es, METRIC_BY_ID.earth_el_mean).size).toBeGreaterThan(0) // Earth is complete for all three
    const sum = buildSummary(es)
    expect(sum.bests.map((b) => b.label)).not.toContain('Best solar performance')
    expect(sum.bests.map((b) => b.label)).not.toContain('Shortest darkness')
    expect(sum.caveats.join(" ")).toMatch(/Scenario B has withheld or unavailable Sun\/Earth statistics/)
    expect(sum.overall).toEqual([]) // no overall power-versus-communication verdict is claimed while a member's data is incomplete
  })

  it('a genuine measured zero stays a zero (never shown as unknown)', () => {
    expect(fmtMetric(0, '%')).toBe('0.0%')
    expect(fmtMetric(0, 'h')).toBe('0 h')
    expect(fmtMetric(null, '%')).toBe('—')
  })
})

// ---------------------------------------------------------------- timelines, charts and lanes

function columns(frac: (number | null)[], opts: Partial<TimelineColumns> = {}): TimelineColumns {
  const n = frac.length
  return {
    step_hours: 1, source_step_hours: 1, stride: 1, hour: frac.map((_, i) => i), time_utc: frac.map((_, i) => new Date(Date.UTC(2027, 0, 15, i)).toISOString()),
    sun_elevation_deg: Array(n).fill(1), sun_azimuth_deg: Array(n).fill(0), sun_horizon_deg: frac.map((f) => (f === null ? null : 0)),
    sun_visible_fraction: frac, sun_visible: frac.map((f) => (f === null ? null : f > 0)),
    earth_elevation_deg: Array(n).fill(5), earth_azimuth_deg: Array(n).fill(0), earth_horizon_deg: Array(n).fill(0),
    earth_visible: Array(n).fill(true), incidence_factor: frac, ...opts,
  }
}
const withTimeline = (tl: TimelineColumns, extra: Partial<CompareResult> = {}) => entry('B', (r) => ({ ...r, timeline: tl, ...extra }))

describe('sampling and charts', () => {
  it('known sunlight / unknown / known sunlight: the chart line breaks, it is not connected through', () => {
    const e = withTimeline(columns([1, null, 1]))
    const rows = mergeSeries([e], (tl, i) => tl.sun_visible_fraction[i], [0, 3])
    expect(rows.map((r) => r[e.scenario.id])).toEqual([1, null, 1])
  })

  it('genuine zero illumination stays 0 in chart rows (a measurement), unknown stays null', () => {
    const e = withTimeline(columns([0, 0, null]))
    expect(mergeSeries([e], (tl, i) => tl.sun_visible_fraction[i], [0, 3]).map((r) => r[e.scenario.id])).toEqual([0, 0, null])
  })

  it('thinning chart rows never hides a short unknown interval', () => {
    const frac = Array.from({ length: 100 }, (_, i) => (i === 37 ? null : 1))
    const e = withTimeline(columns(frac))
    const rows = mergeSeries([e], (tl, i) => tl.sun_visible_fraction[i], [0, 100], 10)
    expect(rows.length).toBeLessThanOrEqual(10)
    expect(rows.some((r) => r[e.scenario.id] === null)).toBe(true)
  })

  it('scenarios on different grids: each holds its own sample between its points (sample-and-hold), never extrapolated', () => {
    const a = withTimeline(columns([1, 0, 1]))
    const b = { ...withTimeline(columns([0.5, 0.5])), scenario: { ...a.scenario, id: 'other' }, offsetHours: 0.5 }
    const rows = mergeSeries([a, b], (tl, i) => tl.sun_visible_fraction[i], [0, 3])
    expect(rows.map((r) => [r.x, r[a.scenario.id], r.other])).toEqual([[0, 1, undefined], [0.5, 1, 0.5], [1, 0, 0.5], [1.5, 0, 0.5], [2, 1, 0.5]])
  })

  it('sampleIndex is sample-and-hold: 00:45 shows the 00:00 sample, and a landing between samples starts at hour < 0', () => {
    const tl = columns([1, 0, 1])
    expect(sampleIndex(tl, 0.75)).toBe(0)
    expect(sampleIndex(tl, 1)).toBe(1)
    expect(sampleIndex(tl, 3)).toBeNull() // past the last sample's hour
    const off = { ...tl, hour: [-0.25, 0.75, 1.75] } // landing at 00:15
    expect(sampleIndex(off, 0)).toBe(0)
    expect(sampleIndex(off, 0.8)).toBe(1)
  })

  it('conditions at a moment: the held sample, the selected time, unknown and a visible sliver explained', () => {
    const tl = columns([0, null, 0], { sun_visible: [false, null, true] })
    const e = withTimeline(tl)
    const c0 = conditionsAt(e, 0.5)!
    expect(c0).toMatchObject({ index: 0, met: 0, selectedMet: 0.5, held: true })
    expect(c0.sunReason).toMatch(/^Dark/)
    expect(conditionsAt(e, 1)!.sunReason).toMatch(/^Unknown.*not darkness/)
    expect(conditionsAt(e, 2)!.sunReason).toMatch(/sliver.*not darkness/)
  })

  it('a visible sliver rounded to 0 is drawn as (a little) light, not darkness; unknown draws nothing', () => {
    const x = (v: number) => v * 10
    expect(sunPath(columns([0], { sun_visible: [true] }), 0, x, [0, 1], 0, 1)).not.toBe('')
    expect(sunPath(columns([0], { sun_visible: [false] }), 0, x, [0, 1], 0, 1)).toBe('')
    expect(sunPath(columns([null]), 0, x, [0, 1], 0, 1)).toBe('')
  })

  it('the Sun lane covers [t, t + 1 h) per sample, clipped to the mission', () => {
    const x = (v: number) => v * 10
    const path = sunPath({ ...columns([1, 1]), hour: [-0.25, 0.75] }, 0, x, [0, 2], 0, 1.5)
    expect(path).toContain('M0.0,') // starts at landing (hour 0), not at the -0.25 h sample
    expect(path).toContain('15.0,') // ends at the mission end (1.5 h), not at 1.75 h
  })
})

describe('availability lanes', () => {
  const win = (kind: string, a: number, b: number): Window => ({
    kind, start_hour: a, end_hour: b, duration_hours: b - a, open_start: a === 0, open_end: false,
    start_utc: new Date(Date.UTC(2027, 0, 15, a)).toISOString(), end_utc: new Date(Date.UTC(2027, 0, 15, b)).toISOString(),
  })

  it('unknown at mission start, an internal gap and darkness on both sides get a labelled unknown band, not darkness', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const e = entry('B', (r) => ({
      ...r, evaluated_hours: 168,
      unknown_windows: [win('sun_unknown', 0, 3), win('sun_unknown', 50, 52), win('earth_unknown', 50, 52)],
      dark_windows: [win('darkness', 40, 50), win('darkness', 52, 60)],
    }))
    const html = renderToString(<SyncTimeline entries={[e]} full={[0, 168]} view={[0, 168]} align="met" originMs={Date.UTC(2027, 0, 15)} />)
    expect((html.match(/<title>(Sun|Earth) unknown /g) ?? []).length).toBe(3) // each unknown window is its own labelled band
    expect(html).toMatch(/Sun unknown 3 h: .*not darkness/)
    expect(html).toMatch(/Earth unknown 2 h: .*not a blackout/)
    expect(html).toContain('hatch-unknown')
    vi.unstubAllGlobals()
  })

  it('demonstration (synthetic) data stays separate from real data', () => {
    const demo = entry('B', (r) => ({ ...r, data_kind: 'demonstration' }), 'Z' as 'B')
    const es = [entry('A'), entry('C'), demo]
    expect(bestIds(es, METRIC_BY_ID.earth_pct).has(demo.scenario.id)).toBe(false)
    expect(buildSummary(es).caveats.join(' ')).toMatch(/Scenario Z use demonstration data/)
  })
})

describe('dataset identity and coverage fields reach the display', () => {
  it('shows the dataset file and a shortened SHA-256 on the card, and nothing when the result has none', () => {
    const withId = entry('B', (r) => ({ ...r, dataset_file: 'malapert-massif.json', dataset_sha256: 'ab'.repeat(32) }))
    const html = renderToString(<OverviewCards entries={[withId]} />).replace(/<!-- -->/g, '')
    expect(html).toContain('Data file malapert-massif.json · SHA-256 abababababab…')
    expect(html).toContain(`SHA-256 ${'ab'.repeat(32)}`) // full hash in the tooltip
    const none = renderToString(<OverviewCards entries={[entry('B')]} />)
    expect(none).not.toContain('dataset-identity')
  })

  it('names the withheld blocks next to the coverage hours', () => {
    const b = entry('B', (r) => earthIncomplete(sunIncomplete(r)))
    const html = renderToString(<OverviewCards entries={[b]} />).replace(/<!-- -->/g, '')
    expect(html).toContain('Withheld: solar, power, earth.')
  })
})
