// Mission Report preview and PDF: the document pages, section navigation, chart data, the PDF text clean-up, and a
// real PDF rendered from the fixture comparison.
// Fixture: A Peak Near Shackleton FAIL · B Malapert PASS #1 · C Connecting Ridge PASS #2 · D no data (UNKNOWN).
import { renderToBuffer } from '@react-pdf/renderer'
import { createRef } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import fixture from './__fixtures__/compare-response.json'
import { MissionReportBody } from './MissionReportBody'
import { useReportStore, type ReportSnapshot } from './report'
import { buildReportCard } from './reportCard'
import { ReportCardDocument } from './ReportCardDocument'
import { ReportCardPdf } from './ReportCardPdf'
import { PAGE_COUNT, SECTIONS, headlineCharts, pdfText, reportFileName } from './reportLayout'
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
} as const
type K = keyof typeof INPUT

function snapshot(keys: K[], names: Partial<Record<K, string>> = {}): ReportSnapshot {
  const scenarios = keys.map((k, i) => ({ ...makeScenario({ ...INPUT[k] }, []), id: `s-${k}`, label: k, colorSlot: i, name: names[k] ?? `Plan ${k}` }))
  const results: Record<string, ResultState> = {}
  for (const s of scenarios) results[resultKey(s, false)] = { state: 'done', result: res.results.find((x) => x.key === s.label)! }
  useCompareStore.setState({
    scenarios, selectedIds: scenarios.map((s) => s.id), results, allowDemo: false, baselineId: scenarios[0].id,
    rankingGroups: res.ranking_groups.filter((g) => g.keys.some((k) => keys.includes(k as K))), rankingPairs: res.pairwise,
    rankingSetKey: selectionKey(scenarios, false), rescueContext: null, notes: res.notes,
  })
  useReportStore.getState().generate()
  return useReportStore.getState().snapshot!
}

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b)
const pdfPages = (b: Uint8Array) => (latin1(b).match(/\/Type \/Page\b/g) ?? []).length

beforeEach(() => useReportStore.setState({ snapshot: null, open: false }))

describe('layout helpers', () => {
  it('writes out characters the PDF font cannot draw, and keeps the rest', () => {
    expect(pdfText('≤ 100 h (4.2 d)')).toBe('max 100 h (4.2 d)')
    expect(pdfText('≥ 50.0%')).toBe('min 50.0%')
    expect(pdfText('2027-01-15 → 2027-01-22')).toBe('2027-01-15 to 2027-01-22')
    expect(pdfText('4.98° · 400 W × 2 – “ok”')).toBe('4.98° · 400 W × 2 – “ok”')
    expect(pdfText('rocket 🚀 −3')).toBe('rocket  -3')
  })

  it('defines the six report pages and nine sections once, for the preview, the PDF and the assistant', () => {
    expect(PAGE_COUNT).toBe(6)
    expect(SECTIONS.map((s) => s.title)).toEqual([
      'Executive summary', 'Mission overview', 'Mission performance', 'Comparison analysis', 'Mission requirements assessment',
      'Strengths and weaknesses', 'Final assessment and recommendation', 'Data sources and methodology', 'Disclaimer',
    ])
    expect(reportFileName({ snapshot_id: 'rpt-1' })).toBe('lunar-mission-report-rpt-1.pdf')
  })

  it('charts the headline measures with no bar where there is no exact value', () => {
    const charts = headlineCharts(buildReportCard(snapshot(['A', 'B', 'C', 'D'])))
    expect(charts.map((c) => c.title)).toEqual(['Mean visible solar disk', 'Longest continuous power darkness', 'Earth in line of sight', 'Longest communication blackout'])
    const disk = charts[0]
    expect(disk.bars.find((b) => b.label === 'B')).toMatchObject({ best: true, share: expect.closeTo(0.956, 2) })
    expect(disk.bars.find((b) => b.label === 'D')).toMatchObject({ share: null, value: { text: 'Not assessed' } })
    for (const c of charts) for (const b of c.bars) if (b.share !== null) expect(b.share).toBeGreaterThanOrEqual(0)
  })
})

describe('preview document', () => {
  it('lays the report out as six pages with running headers, footers and page numbers', () => {
    const card = buildReportCard(snapshot(['A', 'B', 'C', 'D']))
    const html = renderToString(<ReportCardDocument card={card} />)
    expect(html).toContain('Lunar Mission Comparison Report')
    for (let n = 1; n <= PAGE_COUNT; n++) expect(html).toContain(`Page <!-- -->${n}<!-- --> of <!-- -->${PAGE_COUNT}`)
    for (const s of SECTIONS) expect(html).toContain(`id="${s.id}"`)
    expect(html).toContain(`Snapshot <!-- -->${card.snapshot_id}`)
  })

  it('shows statuses as words, missing data as "Not assessed", and never NaN or undefined', () => {
    const html = renderToString(<ReportCardDocument card={buildReportCard(snapshot(['A', 'B', 'C', 'D']))} />)
    for (const w of ['>FAIL<', '>PASS<', '>UNKNOWN<', 'Not assessed', 'not an official NASA mission approval']) expect(html).toContain(w)
    expect(html).not.toMatch(/NaN|undefined/)
  })

  it('has section navigation with the current page, and the technical record as an appendix', () => {
    const html = renderToString(<MissionReportBody snapshot={snapshot(['A', 'B'])} scrollRef={createRef<HTMLDivElement>()} />)
    expect(html).toContain('aria-label="Report sections"')
    expect(html).toContain(`Page <!-- -->1<!-- --> of <!-- -->${PAGE_COUNT}`)
    for (const s of SECTIONS.filter((x) => x.id !== 'rc-disclaimer')) expect(html).toContain(s.title)
    expect(html).toContain('Appendix: technical record')
    expect(html).toContain('id="rpt-appendix"')
  })
})

describe('PDF', () => {
  it('renders a real multi-page A4 PDF of the report', async () => {
    const card = buildReportCard(snapshot(['A', 'B', 'C', 'D'], { C: 'Connecting Ridge backup plan with a deliberately long scenario name to test wrapping' }))
    const buf = await renderToBuffer(<ReportCardPdf card={card} />)
    expect(latin1(buf.subarray(0, 5))).toBe('%PDF-')
    expect(pdfPages(buf)).toBeGreaterThanOrEqual(PAGE_COUNT)
    expect(latin1(buf)).toMatch(/\/MediaBox \[0 0 595\.2\d* 841\.8\d*\]/) // A4
    expect(buf.length).toBeLessThan(250_000)
  }, 60_000)

  it('renders for a single plan and for a plan with no data', async () => {
    for (const keys of [['A'], ['D']] as K[][]) {
      const buf = await renderToBuffer(<ReportCardPdf card={buildReportCard(snapshot(keys))} />)
      expect(latin1(buf.subarray(0, 5))).toBe('%PDF-')
      expect(pdfPages(buf)).toBeGreaterThanOrEqual(PAGE_COUNT)
    }
  }, 60_000)
})
