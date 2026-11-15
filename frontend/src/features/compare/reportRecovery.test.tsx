// Frozen report recovery: requested vs evaluated time, dataset identity, bounds and nulls, UNKNOWN vs FAIL vs PASS,
// mission-input changes while a report is open, regeneration, and report / export parity from one snapshot.
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import fixture from './__fixtures__/compare-response.json'
import { toCsv } from './export'
import { cannotGenerate, selectionKeyOf, useReportStore } from './report'
import { ReportDocument } from './ReportPreview'
import { makeScenario, resultKey, selectionKey } from './scenario'
import type { ComparisonScenario, CompareResponse, CompareResult, ResultState } from './types'
import { useCompareStore } from './useCompareStore'

const res = fixture as unknown as CompareResponse
const SHA = 'ab'.repeat(32)
const MAL = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }
const PNS = { id: 'peak-near-shackleton', name: 'Peak Near Shackleton', lat: -89.01701, lon: 126.27302 }
const CR = { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767 }
const INPUT: Record<string, { site: typeof MAL; landing_utc: string; duration_days: number }> = {
  A: { site: PNS, landing_utc: '2027-01-15T00:15:00Z', duration_days: 7.5 }, // requested off the hourly grid
  B: { site: MAL, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 },
  C: { site: CR, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 },
  D: { site: MAL, landing_utc: '2035-01-15T00:00:00Z', duration_days: 7 },
}
const plain = (h: string) => h.replace(/<!-- -->/g, '')

/** The fixture's real results, plus the evaluated window and dataset identity a current backend returns. */
function resultFor(k: string): CompareResult {
  const r = structuredClone(res.results.find((x) => x.key === k)!) as CompareResult
  if (r.status !== 'ok') return r
  if (k === 'A') Object.assign(r, { evaluated_landing_utc: '2027-01-15T00:00:00Z', evaluated_duration_days: 7.5, evaluated_start_utc: '2027-01-15T00:00:00Z', evaluated_end_utc: '2027-01-22T12:00:00Z', evaluated_hours: 180, time_note: 'Landing 00:15 evaluated at 00:00 (hourly grid).' })
  else Object.assign(r, { evaluated_landing_utc: INPUT[k].landing_utc, evaluated_duration_days: INPUT[k].duration_days })
  if (r.data_kind === 'real') Object.assign(r, { dataset_file: `${INPUT[k].site.id}.json`, dataset_sha256: SHA })
  return r
}

function load(keys: string[], mutate: (k: string, r: CompareResult) => CompareResult = (_, r) => r) {
  const scenarios = keys.map((k, i) => ({ ...makeScenario({ ...INPUT[k] }, []), id: `s-${k}`, label: k, colorSlot: i, name: `Plan ${k}` })) as ComparisonScenario[]
  const results: Record<string, ResultState> = {}
  for (const s of scenarios) results[resultKey(s, false)] = { state: 'done', result: mutate(s.label, resultFor(s.label)) }
  useCompareStore.setState({
    scenarios, selectedIds: scenarios.map((s) => s.id), results, allowDemo: false, baselineId: scenarios[0].id,
    rankingGroups: res.ranking_groups.filter((g) => g.keys.some((k) => keys.includes(k))), rankingPairs: res.pairwise,
    rankingSetKey: selectionKey(scenarios, false), rescueContext: null, notes: res.notes,
  })
  return scenarios
}
const generate = () => { expect(useReportStore.getState().generate()).toEqual({ ok: true }); return useReportStore.getState().snapshot! }

beforeEach(() => useReportStore.setState({ snapshot: null, open: false }))

describe('requested versus evaluated mission time', () => {
  it('the report names the request and the evaluated window separately, and never swaps them', () => {
    load(['A', 'B'])
    const s = generate()
    const a = s.export.scenarios.find((x) => x.label === 'A')!
    expect(a.mission_time).toMatchObject({ evaluation_status: 'evaluated', requested_landing_utc: '2027-01-15T00:15:00.000Z', evaluated_landing_utc: '2027-01-15T00:00:00.000Z', time_adjusted: true })
    const html = plain(renderToString(<ReportDocument s={s} />))
    expect(html).toContain('2027-01-15 00:00 UTC')
    expect(html).toMatch(/requested 2027-01-15 00:15 UTC/)
    expect(html).toContain('Landing 00:15 evaluated at 00:00 (hourly grid).')
    expect(html).toMatch(/Requested<\/th>/)
    expect(html).toMatch(/Evaluated<\/th>/)
  })

  it('without an evaluated window the report says so; the request is never presented as evaluated', () => {
    load(['A'], (_, r) => ({ ...r, evaluated_landing_utc: null, evaluated_duration_days: null }))
    const s = generate()
    const row = s.scenarios[0]
    expect(row.mission_time.evaluated_landing_utc).toBeNull()
    const html = plain(renderToString(<ReportDocument s={s} />))
    expect(html).toMatch(/not evaluated/)
    expect(html).toContain('none is substituted from the request')
  })
})

describe('dataset identity, nulls and bounds', () => {
  it('records file and SHA-256 and shows them in the report; a missing hash is stated, not invented', () => {
    load(['B', 'C'], (k, r) => (k === 'C' ? { ...r, dataset_sha256: null } : r))
    const s = generate()
    expect(s.export.reproduction.datasets.some((d) => d.sha256 === SHA && d.file === 'malapert-massif.json')).toBe(true)
    const html = plain(renderToString(<ReportDocument s={s} />))
    expect(html).toContain(SHA)
    expect(html).toContain('SHA-256 unavailable')
  })

  it('a bounded score is exported and printed as bounds, never as a precise score', () => {
    load(['B', 'C'], (k, r) => (k === 'C' && r.ranking ? { ...r, ranking: { ...r.ranking, score_status: 'bounded', score: null, score_lower: 80, score_upper: 90 } as typeof r.ranking } : r))
    const s = generate()
    const c = s.export.scenarios.find((x) => x.label === 'C')!
    expect(c.score).toMatchObject({ status: 'bounded', exact: null, lower: 80, upper: 90 })
    expect(plain(renderToString(<ReportDocument s={s} />))).toContain('80.0 – 90.0 (bounds)')
  })
})

describe('UNKNOWN, FAIL and PASS stay distinct', () => {
  it('the unassessed plan is UNKNOWN (null verdict), not FAIL, in the rows, the JSON and the CSV', () => {
    load(['A', 'B', 'D'])
    const s = generate()
    const verdict = (l: string) => s.scenarios.find((r) => r.label === l)!.verdict
    expect(verdict('B')).toBe('pass')
    expect(verdict('A')).toBe('fail')
    expect(verdict('D')).toBeNull()
    const d = s.export.scenarios.find((x) => x.label === 'D')!
    expect(d.eligibility).toBe('unknown')
    expect(d.canonical_rank).toBeNull()
    const html = plain(renderToString(<ReportDocument s={s} />))
    expect(html).toMatch(/Not assessed/)
    const csv = toCsv(s.export).split('\r\n')
    const col = csv[0].split(',').indexOf('eligibility')
    expect(csv.slice(1).filter(Boolean).map((r) => r.split(',')[col]).sort()).toEqual(['fail', 'pass', 'unknown'])
  })

  it('no recommendation when the only passing plans cannot be told apart, or none passes', () => {
    load(['A'])
    const s = generate()
    expect(s.decisions.every((d) => d.recommended === null)).toBe(true)
  })
})

describe('frozen while the workspace changes, then regenerated', () => {
  it('mission inputs, selection and rankings changing under an open report do not alter it; regenerate picks them up', () => {
    load(['B', 'C'])
    const snap = generate()
    const before = JSON.stringify(snap)
    const key = snap.selection.key
    const st = useCompareStore.getState()
    st.updateScenario('s-B', { landing_utc: '2027-02-01T00:00:00Z', duration_days: 3 })
    useCompareStore.setState({ rankingGroups: [], rankingPairs: [], rankingSetKey: null })
    expect(selectionKeyOf(useCompareStore.getState())).not.toBe(key)
    expect(cannotGenerate()).toBeTruthy() // the ranking is stale: regeneration is refused, the snapshot is untouched
    expect(JSON.stringify(useReportStore.getState().snapshot)).toBe(before)
    expect(plain(renderToString(<ReportDocument s={useReportStore.getState().snapshot!} />))).toContain('2027-01-15 00:00 UTC')

    load(['B'])
    const regenerated = generate()
    expect(regenerated.snapshot_id).not.toBe(snap.snapshot_id)
    expect(regenerated.selection.labels).toEqual(['B'])
    expect(JSON.stringify(snap)).toBe(before) // the old snapshot object itself is still intact
  })

  it('a loading or failed selection cannot be frozen', () => {
    const sc = load(['B', 'C'])
    useCompareStore.setState({ results: { ...useCompareStore.getState().results, [resultKey(sc[0], false)]: { state: 'loading' } as ResultState } })
    expect(cannotGenerate()).toMatch(/loading|assess/i)
    expect(useReportStore.getState().generate()).toMatchObject({ ok: false })
    expect(useReportStore.getState().snapshot).toBeNull()
  })
})

describe('report and export parity, and backward compatibility', () => {
  it('the printed report and the structured export are the same frozen snapshot', () => {
    load(['A', 'B', 'C', 'D'])
    const s = generate()
    expect(s.export.snapshot_id).toBe(s.snapshot_id)
    expect(s.export.selection_key).toBe(s.selection.key)
    const html = plain(renderToString(<ReportDocument s={s} />))
    for (const sc of s.export.scenarios) {
      expect(html).toContain(`Plan ${sc.label}`)
      const row = s.scenarios.find((r) => r.label === sc.label)!
      expect(row.mission_time).toEqual(sc.mission_time)
      expect(row.verdict).toBe(sc.assessed ? sc.eligibility : null)
    }
    for (const g of s.export.ranking_groups) expect(s.decisions.some((d) => d.id === g.id)).toBe(true)
    // The report is the frozen copy: the export inside it equals the JSON a consumer downloads.
    expect(JSON.parse(JSON.stringify(s)).export.scenarios.map((x: { label: string }) => x.label)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('stays comparison-export-v1: every v1 field and CSV column keeps its place, new ones are appended', () => {
    load(['B', 'C'])
    const s = generate()
    expect(s.export.format).toBe('comparison-export-v1')
    expect(s.export.schema_revision).toBe(2)
    const b = s.export.scenarios[0]
    for (const f of ['label', 'name', 'site', 'landing_utc', 'duration_days', 'requirements', 'spacecraft', 'data', 'eligibility', 'canonical_rank', 'score', 'metrics', 'requirement_verdicts']) expect(b).toHaveProperty(f)
    expect(b.landing_utc).toBe('2027-01-15T00:00:00.000Z') // still the REQUESTED value
    const head = toCsv(s.export).split('\r\n')[0].split(',')
    expect(head.slice(0, 8)).toEqual(['label', 'name', 'site_id', 'site_name', 'lat', 'lon', 'landing_utc', 'duration_days'])
    expect(head.slice(8, 9)).toEqual(['data_kind'])
    expect(head.indexOf('evaluated_landing_utc')).toBeGreaterThan(head.indexOf('screening_note'))
  })
})
