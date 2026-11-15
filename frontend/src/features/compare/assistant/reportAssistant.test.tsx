// The Mission Assistant and the Mission Report: the assistant reads the frozen report snapshot (never a recomputation),
// knows when it no longer matches the comparison, and can explain how to generate it and save it as a PDF.
// Fixture: A Peak Near Shackleton FAIL · B Malapert PASS #1 · C Connecting Ridge PASS #2.
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import fixture from '../__fixtures__/compare-response.json'
import { selectionKeyOf, useReportStore } from '../report'
import { makeScenario, resultKey, selectionKey } from '../scenario'
import type { ComparisonScenario, CompareResponse, ResultState } from '../types'
import { useCompareStore } from '../useCompareStore'
import { buildAssistantContext } from './context'
import { basicAnswer } from './fallback'
import { guideFor } from './navigation'
import { openReport } from './openReport'
import { REPORT_SECTIONS, reportForAssistant } from './reportContext'
import { NO_REPORT, basicReportAnswer, isReportQuestion } from './reportFallback'
import { RichText } from './RichText'
import { suggestedQuestions } from './suggestions'

const res = fixture as unknown as CompareResponse
const SITES = {
  A: { id: 'peak-near-shackleton', name: 'Peak Near Shackleton', lat: -89.01701, lon: 126.27302 },
  B: { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 },
  C: { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767 },
  D: { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }, // fixture D: no data (UNKNOWN)
} as const

function load(keys: ('A' | 'B' | 'C' | 'D')[]): ComparisonScenario[] {
  const scenarios = keys.map((k, i) => ({
    ...makeScenario({ site: SITES[k], landing_utc: '2027-01-15T00:00:00Z', duration_days: 7 }, []),
    id: `s-${k}`, label: k, colorSlot: i, name: `Plan ${k}`,
  }))
  const results: Record<string, ResultState> = {}
  for (const s of scenarios) results[resultKey(s, false)] = { state: 'done', result: res.results.find((x) => x.key === s.label)! }
  useCompareStore.setState({
    scenarios, selectedIds: scenarios.map((s) => s.id), results, allowDemo: false, baselineId: scenarios[0].id,
    rankingGroups: res.ranking_groups.filter((g) => g.keys.some((k) => keys.includes(k as 'A'))), rankingPairs: res.pairwise,
    rankingSetKey: selectionKey(scenarios, false), rescueContext: null, notes: res.notes,
  })
  return scenarios
}

const live = () => selectionKeyOf(useCompareStore.getState())
const ctxWith = (report: ReturnType<typeof reportForAssistant>) => buildAssistantContext([], [], [], [], true, null, report)

beforeEach(() => useReportStore.setState({ snapshot: null, open: false }))

describe('report in the assistant context', () => {
  it('is absent until a report is generated', () => {
    load(['A', 'B', 'C'])
    expect(reportForAssistant(useReportStore.getState().snapshot, live(), false)).toBeNull()
  })

  it('carries the frozen report: plans, verdicts, decision, sections; not the whole export', () => {
    load(['A', 'B', 'C'])
    expect(useReportStore.getState().generate()).toEqual({ ok: true })
    const snap = useReportStore.getState().snapshot!
    const r = reportForAssistant(snap, live(), true)!
    expect(r).toMatchObject({ snapshot_id: snap.snapshot_id, generated_at: snap.generated_at, out_of_date: false, open: true, scenarios: ['A', 'B', 'C'] })
    expect(r.plans.map((p) => [p.label, p.verdict])).toEqual([['A', 'fail'], ['B', 'pass'], ['C', 'pass']])
    expect(r.decisions.some((d) => d.recommended === 'B')).toBe(true)
    expect(r.sections.map((x) => x.title)).toEqual(REPORT_SECTIONS)
    expect(r.sections.find((x) => x.title === 'Mission performance')).toMatchObject({ where: 'section 3, page 4' })
    expect(r.sections.find((x) => x.title === 'Mission performance')?.contains).toMatch(/longest communication blackout/)
    expect(r.decisive_differences.length).toBeGreaterThan(0)
    expect('export' in r).toBe(false)
    expect(JSON.stringify(r).length).toBeLessThan(25_000)
  })

  it('is flagged out of date when the comparison changes after generation, and keeps the old findings', () => {
    load(['A', 'B', 'C'])
    useReportStore.getState().generate()
    const snap = useReportStore.getState().snapshot!
    useCompareStore.getState().updateScenario('s-B', { duration_days: 10 })
    const r = reportForAssistant(snap, live(), false)!
    expect(r.out_of_date).toBe(true)
    expect(r.plans.find((p) => p.label === 'B')?.verdict).toBe('pass') // the report still says what it said
  })

  it('changes the context revision when a report appears or goes out of date', () => {
    load(['A', 'B', 'C'])
    useReportStore.getState().generate()
    const snap = useReportStore.getState().snapshot!
    const none = ctxWith(null).revision
    const fresh = ctxWith(reportForAssistant(snap, snap.selection.key, false)).revision
    const stale = ctxWith(reportForAssistant(snap, 'something else', false)).revision
    expect(new Set([none, fresh, stale]).size).toBe(3)
  })
})

describe('report suggestions and navigation', () => {
  it('suggests the report question that fits', () => {
    load(['A', 'B', 'C'])
    useReportStore.getState().generate()
    const snap = useReportStore.getState().snapshot!
    const ready = (report: ReturnType<typeof reportForAssistant>) => ({ ...ctxWith(report), state: 'ready' as const })
    expect(suggestedQuestions(ready(reportForAssistant(snap, snap.selection.key, false)))).toContain('Summarize my report.')
    expect(suggestedQuestions(ready(reportForAssistant(snap, 'changed', false)))).toContain('What changed since my report was generated?')
    expect(suggestedQuestions(ready(null))).toContain('How do I generate a mission report?')
  })

  it('answers how to generate the report and save the PDF, with an open-report link', () => {
    expect(guideFor('How do I generate a mission report?')?.id).toBe('report')
    expect(guideFor('How do I download the PDF?')?.id).toBe('pdf')
    expect(guideFor('How do I export a CSV?')?.id).toBe('export')
    const pdf = basicAnswer('How do I download the PDF?', ctxWith(null))
    expect(pdf).toContain('click **Download PDF**')
    expect(pdf).toContain('[[go:report]]')
    expect(renderToString(<RichText text="See [[go:report]]" onNav={() => {}} />)).toContain('Open the Mission Report</button>')
  })

  it('the link reopens the last report, and never generates one', () => {
    expect(openReport()).toBe('none') // no report, no page (tests run without a document)
    expect(useReportStore.getState().snapshot).toBeNull()
    load(['A', 'B'])
    useReportStore.getState().generate()
    useReportStore.getState().close()
    expect(openReport()).toBe('reopened')
    expect(useReportStore.getState().open).toBe(true)
  })
})

describe('report answers without AI', () => {
  const report = (keys: ('A' | 'B' | 'C' | 'D')[], liveKey?: string) => {
    load(keys)
    useReportStore.getState().generate()
    const snap = useReportStore.getState().snapshot!
    return reportForAssistant(snap, liveKey ?? snap.selection.key, false)!
  }

  it('routes questions about the report content to the report, and how-to questions to the guide', () => {
    expect(isReportQuestion('Summarize my report.')).toBe(true)
    expect(isReportQuestion('What does the report mean by UNKNOWN?')).toBe(true)
    expect(isReportQuestion('Which section of the report shows the longest blackout?')).toBe(true)
    expect(isReportQuestion('How do I generate a mission report?')).toBe(false)
    expect(isReportQuestion('How do I download the PDF?')).toBe(false)
    expect(isReportQuestion('Summarize my current comparison.')).toBe(false)
    expect(basicAnswer('Summarize my report.', ctxWith(null))).toBe(NO_REPORT)
  })

  it('summarizes the report from the snapshot: decision, plans, differences, uncertainty', () => {
    const r = report(['A', 'B', 'C'])
    const t = basicAnswer('Summarize my report.', ctxWith(r))
    for (const h of ['### Decision', '### Plans evaluated', '### Decisive differences', '### Main uncertainty']) expect(t).toContain(h)
    expect(t).toMatch(/\*\*Scenario A\*\* \(Peak Near Shackleton\): FAIL/)
    expect(t).toMatch(/\*\*Scenario B\*\* \(Malapert Massif\): PASS/)
    expect(t).toContain('It matches the comparison on screen.')
    expect(t).not.toContain('Out of date')
    expect(t.trimEnd().endsWith('[[go:report]]')).toBe(true)
  })

  it('says first when the report is out of date', () => {
    const t = basicReportAnswer('Summarize my report.', report(['A', 'B', 'C'], 'changed'))
    expect(t.startsWith('**Out of date:**')).toBe(true)
  })

  it('explains the final assessment without naming a winner the report does not name', () => {
    const t = basicReportAnswer('Explain the final assessment in my report.', report(['A', 'B', 'C']))
    expect(t).toContain('### Final assessment')
    expect(t).toMatch(/Scenario B/)
    const none = basicReportAnswer('Explain the final assessment in my report.', report(['A']))
    expect(none).not.toMatch(/: Scenario [A-Z]\b(?! \()/) // no recommended scenario named for a lone failing plan
  })

  it('lists strengths and weaknesses from the report only, never calling UNKNOWN a failure', () => {
    const r = report(['A', 'B', 'C'])
    const a = basicReportAnswer('What are the weaknesses of Scenario A in the report?', r)
    expect(a).toContain('### Scenario A: FAIL')
    expect(a).toMatch(/\*\*Mean visible solar disk\*\*: fails the requirement \(36\.8%/)
    const b = basicReportAnswer('What are the strengths of Scenario B in the report?', r)
    expect(b).toMatch(/\*\*Earth in line of sight\*\*: meets the requirement/)
    expect(b).toMatch(/Scenario B has /)
    expect(b).not.toMatch(/at least as good/) // comparison partner not named in that sentence
    expect(b).toMatch(/Compared with it, Scenario C has more sunlight right after landing/)
    expect(basicReportAnswer('Strengths of Scenario Z in the report?', r)).toMatch(/does not include Scenario Z/)
  })

  it('explains UNKNOWN and the communication section, and points to the right report section', () => {
    const withUnknown = report(['B', 'D'])
    const u = basicReportAnswer('What does the report mean by UNKNOWN?', withUnknown)
    expect(u).toMatch(/\*\*not\*\* a failure/)
    expect(u).toMatch(/Scenario D/)
    const r = report(['A', 'B', 'C'])
    const comm = basicReportAnswer('Explain the communication section of my report.', r)
    expect(comm).toContain('### Communication in the report')
    expect(comm).toMatch(/Longest communication blackout/)
    expect(comm).toMatch(/not a confirmed radio link/)
    expect(basicReportAnswer('Which section of the report shows the longest blackout?', r)).toMatch(/See the \*\*Mission performance\*\* section \(section 3, page 4\)/)
    expect(basicReportAnswer('Which section of the report shows the data sources?', r)).toMatch(/\*\*Data sources and methodology\*\*/)
    expect(basicReportAnswer('Which section of the report shows the weaknesses?', r)).toMatch(/\*\*Strengths and weaknesses\*\*/)
  })
})

describe('out-of-date report notice in the chat', () => {
  it('adds a fixed notice before the answer to a report question, and only then', async () => {
    const { useAssistant, OUT_OF_DATE_NOTICE } = await import('./useAssistant')
    load(['A', 'B', 'C'])
    useReportStore.getState().generate()
    const snap = useReportStore.getState().snapshot!
    const stale = ctxWith(reportForAssistant(snap, 'changed', false))
    const fresh = ctxWith(reportForAssistant(snap, snap.selection.key, false))
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ reply: 'ok', model: 'm', source: 'ai' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
    try {
      const reset = () => useAssistant.setState({ messages: [], pending: false, error: null, lastSignature: null })
      reset(); await useAssistant.getState().ask('Summarize my report.', stale)
      expect(useAssistant.getState().messages.map((m) => m.role)).toEqual(['user', 'notice', 'assistant'])
      expect(useAssistant.getState().messages[1].content).toBe(OUT_OF_DATE_NOTICE)
      reset(); await useAssistant.getState().ask('Summarize my report.', fresh)
      expect(useAssistant.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant'])
      reset(); await useAssistant.getState().ask('Summarize my current comparison.', stale)
      expect(useAssistant.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    } finally {
      globalThis.fetch = original
    }
  })
})
