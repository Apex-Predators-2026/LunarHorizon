// One evaluated mission snapshot everywhere in the comparison.
//
// The backend evaluates every mission on its hourly grid (backend/app/timegrid.py) and returns what it evaluated
// (evaluated_landing_utc, evaluated_duration_days, time_note). Everything in the comparison that describes an
// assessed mission (time axes, mission extents, labels, exports, the assistant's context, the 3D-view cursor) must
// use those values; what the user typed stays available, clearly named "requested".
//
// The fixtures below are backend-shaped: the real /api/compare fixture with the evaluated fields and the timeline
// exactly as the backend returns them for the two reference cases (values checked against app.timegrid):
//   Case A  requested 2027-02-08 00:00 UTC, 24.5 h      -> evaluated 00:00 UTC, 24 h  (Python round(24.5) = 24)
//   Case B  requested 2027-02-08 00:15 UTC, 1.01 days   -> evaluated 00:00 UTC, 24 h
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '../../store'
import fixture from './__fixtures__/compare-response.json'
import { axisOffsets, axisOrigin, buildSummary, conditionsAt, fullDomain, mergeSeries, missionExtent, type Entry } from './analysis'
import { buildAssistantContext } from './assistant/context'
import { basicSummary } from './assistant/fallback'
import { EXPORT_VERSION, buildExport, toCsv } from './export'
import { axisPlacement, missionTime, missionTimeLines, missionTimeOf } from './missionTime'
import { OverviewCards } from './OverviewCards'
import { RescueStory } from './RescueStory'
import { makeScenario, resultKey } from './scenario'
import { SyncTimeline } from './SyncTimeline'
import type { CompareResponse, CompareResult, ComparisonScenario, ResultState, TimelineColumns } from './types'
import { useCompareStore } from './useCompareStore'

const res = fixture as unknown as CompareResponse
const byKey = Object.fromEntries(res.results.map((r) => [r.key, r])) as Record<string, CompareResult>
const SITE = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }
const SITE_C = { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.4366, lon: 222.7963 }
const HOUR = 3_600_000
const ms = (iso: string) => new Date(iso).getTime()
const NOTE_A = 'On the hourly data grid: length evaluated as 24 h (you entered 24.5 h).'
const NOTE_B = 'On the hourly data grid: landing evaluated at 2027-02-08 00:00 UTC (you entered 2027-02-08 00:15 UTC); ' +
  'length evaluated as 24 h (you entered 24.24 h).'

/** The backend's minute-precision timestamp (app/compare/service.py _iso). */
const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + 'Z'

/** A backend result as /api/compare returns it for this evaluated window: the fixture's data, re-timed. */
function backendResult(key: string, evaluatedLanding: string, hours: number, note: string | null, base = byKey.B): CompareResult {
  const t0 = ms(evaluatedLanding)
  const tl = base.timeline!
  const cut = <T,>(xs: T[]) => xs.slice(0, hours)
  const timeline: TimelineColumns = {
    ...tl,
    hour: cut(tl.hour),
    time_utc: cut(tl.hour).map((h) => iso(t0 + h * HOUR)),
    sun_elevation_deg: cut(tl.sun_elevation_deg), sun_azimuth_deg: cut(tl.sun_azimuth_deg),
    sun_horizon_deg: cut(tl.sun_horizon_deg), sun_visible_fraction: cut(tl.sun_visible_fraction),
    earth_elevation_deg: cut(tl.earth_elevation_deg), earth_azimuth_deg: cut(tl.earth_azimuth_deg),
    earth_horizon_deg: cut(tl.earth_horizon_deg), earth_visible: cut(tl.earth_visible), incidence_factor: cut(tl.incidence_factor),
  }
  return { ...base, key, evaluated_landing_utc: iso(t0), evaluated_duration_days: Math.max(1, hours) / 24, time_note: note, timeline }
}

function scenario(label: string, landing_utc: string, duration_days: number, site = SITE): ComparisonScenario {
  return { ...makeScenario({ site, landing_utc, duration_days }, []), label, id: `s-${label}` }
}

function entryOf(s: ComparisonScenario, state: ResultState | undefined, offsetHours = 0): Entry {
  const result = state?.state === 'done' && state.result.status === 'ok' ? state.result : null
  const ranking = state?.state === 'done' ? state.result.ranking : null
  return { scenario: s, state, result, offsetHours, ranking }
}

const caseA = () => {
  const s = scenario('A', '2027-02-08T00:00:00Z', 24.5 / 24)
  return entryOf(s, { state: 'done', result: backendResult('A', '2027-02-08T00:00Z', 24, NOTE_A) })
}
const caseB = () => {
  const s = scenario('B', '2027-02-08T00:15:00Z', 1.01)
  return entryOf(s, { state: 'done', result: backendResult('B', '2027-02-08T00:00Z', 24, NOTE_B) })
}
/** Lay entries out on the shared axis exactly as the dashboard does. */
const laidOut = (list: Entry[], align: 'met' | 'utc') => {
  const off = axisOffsets(list, align)
  return list.map((e) => ({ ...e, offsetHours: off[e.scenario.id] }))
}

beforeEach(() => {
  useCompareStore.setState({ results: {}, baselineId: null, cursor: null, view: null, allowDemo: false, align: 'met' })
})
afterEach(() => vi.unstubAllGlobals())

// ---------------------------------------------------------------- the snapshot

describe('evaluated mission snapshot', () => {
  it('Case A: 24.5 h requested is 24 h evaluated (the backend rounds ties to even), never 25', () => {
    const t = missionTime(caseA())
    expect(t.available).toBe(true)
    expect(t.status).toBe('evaluated')
    expect(t.requested.duration_hours).toBeCloseTo(24.5, 9)
    expect(t.evaluated!.duration_hours).toBe(24)
    expect(t.evaluated!.duration_days).toBe(1)
    expect(t.evaluated!.landing_utc).toBe('2027-02-08T00:00:00.000Z')
    expect(t.evaluated!.end_utc).toBe('2027-02-09T00:00:00.000Z')
    expect(t.adjusted).toBe(true)
    expect(t.time_note).toBe(NOTE_A)
  })

  it('Case B: 00:15 UTC / 1.01 d requested is 00:00 UTC / 24 h evaluated; the request is kept separately', () => {
    const t = missionTime(caseB())
    expect(t.requested.landing_utc).toBe('2027-02-08T00:15:00.000Z')
    expect(t.requested.duration_days).toBe(1.01)
    expect(t.requested.end_utc).toBe(new Date(ms('2027-02-08T00:15:00Z') + 1.01 * 24 * HOUR).toISOString())
    expect(t.evaluated).toEqual({
      landing_utc: '2027-02-08T00:00:00.000Z', duration_days: 1, duration_hours: 24, end_utc: '2027-02-09T00:00:00.000Z',
    })
    expect(t.adjusted).toBe(true)
    expect(t.time_note).toBe(NOTE_B)
  })

  it('23.5 h and 25.5 h ties: the snapshot reports whatever the backend evaluated', () => {
    for (const [req, ev] of [[23.5, 24], [25.5, 26]]) {
      const s = scenario('T', '2027-02-08T00:00:00Z', req / 24)
      const e = entryOf(s, { state: 'done', result: backendResult('T', '2027-02-08T00:00Z', ev, `length evaluated as ${ev} h`) })
      const t = missionTime(e)
      expect(t.evaluated!.duration_hours).toBe(ev)
      expect(t.adjusted).toBe(true)
      expect(fullDomain([e])).toEqual([0, ev])
    }
  })

  it('an exactly aligned whole-hour mission is not adjusted', () => {
    const s = scenario('W', '2027-02-08T03:00:00Z', 2)
    const t = missionTime(entryOf(s, { state: 'done', result: backendResult('W', '2027-02-08T03:00Z', 48, null) }))
    expect(t.adjusted).toBe(false)
    expect(t.time_note).toBeNull()
    expect(t.evaluated!.landing_utc).toBe(t.requested.landing_utc)
    expect(t.evaluated!.duration_hours).toBe(48)
  })

  it('pending, failed, not-requested and unassessed scenarios show the request only: no evaluated time is invented', () => {
    const s = scenario('P', '2027-02-08T00:15:00Z', 1.01)
    const cases: [ResultState | undefined, string][] = [
      [{ state: 'loading' }, 'pending'],
      [{ state: 'error', message: 'Backend unavailable' }, 'error'],
      [undefined, 'not_requested'],
      [{ state: 'done', result: { ...byKey.D, evaluated_landing_utc: '2035-01-15T00:00Z', evaluated_duration_days: 7, time_note: null } }, 'not_assessed'],
    ]
    for (const [state, status] of cases) {
      const t = missionTimeOf(s, state)
      expect(t.status).toBe(status)
      expect(t.available).toBe(false)
      expect(t.evaluated).toBeNull()
      expect(t.adjusted).toBeNull()
      expect(t.time_note).toBeNull()
      expect(t.requested.landing_utc).toBe('2027-02-08T00:15:00.000Z')
    }
  })

  it('a result without the evaluated fields (older backend) is "not reported", never filled in from the request', () => {
    const s = scenario('M', '2027-01-15T00:00:00Z', 7)
    const t = missionTimeOf(s, { state: 'done', result: byKey.B }) // fixture predates the evaluated fields
    expect(t.status).toBe('not_reported')
    expect(t.available).toBe(false)
    expect(t.evaluated).toBeNull()
  })

  it('a result for different inputs is never shown as this scenario\'s evaluation (stale guard)', () => {
    const s = scenario('S', '2027-02-08T00:15:00Z', 1.01)
    const stale = backendResult('some-other-key', '2027-02-08T00:00Z', 24, NOTE_B)
    const t = missionTimeOf(s, { state: 'done', result: stale }, { expectedKey: resultKey(s, false) })
    expect(t.status).toBe('stale')
    expect(t.evaluated).toBeNull()
  })

  it('placement on the axis uses the evaluated window when it exists, else a provisional grid estimate', () => {
    const p = axisPlacement(missionTime(caseA()))
    expect(p).toEqual({ landingMs: ms('2027-02-08T00:00:00Z'), hours: 24, provisional: false })
    // Pending: the estimate follows the backend's policy (ties to even), so it cannot drift to 25 h.
    const pending = axisPlacement(missionTimeOf(scenario('A', '2027-02-08T00:15:00Z', 24.5 / 24), { state: 'loading' }))
    expect(pending).toEqual({ landingMs: ms('2027-02-08T00:00:00Z'), hours: 24, provisional: true })
    const halfUp = axisPlacement(missionTimeOf(scenario('A', '2027-02-08T00:30:00Z', 25.5 / 24), undefined))
    expect(halfUp).toEqual({ landingMs: ms('2027-02-08T01:00:00Z'), hours: 26, provisional: true })
  })

  it('readable lines show both values with the reason when the evaluation moved the request', () => {
    const l = missionTimeLines(missionTime(caseB()))
    expect(l.evaluated).toBe('Evaluated: 2027-02-08 00:00 UTC, 24 h')
    expect(l.requested).toBe('Requested: 2027-02-08 00:15 UTC, 1.01 d')
    expect(l.reason).toBe('Reason: adjusted to the hourly scientific evaluation grid.')
    const aligned = missionTimeLines(missionTime(entryOf(scenario('W', '2027-02-08T03:00:00Z', 2),
      { state: 'done', result: backendResult('W', '2027-02-08T03:00Z', 48, null) })))
    expect(aligned.evaluated).toBe('Evaluated: 2027-02-08 03:00 UTC, 48 h (2 d)')
    expect(aligned.reason).toBeNull()
    const pending = missionTimeLines(missionTimeOf(scenario('P', '2027-02-08T00:15:00Z', 1.01), { state: 'loading' }))
    expect(pending.evaluated).toBe('Evaluated: pending')
    expect(pending.requested).toBe('Requested: 2027-02-08 00:15 UTC, 1.01 d')
  })
})

// ---------------------------------------------------------------- shared time axis

describe('shared time axis follows the evaluated windows', () => {
  it('Case A: the mission domain is 24 h (not 25 h from Math.round)', () => {
    expect(fullDomain([caseA()])).toEqual([0, 24])
  })

  it('Case B: elapsed and UTC axes start at the evaluated 00:00 landing and span 24 h', () => {
    const [b] = laidOut([caseB()], 'utc')
    expect(axisOrigin([b])).toBe(ms('2027-02-08T00:00:00Z'))
    expect(fullDomain([b])).toEqual([0, 24])
    // The data drawn at x = 0 is the backend's first sample, at the evaluated landing time.
    expect(conditionsAt(b, 0)!.time_utc).toBe('2027-02-08T00:00Z')
    // The mission ends at the evaluated 24 h, not at the requested 24.24 h.
    expect(conditionsAt(b, 24.2)).toBeNull()
  })

  it('multi-scenario: different evaluated starts sit at their evaluated offsets, and UTC labels match the data', () => {
    const b = caseB()
    const s2 = scenario('C', '2027-02-08T02:40:00Z', 1, SITE_C)
    const c = entryOf(s2, { state: 'done', result: backendResult('C', '2027-02-08T03:00Z', 24, 'landing evaluated at 03:00', byKey.C) })
    const list = laidOut([b, c], 'utc')
    expect(axisOffsets([b, c], 'utc')).toEqual({ 's-B': 0, 's-C': 3 })
    expect(axisOffsets([b, c], 'met')).toEqual({ 's-B': 0, 's-C': 0 })
    expect(fullDomain(list)).toEqual([0, 27])
    const origin = axisOrigin(list)
    // For every plotted sample, axis origin + x is exactly the sample's backend timestamp.
    for (const e of list) {
      const tl = e.result!.timeline!
      for (const i of [0, 5, tl.hour.length - 1]) {
        const x = e.offsetHours + tl.hour[i]
        expect(iso(origin + x * HOUR)).toBe(tl.time_utc[i])
      }
    }
    const rows = mergeSeries(list, (tl, i) => tl.sun_elevation_deg[i], fullDomain(list))
    expect(rows[0].x).toBe(0)
    expect(rows.find((r) => r.x === 3)!['s-C']).toBe(c.result!.timeline!.sun_elevation_deg[0])
  })

  it('requests that differ but evaluate to the same window share one start (same landing in the summary too)', () => {
    const s1 = scenario('X', '2027-02-08T00:10:00Z', 1)
    const s2 = scenario('Y', '2027-02-07T23:50:00Z', 1, SITE_C)
    const x = entryOf(s1, { state: 'done', result: backendResult('X', '2027-02-08T00:00Z', 24, 'moved') })
    const y = entryOf(s2, { state: 'done', result: backendResult('Y', '2027-02-08T00:00Z', 24, 'moved', byKey.C) })
    expect(axisOffsets([x, y], 'utc')).toEqual({ 's-X': 0, 's-Y': 0 })
    const summary = buildSummary([x, y])
    expect(summary.overall.join(' ')).toMatch(/share the same landing time/)
  })

  it('the synchronized timeline draws the mission extent to the evaluated end', () => {
    const b = caseB()
    const s2 = scenario('C', '2027-02-08T02:40:00Z', 1, SITE_C)
    const c = entryOf(s2, { state: 'done', result: backendResult('C', '2027-02-08T03:00Z', 24, 'moved', byKey.C) })
    const [lb, lc] = laidOut([b, c], 'utc')
    expect(missionExtent(lb)).toEqual([0, 24]) // not [0, 24.24]
    expect(missionExtent(lc)).toEqual([3, 27])
    // Rendered: the extent rectangle of B ends exactly at the evaluated end (x(24) on a 0..48 h axis).
    const html = renderToString(<SyncTimeline entries={[lb]} full={[0, 48]} view={[0, 48]} align="met" originMs={axisOrigin([lb])} />)
    const ext = /<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="20" fill="url\(#hatch-unknown\)"/i.exec(html)!
    const [x0, wd] = [Number(ext[1]), Number(ext[2])]
    const plotW = 800 - 168 - 8 // SSR width (useWidth default) minus the wide gutter and the right padding
    expect(x0).toBeCloseTo(168, 6)
    expect(wd).toBeCloseTo((24 / 48) * plotW, 6)
  })
})

// ---------------------------------------------------------------- cards

describe('scenario cards', () => {
  it('lead with the evaluated window and show the request with the reason when they differ', () => {
    const html = renderToString(<OverviewCards entries={[caseB()]} />).replace(/<!-- -->/g, '')
    expect(html).toContain('Evaluated: 2027-02-08 00:00 UTC, 24 h')
    expect(html).toContain('Requested: 2027-02-08 00:15 UTC, 1.01 d')
    expect(html).toContain('Reason: adjusted to the hourly scientific evaluation grid.')
    expect(html).not.toMatch(/Lands 2027-02-08 00:15/)
  })

  it('say the evaluation is pending instead of presenting the request as evaluated', () => {
    const e = entryOf(scenario('P', '2027-02-08T00:15:00Z', 1.01), { state: 'loading' })
    const html = renderToString(<OverviewCards entries={[e]} />).replace(/<!-- -->/g, '')
    expect(html).toContain('Evaluated: pending')
    expect(html).toContain('Requested: 2027-02-08 00:15 UTC, 1.01 d')
  })
})

describe('Mission Rescue story', () => {
  it('describes each plan by its evaluated window, and a pending plan by its request named as such', () => {
    const b = caseB()
    const p = entryOf(scenario('P', '2027-03-01T10:20:00Z', 2, SITE_C), { state: 'loading' })
    const ctx = { importedAt: '2027-01-01T00:00:00Z', status: 'rescued' as const, summary: '', change: ['Launch delayed by 10 days'],
      roles: { [b.scenario.id]: { role: 'changed' as const, rescueVerdict: 'fail' as const }, [p.scenario.id]: { role: 'alternative' as const, rank: 1 } } }
    const html = renderToString(<RescueStory entries={[b, p]} groups={[]} pairs={[]} rescueContext={ctx} />).replace(/<!-- -->/g, '')
    expect(html).toContain('Malapert Massif, evaluated 2027-02-08 00:00 UTC, 24 h')
    expect(html).not.toContain('2027-02-08 00:15 UTC, 1.01 d')
    expect(html).toContain('Connecting Ridge, requested 2027-03-01 10:20 UTC, 2 d, evaluation pending')
  })
})

// ---------------------------------------------------------------- exports

describe('JSON export describes the evaluated window', () => {
  const exp = (list: Entry[]) => buildExport(list, res.ranking_groups, res.pairwise, [], new Date('2027-01-01T00:00:00Z'))

  it('keeps format v1 and adds explicit evaluated and requested fields', () => {
    const x = exp([caseB()])
    expect(x.format).toBe('comparison-export-v1')
    expect(EXPORT_VERSION).toBe('comparison-export-v1')
    const s = x.scenarios[0]
    expect(s.mission_time).toEqual({
      evaluation_status: 'evaluated',
      evaluated_landing_utc: '2027-02-08T00:00:00.000Z',
      evaluated_duration_days: 1,
      evaluated_duration_hours: 24,
      evaluated_end_utc: '2027-02-09T00:00:00.000Z',
      requested_landing_utc: '2027-02-08T00:15:00.000Z',
      requested_duration_days: 1.01,
      requested_duration_hours: 24.24,
      requested_end_utc: new Date(ms('2027-02-08T00:15:00Z') + 1.01 * 24 * HOUR).toISOString(),
      time_adjusted: true,
      time_note: NOTE_B,
    })
    // Compatibility until the report export (prompt 3): the v1 fields remain and hold the REQUESTED values.
    expect(s.landing_utc).toBe('2027-02-08T00:15:00.000Z')
    expect(s.duration_days).toBe(1.01)
  })

  it('Case A exports 24 evaluated hours', () => {
    const s = exp([caseA()]).scenarios[0]
    expect(s.mission_time.evaluated_duration_hours).toBe(24)
    expect(s.mission_time.requested_duration_hours).toBeCloseTo(24.5, 9)
  })

  it('has null evaluated fields (not the request, not 0) when no evaluation exists', () => {
    const pending = entryOf(scenario('P', '2027-02-08T00:15:00Z', 1.01), { state: 'loading' })
    const missing = entryOf(scenario('M', '2027-01-15T00:00:00Z', 7), { state: 'done', result: byKey.B })
    const unassessed = entryOf(scenario('D', '2035-01-15T00:00:00Z', 7), { state: 'done', result: byKey.D })
    const x = exp([pending, missing, unassessed])
    expect(x.scenarios.map((s) => s.mission_time.evaluation_status)).toEqual(['pending', 'not_reported', 'not_assessed'])
    for (const s of x.scenarios) {
      expect(s.mission_time.evaluated_landing_utc).toBeNull()
      expect(s.mission_time.evaluated_duration_days).toBeNull()
      expect(s.mission_time.evaluated_duration_hours).toBeNull()
      expect(s.mission_time.evaluated_end_utc).toBeNull()
      expect(s.mission_time.time_adjusted).toBeNull()
      expect(s.mission_time.requested_landing_utc).toBeTruthy()
    }
    expect(x.scenarios[2].eligibility).toBe('unknown') // unknown eligibility stays unknown
  })
})

describe('CSV export stays v1-compatible', () => {
  it('keeps the existing landing_utc / duration_days columns (requested values) and a stable header', () => {
    const first = (list: Entry[]) => toCsv(buildExport(list, [], [], [])).split(String.fromCharCode(10))[0].trim()
    const head = first([caseB()]).split(',')
    expect(head).toContain('landing_utc')
    expect(head).toContain('duration_days')
    expect(first([caseB()])).toBe(first([entryOf(scenario('P', '2027-02-08T00:15:00Z', 1.01), undefined)]))
  })
})

// ---------------------------------------------------------------- assistant

describe('assistant context describes the evaluated window', () => {
  const ctx = (list: Entry[], ready = true) => buildAssistantContext(list, res.ranking_groups, res.pairwise, [], ready)

  it('states the evaluated window, the request and the adjustment note; schema version bumped', () => {
    const c = ctx([caseB()])
    expect(c.format).toBe('comparison-assistant-context-v3')
    const s = c.scenarios[0]
    expect(s.mission_time).toEqual({
      status: 'evaluated',
      evaluated_landing_utc: '2027-02-08T00:00:00.000Z',
      evaluated_duration_hours: 24,
      evaluated_end_utc: '2027-02-09T00:00:00.000Z',
      requested_landing_utc: '2027-02-08T00:15:00.000Z',
      requested_duration_days: 1.01,
      adjusted: true,
      note: NOTE_B,
    })
    expect(s).not.toHaveProperty('landing_utc')
    expect(s).not.toHaveProperty('duration_days')
  })

  it('never calls a requested time evaluated while the result is pending', () => {
    const c = ctx([entryOf(scenario('P', '2027-02-08T00:15:00Z', 1.01), { state: 'loading' })], false)
    const mt = c.scenarios[0].mission_time
    expect(mt.status).toBe('pending')
    expect(mt.evaluated_landing_utc).toBeNull()
    expect(mt.evaluated_duration_hours).toBeNull()
    expect(mt.requested_landing_utc).toBe('2027-02-08T00:15:00.000Z')
  })

  it('changes revision when only the evaluated time changes', () => {
    const b = caseB()
    const moved = { ...b, state: { state: 'done' as const, result: { ...b.result!, evaluated_landing_utc: '2027-02-08T01:00Z' } } }
    moved.result = moved.state.result
    expect(ctx([b]).revision).not.toBe(ctx([moved]).revision)
  })

  it('the no-AI summary quotes the evaluated window', () => {
    const text = basicSummary(ctx([caseB()]))
    expect(text).toContain('evaluated 2027-02-08 00:00 UTC, 24 h')
    expect(text).not.toContain('1.01 d')
  })
})

// ---------------------------------------------------------------- store: transfers and stale results

describe('store: cursor transfer, imports and stale results', () => {
  it('the 3D-view time is the evaluated landing plus the cursor, not the requested 00:15', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const st = useCompareStore.getState()
    const id = st.addScenario({ site: SITE, landing_utc: '2027-02-08T00:15:00Z', duration_days: 1.01 })
    const s = useCompareStore.getState().scenarios.find((x) => x.id === id)!
    const key = resultKey(s, false)
    useCompareStore.setState({ results: { [key]: { state: 'done', result: backendResult(key, '2027-02-08T00:00Z', 24, NOTE_B) } } })
    useCompareStore.getState().setActive(id)
    useCompareStore.getState().setCursor(5)
    expect(useAppStore.getState().timeUtc).toBe('2027-02-08T05:00:00.000Z')
    useCompareStore.getState().setAlign('utc')
    useCompareStore.getState().setCursor(5)
    expect(useAppStore.getState().timeUtc).toBe('2027-02-08T05:00:00.000Z')
  })

  it('imports keep the user\'s requested inputs exactly (never rounded to the grid)', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const [id] = useCompareStore.getState().importScenarios([{ site: SITE, landing_utc: '2027-02-08T00:15:00Z', duration_days: 1.01,
      requirements: makeScenario({ site: SITE, landing_utc: '2027-02-08T00:00:00Z' }, []).requirements }])
    const s = useCompareStore.getState().scenarios.find((x) => x.id === id)!
    expect(s.landing_utc).toBe('2027-02-08T00:15:00.000Z')
    expect(s.duration_days).toBe(1.01)
    const copy = useCompareStore.getState().duplicateScenario(id)!
    const c = useCompareStore.getState().scenarios.find((x) => x.id === copy)!
    expect([c.landing_utc, c.duration_days]).toEqual(['2027-02-08T00:15:00.000Z', 1.01])
  })

  it('an edit while a request is in flight never attaches the old evaluation to the edited scenario', async () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const id = useCompareStore.getState().addScenario({ site: SITE, landing_utc: '2027-02-08T00:15:00Z', duration_days: 1.01 })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      await gate
      return { ok: true, status: 200, statusText: 'x',
        json: async () => ({ ...res, results: body.scenarios.map((x: { key: string }) => backendResult(x.key, '2027-02-08T00:00Z', 24, NOTE_B)) }) } as Response
    }))
    const first = useCompareStore.getState().refresh()
    // The user edits the landing before the first answer arrives.
    useCompareStore.getState().updateScenario(id, { landing_utc: '2027-03-01T10:00:00.000Z' })
    release()
    await first
    const s = useCompareStore.getState().scenarios.find((x) => x.id === id)!
    const t = missionTimeOf(s, useCompareStore.getState().results[resultKey(s, false)])
    expect(t.available).toBe(false) // the 2027-02-08 evaluation belongs to the old inputs
    expect(t.evaluated).toBeNull()
  })

  it('a new scenario reusing a removed scenario\'s letter does not inherit its evaluation', () => {
    useCompareStore.setState({ scenarios: [], selectedIds: [] })
    const st = useCompareStore.getState()
    const a = st.addScenario({ site: SITE, landing_utc: '2027-02-08T00:15:00Z', duration_days: 1.01 })
    const sa = useCompareStore.getState().scenarios.find((x) => x.id === a)!
    const key = resultKey(sa, false)
    useCompareStore.setState({ results: { [key]: { state: 'done', result: backendResult(key, '2027-02-08T00:00Z', 24, NOTE_B) } } })
    useCompareStore.getState().removeScenario(a)
    const b = useCompareStore.getState().addScenario({ site: SITE_C, landing_utc: '2027-05-01T00:00:00Z', duration_days: 3 })
    const sb = useCompareStore.getState().scenarios.find((x) => x.id === b)!
    expect(sb.label).toBe(sa.label)
    expect(missionTimeOf(sb, useCompareStore.getState().results[resultKey(sb, false)]).status).toBe('not_requested')
  })
})
