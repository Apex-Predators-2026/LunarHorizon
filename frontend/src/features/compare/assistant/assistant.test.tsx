// Mission Assistant (Phase 4): the context it receives, conversation handling, failure states and rendering.
// Fixture: A Peak Near Shackleton FAIL · B Malapert PASS #1 · C Connecting Ridge PASS #2 · D no data (UNKNOWN) ·
// E Malapert 3-day PASS in a separate group.
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fixture from '../__fixtures__/compare-response.json'
import type { Entry } from '../analysis'
import { makeScenario } from '../scenario'
import type { CompareResponse, CompareResult } from '../types'
import { buildAssistantContext, contextLine, contextSignature, contextState } from './context'
import { inlineParts, parseBlocks } from './markdown'
import { MissionAssistant } from './MissionAssistant'
import { RichText } from './RichText'
import { suggestedQuestions } from './suggestions'
import { useAssistant } from './useAssistant'

const res = fixture as unknown as CompareResponse
const byKey = Object.fromEntries(res.results.map((r) => [r.key, r])) as Record<string, CompareResult>
const SITE = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }

function entry(key: string): Entry {
  const r = byKey[key]
  const scenario = { ...makeScenario({ site: SITE, landing_utc: '2027-01-15T00:00:00Z' }, []), label: key, id: `s-${key}` }
  return { scenario, state: { state: 'done', result: r }, result: r.status === 'ok' ? r : null, offsetHours: 0, ranking: r.ranking }
}
const all = () => ['A', 'B', 'C', 'D', 'E'].map(entry)
const ctx = (entries = all(), ready = true) => buildAssistantContext(entries, res.ranking_groups, res.pairwise, res.notes, ready)
const byLabel = (c: ReturnType<typeof ctx>) => Object.fromEntries(c.scenarios.map((s) => [s.label, s]))

describe('comparison context', () => {
  it('carries the displayed verdicts, ranks and recommendation, and nothing invented', () => {
    const c = ctx()
    const s = byLabel(c)
    expect(c.state).toBe('ready')
    expect(c.selected).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(s.A.eligibility).toBe('fail')
    expect(s.D.eligibility).toBe('unknown') // UNKNOWN stays UNKNOWN, never FAIL
    expect([s.B.canonical_rank, s.C.canonical_rank]).toEqual([1, 2])
    for (const l of ['A', 'D']) expect(s[l].canonical_rank).toBeNull() // only eligible PASS scenarios are ranked
    expect(s.B.recommended).toBe(true)
    expect(Object.values(s).filter((x) => x.recommended)).toHaveLength(s.E.recommended ? 2 : 1)
    expect(c.decisions.length).toBeGreaterThan(0)
    expect(c.sections.map((x) => x.id)).toContain('cmp-metrics')
  })

  it('keeps missing measurements missing: no value, never 0', () => {
    const d = byLabel(ctx()).D
    const metrics = Object.values(d.metrics)
    expect(metrics.length).toBeGreaterThan(0)
    for (const m of metrics) {
      expect(m.status).toBe('missing')
      expect('value' in m).toBe(false)
    }
    for (const sc of ctx().scenarios) for (const m of Object.values(sc.metrics)) {
      if (m.status !== 'known') expect(m.value).toBeUndefined()
    }
  })

  it('reports how current it is, and states no ranking while the ranking is updating', () => {
    expect(contextState([], true)).toBe('empty')
    expect(ctx([], true).state).toBe('empty')
    const loading = [{ ...entry('A'), state: { state: 'loading' as const } }, entry('B')]
    expect(contextState(loading, false)).toBe('loading')
    const updating = ctx(all(), false)
    expect(updating.state).toBe('updating')
    expect(updating.ranking_groups).toEqual([])
    for (const s of updating.scenarios) expect(s.recommended).toBe(false)
  })

  it('changes its signature when scenarios, requirements or results change', () => {
    const base = contextSignature(ctx())
    expect(contextSignature(ctx())).toBe(base)
    expect(contextSignature(ctx(all().slice(0, 3)))).not.toBe(base)
    const e = all()
    e[1] = { ...e[1], scenario: { ...e[1].scenario, requirements: { ...e[1].scenario.requirements, min_sunlight_fraction: 0.9 } } }
    expect(contextSignature(ctx(e))).not.toBe(base)
    expect(contextSignature(ctx(all(), false))).not.toBe(base)
  })

  it('stays well inside the backend size limit for a full comparison', () => {
    expect(JSON.stringify(ctx()).length).toBeLessThan(60_000)
  })

  it('describes what it is reading in one line', () => {
    expect(contextLine(ctx([]))).toBe('No scenarios selected')
    expect(contextLine(ctx(all().slice(0, 2)))).toMatch(/^A \(Malapert Massif\), B \(Malapert Massif\) · results up to date$/)
  })
})

describe('suggested questions', () => {
  it('leads with getting started when nothing is selected, and with the comparison otherwise', () => {
    expect(suggestedQuestions('empty')[0]).toMatch(/select scenarios/)
    expect(suggestedQuestions('ready')[0]).toBe('Summarize my current comparison.')
    expect(suggestedQuestions('ready')).toContain('Where can I see the longest blackout?')
  })
})

describe('answer formatting', () => {
  it('parses paragraphs, headings and lists, and keeps everything as text', () => {
    const b = parseBlocks('### Overall assessment\nScenario B **passes**.\n\n- Sun: 97%\n- Earth: 100%\n1. first\n2. second')
    expect(b.map((x) => x.kind)).toEqual(['h', 'p', 'ul', 'ol'])
    expect(inlineParts('a **b** [c](http://x) `d`')).toEqual([{ bold: false, text: 'a ' }, { bold: true, text: 'b' }, { bold: false, text: ' c d' }])
    const html = renderToString(<RichText text={'<img src=x onerror=alert(1)> **ok**'} />)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})

describe('conversation', () => {
  const reset = () => useAssistant.setState({ open: false, messages: [], pending: false, error: null, availability: 'unknown', availabilityMessage: null, lastSignature: null })
  beforeEach(reset)
  afterEach(() => vi.unstubAllGlobals())

  const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

  it('sends the question with the current comparison and shows the answer', async () => {
    const fetchMock = reply({ reply: '**Scenario B** is the eligible passing option.', model: 'm', source: 'ai' })
    vi.stubGlobal('fetch', fetchMock)
    await useAssistant.getState().ask('  Summarize my current comparison.  ', ctx())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/assistant/chat')
    const body = JSON.parse(init.body as string)
    expect(body.messages).toEqual([{ role: 'user', content: 'Summarize my current comparison.' }])
    expect(body.context.selected).toEqual(['A', 'B', 'C', 'D', 'E'])
    const s = useAssistant.getState()
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(s).toMatchObject({ pending: false, error: null, availability: 'available' })
  })

  it('never invents an answer when the assistant is unavailable', async () => {
    vi.stubGlobal('fetch', reply({ detail: { reason: 'not_configured', message: 'The Mission Assistant is not configured on this server.' } }, 503))
    await useAssistant.getState().ask('Which mission is more suitable?', ctx())
    const s = useAssistant.getState()
    expect(s.messages.map((m) => m.role)).toEqual(['user'])
    expect(s.error).toEqual({ reason: 'not_configured', message: 'The Mission Assistant is not configured on this server.' })
    expect(s.availability).toBe('unavailable')
  })

  it('reports an unreachable backend, and retries the same question without repeating it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await useAssistant.getState().ask('Explain the biggest trade-off.', ctx())
    expect(useAssistant.getState().error?.reason).toBe('backend_unreachable')
    const ok = reply({ reply: 'B passes; C passes with less sunlight.', model: 'm', source: 'ai' })
    vi.stubGlobal('fetch', ok)
    await useAssistant.getState().retry(ctx())
    const body = JSON.parse((ok.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.messages).toEqual([{ role: 'user', content: 'Explain the biggest trade-off.' }])
    expect(useAssistant.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('notes in the chat when the comparison changed, and never sends that note to the AI', async () => {
    const fetchMock = reply({ reply: 'ok', model: 'm', source: 'ai' })
    vi.stubGlobal('fetch', fetchMock)
    await useAssistant.getState().ask('Summarize.', ctx())
    await useAssistant.getState().ask('And now?', ctx(all().slice(0, 2)))
    const s = useAssistant.getState()
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'notice', 'user', 'assistant'])
    expect(s.messages[2].content).toMatch(/The comparison changed\. Now reading: A .*B/)
    const body = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(body.context.selected).toEqual(['A', 'B'])
  })

  it('ignores empty questions, and New chat clears the conversation', async () => {
    const fetchMock = reply({ reply: 'ok', model: 'm', source: 'ai' })
    vi.stubGlobal('fetch', fetchMock)
    await useAssistant.getState().ask('   ', ctx())
    expect(fetchMock).not.toHaveBeenCalled()
    await useAssistant.getState().ask('Hi', ctx())
    useAssistant.getState().clear()
    expect(useAssistant.getState()).toMatchObject({ messages: [], error: null, lastSignature: null })
  })
})

describe('panel', () => {
  it('renders nothing on the server (it lives in a portal on the page)', () => {
    expect(renderToString(<MissionAssistant entries={all()} groups={res.ranking_groups} pairs={res.pairwise} notes={res.notes} ready />)).toBe('')
  })
})
