// Mission Report Card content: built from the frozen report snapshot, with the comparison's integrity rules.
// Fixture: A Peak Near Shackleton FAIL · B Malapert PASS #1 · C Connecting Ridge PASS #2 · D no data (UNKNOWN) ·
// E Malapert 3-day PASS in a separate group (G2).
import { beforeEach, describe, expect, it } from 'vitest'

import fixture from './__fixtures__/compare-response.json'
import { useReportStore, type ReportSnapshot } from './report'
import { DISCLAIMER, REPORT_TITLE, buildReportCard, valueOf } from './reportCard'
import { makeScenario, resultKey, selectionKey } from './scenario'
import type { CompareResponse, ResultState } from './types'
import { useCompareStore } from './useCompareStore'

const res = fixture as unknown as CompareResponse
const MAL = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }
const INPUT = {
  A: { site: { id: 'peak-near-shackleton', name: 'Peak Near Shackleton', lat: -89.01701, lon: 126.27302 }, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 },
  B: { site: MAL, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 },
  C: { site: { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767 }, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 },
  D: { site: MAL, landing_utc: '2035-01-15T00:00:00Z', duration_days: 7 },
  E: { site: MAL, landing_utc: '2027-01-15T00:00:00Z', duration_days: 3 },
} as const
type K = keyof typeof INPUT

function snapshot(keys: K[]): ReportSnapshot {
  const scenarios = keys.map((k, i) => ({ ...makeScenario({ ...INPUT[k] }, []), id: `s-${k}`, label: k, colorSlot: i, name: `Plan ${k}` }))
  const results: Record<string, ResultState> = {}
  for (const s of scenarios) results[resultKey(s, false)] = { state: 'done', result: res.results.find((x) => x.key === s.label)! }
  useCompareStore.setState({
    scenarios, selectedIds: scenarios.map((s) => s.id), results, allowDemo: false, baselineId: scenarios[0].id,
    rankingGroups: res.ranking_groups.filter((g) => g.keys.some((k) => keys.includes(k as K))), rankingPairs: res.pairwise,
    rankingSetKey: selectionKey(scenarios, false), rescueContext: null, notes: res.notes,
  })
  expect(useReportStore.getState().generate()).toEqual({ ok: true })
  return useReportStore.getState().snapshot!
}

beforeEach(() => useReportStore.setState({ snapshot: null, open: false }))

describe('Mission Report Card', () => {
  it('identifies the report and the snapshot it was built from', () => {
    const s = snapshot(['A', 'B', 'C', 'D'])
    const c = buildReportCard(s)
    expect(c.title).toBe(REPORT_TITLE)
    expect(c.snapshot_id).toBe(s.snapshot_id)
    expect(c.generated_at).toBe(s.generated_at)
    expect(c.labels).toEqual(['A', 'B', 'C', 'D'])
  })

  it('keeps the statuses, eligibility and canonical ranks of the snapshot: ranks for eligible PASS plans only', () => {
    const c = buildReportCard(snapshot(['A', 'B', 'C', 'D']))
    const p = Object.fromEntries(c.plans.map((x) => [x.label, x]))
    expect([p.A.status, p.B.status, p.C.status, p.D.status]).toEqual(['FAIL', 'PASS', 'PASS', 'UNKNOWN'])
    expect([p.B.rank, p.C.rank]).toEqual(['Rank 1 in group G1', 'Rank 2 in group G1'])
    expect(p.A.rank).not.toMatch(/^Rank \d/)
    expect(p.D.rank).not.toMatch(/^Rank \d/)
    expect(p.A.eligibility).toBe('Ineligible: fails a requirement')
    expect(p.D.eligibility).toBe('Ineligible: undecided (UNKNOWN)')
    expect(p.B.eligibility).toBe('Eligible (ranked)')
  })

  it('never counts UNKNOWN as a failure', () => {
    const c = buildReportCard(snapshot(['A', 'B', 'C', 'D']))
    expect(c.final.categories).toEqual({ eligible_pass: ['B', 'C'], fail: ['A'], unknown: ['D'], not_assessed: [] })
    expect(c.executive_summary).toMatch(/Plan D cannot be decided from the data \(UNKNOWN, not a failure\)/)
    expect(c.executive_summary).not.toMatch(/Plan D fails/)
    for (const w of c.strengths.find((x) => x.label === 'D')!.weaknesses) expect(w).not.toMatch(/\bFails\b/)
  })

  it('shows missing measurements as Unavailable or Not assessed, never as 0, and bounds as ranges', () => {
    expect(valueOf({ status: 'missing', unit: null, value: null, lower: null, upper: null }).text).toBe('Unavailable')
    expect(valueOf({ status: 'unavailable', unit: 'h', value: null, lower: null, upper: null }).text).toBe('Unavailable')
    expect(valueOf({ status: 'bounded', unit: 'h', value: null, lower: 12, upper: 30 }).text).toBe('between 12 h and 30 h')
    expect(valueOf({ status: 'known', unit: 'fraction', value: 0.956, lower: null, upper: null }).text).toBe('95.6%')
    expect(valueOf(null, false).text).toBe('Not assessed')
    const s = snapshot(['A', 'B', 'C', 'D'])
    const c = buildReportCard(s)
    for (const row of [...c.performance.solar, ...c.performance.communication]) {
      expect(row.values.D.text).toBe('Not assessed')
      for (const l of ['A', 'B', 'C']) {
        const metricKey = { disk: 'mean_solar_disk_fraction', dark: 'longest_power_darkness_h', blackout: 'longest_blackout_h' }[row.id as 'disk']
        if (!metricKey) continue
        const m = s.export.scenarios.find((x) => x.label === l)!.metrics[metricKey]
        if (m.status !== 'known') expect(row.values[l].text).not.toMatch(/^0/)
      }
    }
    // A metric the engine could not measure stays unavailable in the card.
    const edited = structuredClone(s) as ReportSnapshot
    const b = edited.export.scenarios.find((x) => x.label === 'B')!
    b.metrics.longest_blackout_h = { status: 'unavailable', unit: 'h', value: null, lower: null, upper: null }
    const row = buildReportCard(edited).performance.communication.find((r) => r.id === 'blackout')!
    expect(row.values.B).toEqual({ text: 'Unavailable', kind: 'unavailable' })
  })

  it('assesses every configured requirement per plan, with measured value, limit and margin', () => {
    const c = buildReportCard(snapshot(['A', 'B', 'C', 'D']))
    const disk = c.requirements.rows.find((r) => r.id === 'min_mean_solar_disk_fraction')!
    expect(disk.limit).toBe('≥ 50.0%')
    expect(disk.cells.A).toMatchObject({ status: 'FAIL', measured: '36.8%', margin: '-13.2%' })
    expect(disk.cells.B).toMatchObject({ status: 'PASS', measured: '95.6%' })
    expect(disk.cells.D.status).toBe('NOT ASSESSED')
    expect(c.requirements.rows.some((r) => r.id === 'min_sunlight_percent')).toBe(false) // not configured for anyone
    const dark = c.requirements.rows.find((r) => r.id === 'max_continuous_darkness')!
    expect(dark.cells.A.margin).toMatch(/\(narrow\)$/)
  })

  it('compares the plans only where the evidence allows it', () => {
    const c = buildReportCard(snapshot(['A', 'B', 'C', 'D']))
    const f = Object.fromEntries(c.analysis.findings.map((x) => [x.topic, x.text]))
    expect(f.Sunlight).toMatch(/^Plan B has the most sunlight \(Mean visible solar disk: A 36\.8%; B 95\.6%; C 76\.1%; D Not assessed\)/)
    expect(f['Earth visibility']).toMatch(/^No meaningful difference/)
    expect(f.Requirements).toMatch(/Plan A fails minimum mean visible solar-disk fraction/)
    expect(c.analysis.tradeoffs.length).toBeGreaterThan(0)
    const disk = c.performance.solar.find((r) => r.id === 'disk')!
    expect(disk.best).toEqual(['B'])
  })

  it('never marks a "best" when only one plan uses real data: demonstration plans never compete with real ones', () => {
    const s = structuredClone(snapshot(['A', 'B', 'C']))
    for (const e of s.export.scenarios) if (e.label !== 'A') e.data = { ...e.data, kind: 'demonstration', is_synthetic: true }
    const c = buildReportCard(s)
    for (const row of [...c.performance.solar, ...c.performance.communication]) expect(row.best).toEqual([])
    expect(c.analysis.findings.find((x) => x.topic === 'Sunlight')!.text).not.toMatch(/has the most/)
  })

  it('never marks a "best" across plans with different mission durations', () => {
    const c = buildReportCard(snapshot(['B', 'E'])) // both real, 7 d vs 3 d
    for (const row of [...c.performance.solar, ...c.performance.communication]) expect(row.best).toEqual([])
  })

  it('lists strengths and weaknesses from the evidence only', () => {
    const c = buildReportCard(snapshot(['A', 'B', 'C', 'D']))
    const sw = Object.fromEntries(c.strengths.map((x) => [x.label, x]))
    expect(sw.B.strengths[0]).toBe('Meets every requirement (6 of 6)')
    expect(sw.B.strengths).toContain('Best of the compared plans on Mean visible solar disk: 95.6%')
    expect(sw.B.strengths.length).toBeLessThanOrEqual(5)
    expect(sw.A.strengths[0]).toBe('Meets 5 of 6 requirements')
    expect(sw.A.weaknesses[0]).toMatch(/^Fails Minimum mean visible solar-disk fraction \(36\.8%, limit ≥ 50\.0%, margin -13\.2%\)/)
    expect(sw.A.weaknesses.some((w) => w.startsWith('Narrow margin on Maximum continuous power-darkness'))).toBe(true)
    expect(sw.D.weaknesses).toEqual(['Not assessed: no data for this site and date range, so nothing can be stated about it.'])
    // A and B both start dark (0 h of sunlight after landing): both are named, not just the first.
    for (const l of ['A', 'B']) expect(sw[l].weaknesses).toContain('Weakest of the compared plans on Continuous sunlight after landing: 0 h')
  })

  it('makes an evidence-backed final assessment and never manufactures a winner', () => {
    const c = buildReportCard(snapshot(['A', 'B', 'C']))
    expect(c.final.groups[0]).toMatchObject({ outcome: 'recommended', recommended: 'B' })
    expect(c.final.conclusion).toMatch(/Plan B is the most suitable plan/)
    const lone = buildReportCard(snapshot(['A']))
    expect(lone.final.groups.every((g) => g.recommended === null)).toBe(true)
    expect(lone.final.conclusion).toMatch(/^No eligible passing recommendation is available/)
    const split = buildReportCard(snapshot(['B', 'E']))
    expect(split.final.groups.length).toBe(2)
    expect(split.final.separate_groups_note).toMatch(/not ranked against each other/)
    const none = buildReportCard(snapshot(['D']))
    expect(none.final.conclusion).toMatch(/cannot|No plan has a canonical assessment/)
    expect(none.final.groups.every((g) => g.recommended === null)).toBe(true)
  })

  it('describes the snapshot even after the live comparison changes', () => {
    const s = snapshot(['A', 'B', 'C'])
    const before = JSON.stringify(buildReportCard(s))
    useCompareStore.getState().updateScenario('s-B', { name: 'Renamed', duration_days: 10 })
    expect(JSON.stringify(buildReportCard(s))).toBe(before)
  })

  it('documents sources, coverage, methodology, versions and the disclaimer', () => {
    const c = buildReportCard(snapshot(['A', 'B', 'D']))
    expect(c.sources.nasa.join(' ')).toMatch(/JPL Horizons/)
    expect(c.sources.nasa.join(' ')).toMatch(/LOLA/)
    expect(c.sources.coverage.map((x) => x.label)).toEqual(['A', 'B', 'D'])
    expect(c.sources.versions.some((v) => v.includes(c.snapshot_id))).toBe(true)
    expect(c.disclaimer).toBe(DISCLAIMER)
    expect(c.disclaimer).toMatch(/not an official NASA mission approval/)
    expect(c.executive_summary).toMatch(/^This report evaluates 3 lunar south-pole mission plans/)
  })

  it('cites Gracy & Lee as the source of two site coordinates, never as a validation of the model', () => {
    const nasa = buildReportCard(snapshot(['A', 'B'])).sources.nasa
    const gl = nasa.filter((x) => /Gracy/.test(x))
    expect(gl).toHaveLength(1)
    expect(gl[0]).toMatch(/source of the Connecting Ridge and Peak Near Shackleton coordinates/)
    expect(gl[0]).toMatch(/not a validation/)
    expect(nasa.join(' ')).not.toMatch(/Validation reference/i)
    // The LROC map is something the model is compared with; this report does not claim more than the Methodology view does.
    expect(nasa.join(' ')).toMatch(/LROC[^.]*compared with/)
  })
})
