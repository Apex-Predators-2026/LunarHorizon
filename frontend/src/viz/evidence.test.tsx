// "Show me why" request lifecycle (viz/evidence.ts): producer -> navigation -> viewer mount/StrictMode/remount ->
// asynchronous site resolution -> highlight. The viewer side is exercised the way Scene.tsx uses it.
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAssessmentStore } from '../features/assessment/useAssessmentStore'
import { evidenceForConstraint } from '../features/assessment/logic'
import { compareEvidence, constraintForViolation } from '../features/compare/evidence'
import fixture from '../features/compare/__fixtures__/compare-response-current.json'
import type { CompareResponse } from '../features/compare/types'
import {
  attachEvidenceViewer,
  setEvidenceNavigator,
  bodyForWindowKind,
  clearEvidence,
  evidenceBand,
  evidenceFromWindow,
  markEvidenceProblem,
  markEvidenceShown,
  openEvidence,
  resolveEvidence,
  showEvidence,
  takeEvidence,
  useEvidence,
  validateEvidence,
  type ActiveEvidence,
  type EvidenceRequest,
} from './evidence'
import { TimeBar } from './TimeBar'

const SITES = [
  { id: 'malapert-massif', name: 'Malapert Massif', data_start_utc: '2026-01-01T00:00:00Z', data_stop_utc: '2031-01-01T00:00:00Z' },
  { id: 'connecting-ridge', name: 'Connecting Ridge', data_start_utc: '2026-01-01T00:00:00Z', data_stop_utc: '2031-01-01T00:00:00Z' },
]
const DARK: EvidenceRequest = { siteId: 'malapert-massif', startUtc: '2027-03-04T05:00:00Z', endUtc: '2027-03-06T07:00:00Z', body: 'sun' }
const BLACKOUT: EvidenceRequest = { siteId: 'connecting-ridge', startUtc: '2027-03-10T00:30:00Z', endUtc: '2027-03-10T20:00:00Z', body: 'earth' }

/** A minimal stand-in for Scene.tsx: receives requests, resolves them once `sites` is known, applies the newest. */
function fakeViewer() {
  const received: ActiveEvidence[] = []
  let pending: ActiveEvidence | null = null
  const applied: ActiveEvidence[] = []
  const detach = attachEvidenceViewer((r) => {
    received.push(r)
    pending = r // a newer request replaces one still waiting
  })
  const resolve = (sites: typeof SITES | null) => {
    if (!pending) return
    const res = resolveEvidence(pending, sites)
    if (res.status === 'wait') return
    const r = pending
    pending = null
    if (res.status === 'error') return markEvidenceProblem(r, res.message)
    applied.push(r)
    markEvidenceShown(r)
  }
  return { received, applied, detach, resolve }
}

beforeEach(() => {
  clearEvidence()
  useEvidence.setState({ consumedId: useEvidence.getState().request?.id ?? useEvidence.getState().consumedId })
  // Nothing pending from a previous test: consume whatever is there.
  takeEvidence()
})

describe('request lifecycle', () => {
  it('a request made before the 3D view mounts is applied when it mounts (e.g. from the Comparison)', () => {
    showEvidence(DARK)
    const v = fakeViewer()
    expect(v.received.map((r) => r.siteId)).toEqual(['malapert-massif'])
    v.resolve(SITES)
    expect(useEvidence.getState().highlight?.startUtc).toBe('2027-03-04T05:00:00.000Z')
    v.detach()
  })

  it('a request made while the view is mounted is applied', () => {
    const v = fakeViewer()
    expect(v.received).toHaveLength(0)
    showEvidence(BLACKOUT)
    expect(v.received.map((r) => r.body)).toEqual(['earth'])
    v.detach()
  })

  it('StrictMode (mount, cleanup, mount) and a later remount never apply a request twice', () => {
    showEvidence(DARK)
    const first = fakeViewer() // StrictMode: effect runs...
    first.detach() // ...is cleaned up...
    const second = fakeViewer() // ...and runs again on the same component
    expect(first.received.length + second.received.length).toBe(1)
    second.detach()
    const later = fakeViewer() // the user leaves the planner and comes back
    expect(later.received).toHaveLength(0) // stale evidence is not replayed over their site/time
    later.detach()
  })

  it('StrictMode cleanup of the assessment panel does not wipe a request made on another page', () => {
    useAssessmentStore.setState({ showing: null })
    showEvidence({ ...DARK, origin: { kind: 'comparison', label: 'Scenario A' } })
    useAssessmentStore.getState().clearShowing() // MissionAssessment's unmount cleanup, run by StrictMode on mount
    const v = fakeViewer()
    expect(v.received).toHaveLength(1)
    v.detach()
  })

  it('a detached view does not receive requests', () => {
    const v = fakeViewer()
    v.detach()
    showEvidence(DARK)
    expect(v.received).toHaveLength(0)
    const next = fakeViewer() // the next mount takes it instead
    expect(next.received).toHaveLength(1)
    next.detach()
  })

  it('the same evidence clicked twice is two requests (the camera turns again)', () => {
    const v = fakeViewer()
    showEvidence(DARK)
    showEvidence(DARK)
    expect(v.received).toHaveLength(2)
    expect(v.received[1].id).toBe(v.received[0].id + 1)
    v.detach()
  })

  it('clearing never resets the ids, so a later request is never suppressed', () => {
    const v = fakeViewer()
    const a = showEvidence(DARK)
    clearEvidence()
    expect(useEvidence.getState().request).toBeNull()
    const b = showEvidence(DARK)
    expect(a.ok && b.ok && b.id > a.id).toBe(true)
    expect(v.received).toHaveLength(2)
    v.detach()
  })

  it('rapid A -> B while the site list loads: only B is applied, and a late A result is ignored', () => {
    const v = fakeViewer()
    showEvidence(DARK)
    showEvidence(BLACKOUT)
    v.resolve(null) // still loading
    expect(v.applied).toHaveLength(0)
    markEvidenceShown(v.received[0]) // a stale completion for A
    expect(useEvidence.getState().highlight).toBeNull()
    v.resolve(SITES)
    expect(v.applied.map((r) => r.siteId)).toEqual(['connecting-ridge'])
    expect(useEvidence.getState().highlight?.body).toBe('earth')
    v.detach()
  })

  it('the highlight persists after the request is consumed, until it is cleared', () => {
    const v = fakeViewer()
    showEvidence(DARK)
    v.resolve(SITES)
    expect(takeEvidence()).toBeNull() // consumed
    expect(useEvidence.getState().highlight).not.toBeNull()
    clearEvidence()
    expect(useEvidence.getState().highlight).toBeNull()
    v.detach()
  })
})

describe('validation and resolution', () => {
  it('refuses a missing site, invalid or zone-less times, a reversed window and an unknown body', () => {
    expect(validateEvidence({ ...DARK, siteId: ' ' })).toMatch(/No site/)
    expect(validateEvidence({ ...DARK, startUtc: 'not a time' })).toMatch(/Invalid evidence time/)
    expect(validateEvidence({ ...DARK, startUtc: '2027-03-04T05:00' })).toMatch(/Invalid/) // local time: refused
    expect(validateEvidence({ ...DARK, startUtc: '2027-02-30T05:00:00Z' })).toBeNull() // Date.parse rolls over
    expect(validateEvidence({ ...DARK, endUtc: '2027-03-01T00:00:00Z' })).toMatch(/ends before/)
    expect(validateEvidence({ ...DARK, body: 'moon' as never })).toMatch(/Unsupported body/)
    const res = showEvidence({ ...DARK, startUtc: 'NaN' })
    expect(res.ok).toBe(false)
    expect(useEvidence.getState().request).toBeNull() // never reaches the viewer
  })

  it('normalises offsets to UTC: equivalent instants are the same evidence', () => {
    showEvidence({ ...DARK, startUtc: '2027-03-04T07:00:00+02:00', endUtc: '2027-03-06T02:00:00-05:00' })
    const r = useEvidence.getState().request!
    expect(r.startUtc).toBe('2027-03-04T05:00:00.000Z')
    expect(r.endUtc).toBe('2027-03-06T07:00:00.000Z')
  })

  it('waits for the site list, then rejects an unknown site or a time outside the data', () => {
    showEvidence(DARK)
    const r = useEvidence.getState().request!
    expect(resolveEvidence(r, null)).toEqual({ status: 'wait' })
    expect(resolveEvidence(r, null, 'HTTP 500').status).toBe('error')
    expect(resolveEvidence({ ...r, siteId: 'nowhere' }, SITES)).toMatchObject({ status: 'error', message: expect.stringMatching(/no data in the 3D view/) })
    const late = { ...r, startMs: Date.parse('2032-01-01T00:00:00Z') }
    expect(resolveEvidence(late, SITES)).toMatchObject({ status: 'error', message: expect.stringMatching(/outside/) })
    const ok = resolveEvidence(r, SITES)
    expect(ok).toEqual({ status: 'ok', timeUtc: '2027-03-04T05:00:00.000Z', note: null })
  })

  it('a window running past the data is shown up to the data end, with a note, never extended', () => {
    showEvidence({ ...DARK, startUtc: '2030-12-31T20:00:00Z', endUtc: '2031-01-02T00:00:00Z' })
    const res = resolveEvidence(useEvidence.getState().request!, SITES)
    expect(res).toMatchObject({ status: 'ok', note: expect.stringMatching(/past the end of the data/) })
  })

  it('a moment without an end stays a moment: no one-hour window is invented', () => {
    showEvidence({ ...DARK, endUtc: null })
    const band = evidenceBand(useEvidence.getState().request, 'malapert-massif')!
    expect(band.point).toBe(true)
    expect(band.end).toBe(band.start)
    expect(evidenceBand(useEvidence.getState().request, 'connecting-ridge')).toBeNull() // another site: no band
  })
})

describe('Sun, Earth, both and unknown', () => {
  it('looks at the Sun for sunlight and power, at Earth for communications, nothing for no data', () => {
    for (const k of ['darkness', 'power_dark', 'sunlight', 'partial_sunlight', 'sun_unknown', 'power_unknown']) expect(bodyForWindowKind(k)).toBe('sun')
    for (const k of ['communication_blackout', 'earth_visible', 'earth_unknown']) expect(bodyForWindowKind(k)).toBe('earth')
    expect(bodyForWindowKind('simultaneous_sun_earth')).toBe('sun')
    expect(bodyForWindowKind('unknown_data')).toBeNull()
    const w = { kind: 'darkness', start_utc: '2027-03-04T05:00:00Z', end_utc: '2027-03-06T07:00:00Z' }
    expect(evidenceFromWindow('connecting-ridge', w)).toEqual({ siteId: 'connecting-ridge', startUtc: w.start_utc, endUtc: w.end_utc, body: 'sun' })
    expect(evidenceFromWindow('x', { ...w, kind: 'unknown_data' })).toBeNull()
  })

  const win = (kind: string, start: string, end: string, duration_s: number) => ({ kind, start_utc: start, end_utc: end, duration_s, clipped_at_start: false, clipped_at_end: false })
  const src = {
    site: { id: 'malapert-massif' },
    windows: [
      win('power_dark', '2027-01-16T00:00:00Z', '2027-01-17T00:00:00Z', 86400),
      win('communication_blackout', '2027-01-18T00:00:00Z', '2027-01-18T12:00:00Z', 43200),
      win('earth_unknown', '2027-01-19T00:00:00Z', '2027-01-19T06:00:00Z', 21600),
    ],
  }
  const c = (constraint_id: string, status: 'pass' | 'fail' | 'unknown', evidence_windows = [] as ReturnType<typeof win>[]) => ({ constraint_id, name: constraint_id, status, evidence_windows })

  it('Earth requirements point at Earth, Sun requirements at the Sun', () => {
    const blackout = evidenceForConstraint(src, c('max_communication_blackout', 'fail', [src.windows[1]]))!
    expect(blackout.request.body).toBe('earth')
    expect(blackout.role).toBe('measured')
    const dark = evidenceForConstraint(src, c('max_continuous_darkness', 'fail', [src.windows[0]]))!
    expect(dark.request.body).toBe('sun')
  })

  it('a Sun-and-Earth requirement says so, so one body never explains the whole requirement', () => {
    const both = evidenceForConstraint(src, c('min_simultaneous_percent', 'fail'))!
    expect(both.role).toBe('illustrative')
    expect(both.request.bodies).toEqual(['sun', 'earth'])
  })

  it('UNKNOWN points at the missing-data window, labelled as missing data, not as an obstruction', () => {
    const u = evidenceForConstraint(src, c('max_communication_blackout', 'unknown'))!
    expect(u.role).toBe('missing_data')
    expect(u.request.dataMissing).toBe(true)
    expect(u.request.body).toBe('earth')
    expect(evidenceForConstraint({ ...src, windows: [] }, c('max_communication_blackout', 'unknown'))).toBeNull() // never invented
  })
})

// The page the app is showing, as the evidence navigation sees it.
const nav = { view: 'compare' as string }
setEvidenceNavigator((v) => { nav.view = v })

describe('Comparison -> failed requirement -> Show why -> 3D view', () => {
  const res = fixture as unknown as CompareResponse
  const A = res.results.find((r) => r.key === 'A')! // Peak Near Shackleton: fails the solar-disk requirement

  it('maps the failed violation to the canonical constraint and opens the planner at its evidence', () => {
    nav.view = 'compare'
    const violation = A.viability!.violations.find((v) => !v.is_unknown)!
    const c = constraintForViolation(A, violation.constraint)!
    expect(c.status).toBe('fail')
    const ev = compareEvidence(A, 'peak-near-shackleton', c, 'A', 'cmp-performance')
    if (!ev.ok) throw new Error(ev.reason)
    // The selected window is one of the engine's own windows, never a reconstruction.
    expect(A.assessment!.windows).toContainEqual(ev.evidence.window)
    expect(ev.request).toMatchObject({ siteId: 'peak-near-shackleton', body: 'sun', origin: { kind: 'comparison', label: 'Plan A', section: 'cmp-performance' } })
    expect(ev.request.requirement).toMatch(/^≥ /)
    expect(ev.request.measured).toBeTruthy()

    expect(openEvidence(ev.request).ok).toBe(true)
    expect(nav.view).toBe('planner') // the navigation the button performs
    const v = fakeViewer() // the planner's 3D view mounts after the click
    v.resolve([{ id: 'peak-near-shackleton', data_start_utc: '2026-01-01T00:00:00Z', data_stop_utc: '2031-01-01T00:00:00Z' }] as typeof SITES)
    const h = useEvidence.getState().highlight!
    expect(h.startUtc).toBe(new Date(ev.evidence.window.start_utc).toISOString())
    expect(h.endUtc).toBe(new Date(ev.evidence.window.end_utc).toISOString())
    v.detach()
  })

  it('refuses demonstration data and results without an assessment, with a reason', () => {
    const c = A.assessment!.constraints.find((x) => x.status === 'fail')!
    const demo = compareEvidence({ ...A, data_kind: 'demonstration' }, 'x', c, 'A')
    expect(demo).toMatchObject({ ok: false, reason: expect.stringMatching(/real data only/) })
    expect(compareEvidence({ ...A, assessment: null }, 'x', c, 'A')).toMatchObject({ ok: false })
  })

  it('an invalid request from a panel does not navigate', () => {
    nav.view = 'compare'
    expect(openEvidence({ ...DARK, startUtc: 'bad' }).ok).toBe(false)
    expect(nav.view).toBe('compare')
  })
})

describe('mission playback and evidence on the time strip', () => {
  it('an active mission band does not hide the evidence window: both are drawn', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const site = { id: 'malapert-massif', name: 'Malapert Massif', lat: -86, lon: 0, source: '', ground_height_m: 0, observer_height_m: 2, summary: {} as never, data_start_utc: '2026-01-01T00:00:00Z', data_stop_utc: '2031-01-01T00:00:00Z' }
    const t0 = Date.parse('2027-03-01T00:00:00Z')
    const html = renderToString(
      <TimeBar site={site} steps={[0, 1].map((h) => ({
        time_utc: new Date(t0 + h * 3600e3).toISOString(),
        sun: { azimuth_deg: 10, elevation_deg: 1, horizon_deg: 0, visible_fraction: 1, visible: true },
        earth: { azimuth_deg: 0, elevation_deg: 5, horizon_deg: 0, visible: true, margin_deg: 5 },
      }))} win={[t0, t0 + 14 * 86400e3]} windowDays={14} onWindowDays={() => {}} loading={false}
        mission={{ start: t0, end: t0 + 7 * 86400e3, failures: [] }}
        evidence={{ start: Date.parse(DARK.startUtc), end: Date.parse(DARK.endUtc!), point: false, dataMissing: false }} />,
    )
    expect(html).toContain('data-testid="evidence-band"')
    expect(html).toContain('Evidence window')
    expect(html).toContain('Mission')
    vi.unstubAllGlobals()
  })
})
