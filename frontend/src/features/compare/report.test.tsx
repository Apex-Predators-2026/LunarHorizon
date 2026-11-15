// Summary report: a frozen, detached snapshot of the evaluated comparison. Real fixture (canonical engine, 7-day
// missions from 2027-01-15): A Peak Near Shackleton FAIL · B Malapert PASS #1 · C Connecting Ridge PASS #2 · D no data
// (UNKNOWN, not assessed) · E Malapert 3-day PASS in separate group G2.
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import fixture from './__fixtures__/compare-response.json'
import { toCsv } from './export'
import { cannotGenerate, REPORT_FORMAT, selectionKeyOf, useReportStore } from './report'
import { ReportDocument } from './ReportPreview'
import { makeScenario, resultKey, selectionKey } from './scenario'
import type { ComparisonScenario, CompareResponse, ResultState } from './types'
import { useCompareStore } from './useCompareStore'

const res = fixture as unknown as CompareResponse
const PNS = { id: 'peak-near-shackleton', name: 'Peak Near Shackleton', lat: -89.01701, lon: 126.27302 }
const MAL = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }
const CR = { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767 }
// The fixture's own inputs, so every scenario has its own result key.
const INPUT: Record<string, { site: typeof MAL; landing_utc: string; duration_days: number }> = {
  A: { site: PNS, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 },
  B: { site: MAL, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 },
  C: { site: CR, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 },
  D: { site: MAL, landing_utc: '2035-01-15T00:00:00Z', duration_days: 7 },
  E: { site: MAL, landing_utc: '2027-01-15T00:00:00Z', duration_days: 3 },
}
const plain = (h: string) => h.replace(/<!-- -->/g, '')
/** A small RFC 4180 reader (quoted cells may contain commas, quotes and line breaks). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false; else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === String.fromCharCode(13)) continue
    else if (ch === String.fromCharCode(10)) { row.push(cur); rows.push(row); row = []; cur = '' }
    else cur += ch
  }
  return rows
}

/** Put fixture results into the live comparison store under the keys the store itself would use. */
function load(keys: string[], over: Partial<Record<string, Partial<ComparisonScenario>>> = {}) {
  const scenarios = keys.map((k, i) => ({ ...makeScenario({ ...INPUT[k] }, []), id: `s-${k}`, label: k, colorSlot: i, name: `Plan ${k}`, ...over[k] }))
  const results: Record<string, ResultState> = {}
  for (const s of scenarios) {
    const r = res.results.find((x) => x.key === s.label)!
    results[resultKey(s, false)] = { state: 'done', result: r }
  }
  useCompareStore.setState({
    scenarios, selectedIds: scenarios.map((s) => s.id), results, allowDemo: false, baselineId: scenarios[0].id,
    // The backend returns groups for the selected set only.
    rankingGroups: res.ranking_groups.filter((g) => g.keys.some((k) => keys.includes(k))), rankingPairs: res.pairwise, rankingSetKey: selectionKey(scenarios, false), rescueContext: null, notes: res.notes,
  })
  return scenarios
}

beforeEach(() => useReportStore.setState({ snapshot: null, open: false }))

describe('summary report snapshot', () => {
  it('captures the evaluated selection as an immutable, detached snapshot that live edits cannot change', () => {
    load(['A', 'B', 'C'])
    expect(useReportStore.getState().generate()).toEqual({ ok: true })
    const snap = useReportStore.getState().snapshot!
    expect(snap.report_format).toBe(REPORT_FORMAT)
    expect(Object.isFrozen(snap) && Object.isFrozen(snap.export.scenarios[0])).toBe(true)
    expect(() => { (snap.scenarios as unknown as unknown[]).push(1) }).toThrow()
    expect(snap.selection.labels).toEqual(['A', 'B', 'C'])
    // Live edit after generation: the open report keeps the snapshot, and is flagged as out of date.
    useCompareStore.getState().updateScenario('s-B', { name: 'Renamed', duration_days: 10 })
    expect(snap.export.scenarios[1].name).toBe('Plan B')
    expect(snap.export.scenarios[1].duration_days).toBe(7)
    expect(selectionKeyOf(useCompareStore.getState())).not.toBe(snap.selection.key)
  })

  it('regeneration uses the new selection', () => {
    load(['A', 'B', 'C'])
    useReportStore.getState().generate()
    const first = useReportStore.getState().snapshot!
    useCompareStore.getState().setSelected(['s-B', 's-C'])
    useCompareStore.setState({ rankingSetKey: selectionKey(useCompareStore.getState().scenarios.filter((s) => ['s-B', 's-C'].includes(s.id)), false) })
    useReportStore.getState().generate()
    const second = useReportStore.getState().snapshot!
    expect(second.selection.labels).toEqual(['B', 'C'])
    expect(second.snapshot_id).not.toBe(first.snapshot_id)
  })

  it('refuses to generate from nothing, from loading results or from a stale ranking', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    expect(cannotGenerate()).toMatch(/Select at least one scenario/)
    const sc = load(['B'])
    useCompareStore.setState({ results: { [resultKey(sc[0], false)]: { state: 'loading' } } })
    expect(cannotGenerate()).toMatch(/Wait until every selected scenario has been assessed/)
    load(['B', 'C'])
    useCompareStore.setState({ rankingSetKey: 'other' })
    expect(cannotGenerate()).toMatch(/ranking is being updated/)
    expect(useReportStore.getState().generate().ok).toBe(false)
  })

  it('one scenario; missing data and UNKNOWN are described, never treated as evaluated', () => {
    load(['B'])
    useReportStore.getState().generate()
    expect(useReportStore.getState().snapshot!.decisions[0].kind).toBe('lone')
    load(['A', 'B', 'D'])
    useReportStore.getState().generate()
    const s = useReportStore.getState().snapshot!
    const d = s.scenarios.find((x) => x.label === 'D')!
    expect(d.verdict).toBeNull()
    expect(d.status_text).toMatch(/^Not assessed/)
    expect(s.unassessed.map((u) => u.label)).toEqual(['D'])
    const xd = s.export.scenarios.find((x) => x.label === 'D')!
    expect(xd.assessed).toBe(false)
    expect(xd.metrics.longest_blackout_h).toEqual({ status: 'missing', unit: null, value: null, lower: null, upper: null })
    const html = plain(renderToString(<ReportDocument s={s} />))
    expect(html).toContain('NOT ASSESSED')
    expect(html).not.toContain('NaN')
  })

  it('the CSV and the JSON of a frozen snapshot are two views of the same evaluated results', () => {
    load(['A', 'B', 'C', 'D'])
    useReportStore.getState().generate()
    const s = useReportStore.getState().snapshot!
    const json = JSON.parse(JSON.stringify(s.export)) // what the report's JSON download contains
    // Serialising and parsing the snapshot loses nothing the CSV shows: the CSV of the parsed JSON is identical.
    expect(toCsv(json)).toBe(toCsv(s.export))
    const [head, ...rows] = parseCsv(toCsv(json))
    const col = (name: string) => head.indexOf(name)
    expect(rows).toHaveLength(json.scenarios.length)
    for (const [i, x] of json.scenarios.entries()) {
      expect(rows[i][col('label')]).toBe(x.label)
      expect(rows[i][col('eligibility')]).toBe(x.eligibility ?? 'not_assessed')
      expect(rows[i][col('canonical_rank')]).toBe(x.canonical_rank === null ? '' : String(x.canonical_rank))
      // The requested time and the evaluated time stay separate columns and carry the snapshot's own values.
      expect(rows[i][col('requested_landing_utc')]).toBe(x.mission_time.requested_landing_utc ?? '')
      expect(rows[i][col('evaluated_landing_utc')]).toBe(x.mission_time.evaluated_landing_utc ?? '')
      expect(rows[i][col('evaluation_status')]).toBe(x.mission_time.evaluation_status)
    }
    // UNKNOWN / unassessed D is still not a PASS or a FAIL, and has no rank, in both files.
    const d = rows[json.scenarios.findIndex((x: { label: string }) => x.label === 'D')]
    expect(d[col('eligibility')]).toBe('unknown')
    expect(d[col('canonical_rank')]).toBe('')
  })

  it('the printed sources say Gracy & Lee located two sites and validated nothing', () => {
    load(['A', 'B'])
    useReportStore.getState().generate()
    const html = plain(renderToString(<ReportDocument s={useReportStore.getState().snapshot!} />))
    expect(html).toMatch(/Gracy &amp; Lee, LPSC 2024: source of the Connecting Ridge and Peak Near Shackleton coordinates\. It locates those two sites; it is not a validation of this model\./)
    expect(html).not.toMatch(/Validation reference/)
  })

  it('separate comparability groups get group-specific conclusions', () => {
    load(['B', 'C', 'E'])
    useReportStore.getState().generate()
    const s = useReportStore.getState().snapshot!
    expect(s.decisions.map((d) => d.id)).toEqual(['G1', 'G2'])
    expect(s.decisions[0].recommended).toBe('B')
    expect(s.decisions[1].recommended).toBeNull() // "lone" in its group: not a comparison winner
    const html = plain(renderToString(<ReportDocument s={s} />))
    expect(html).toContain('group G2')
  })

  it('the human-readable report and the JSON describe the same evaluated results', () => {
    load(['A', 'B', 'C'])
    useReportStore.getState().generate()
    const s = useReportStore.getState().snapshot!
    const json = JSON.parse(JSON.stringify(s))
    expect(json.export.snapshot_id).toBe(s.snapshot_id)
    expect(json.export.selection_key).toBe(s.selection.key)
    for (const row of s.scenarios) {
      const x = json.export.scenarios.find((e: { label: string }) => e.label === row.label)
      expect(x.eligibility ?? null).toBe(row.verdict)
      expect(x.revision).toBe(s.selection.revisions[s.selection.labels.indexOf(row.label)])
    }
    expect(json.export.reproduction.inputs).toHaveLength(3)
    expect(json.export.reproduction.versions.engine.length).toBeGreaterThan(0)
    expect(json.export.preferences.note).toMatch(/not used for eligibility/)
    const html = plain(renderToString(<ReportDocument s={s} />))
    expect(html).toContain('Mission decision summary')
    expect(s.decisions[0]).toMatchObject({ kind: 'recommended', recommended: 'B' })
    expect(html).toContain('Recommended · Scenario B')
    expect(html).toContain('2027-01-15 00:00 UTC')
    expect(html).toContain('NASA JPL Horizons')
    expect(html).toContain('not a probability of success')
  })

  it('long names and notes are text, never markup', () => {
    const evil = '<img src=x onerror=alert(1)> ' + 'Very long scenario name '.repeat(12)
    load(['B', 'C'], { B: { name: evil, notes: '<script>alert(2)</script>' } })
    useReportStore.getState().generate()
    const html = renderToString(<ReportDocument s={useReportStore.getState().snapshot!} />)
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(html).toContain('rpt-wrap')
  })
})
