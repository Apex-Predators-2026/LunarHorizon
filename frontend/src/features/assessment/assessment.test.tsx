// Mission assessment + "Show why" on real /api/viability/assess-scenario responses (backend
// scripts/make_assessment_fixtures.py: Connecting Ridge FAIL, Malapert PASS, Connecting Ridge beyond the data).
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '../../store'
import { DEFAULT_REQUIREMENTS, type Scenario } from '../../types'
import { clearEvidence, markEvidenceShown, showEvidence, takeEvidence, useEvidence } from '../../viz/evidence'
import { useRescueStore } from '../rescue/useRescueStore'
import beyond from './__fixtures__/assess-beyond-data.json'
import fail from './__fixtures__/assess-fail.json'
import pass from './__fixtures__/assess-pass.json'
import { evidenceForConstraint, fmtMetric, fmtValue, orderedConstraints, thresholdText } from './logic'
import { EvidenceBanner, MissionAssessment } from './MissionAssessment'
import type { AssessResponse } from './types'
import { scenarioKey, useAssessmentStore } from './useAssessmentStore'

const FAIL = fail as unknown as AssessResponse
const PASS = pass as unknown as AssessResponse
const BEYOND = beyond as unknown as AssessResponse
const constraint = (r: AssessResponse, id: string) => r.assessment.constraints.find((c) => c.constraint_id === id)!

// renderToString reads a zustand store's initial state (server snapshot): seed both for SSR renders.
const seed = <T extends object>(store: { setState: (p: Partial<T>) => void; getInitialState: () => T }, patch: Partial<T>) => {
  store.setState(patch)
  Object.assign(store.getInitialState(), patch)
}

const scenario: Scenario = {
  site: { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767 },
  landing_utc: '2027-03-01T00:00:00.000Z',
  duration_days: 14,
  requirements: DEFAULT_REQUIREMENTS,
}

beforeEach(() => {
  useAssessmentStore.setState({ results: {}, showing: null })
  clearEvidence()
})
afterEach(() => vi.unstubAllGlobals())

describe('formatting', () => {
  it('shows engine units in plain units and keeps intervals', () => {
    expect(fmtValue(226800, 's')).toBe('63 h')
    expect(fmtValue(345600, 's')).toBe('96 h (4.0 d)')
    expect(fmtValue(0.5, 'fraction')).toBe('50.0%')
    expect(fmtMetric({ status: 'bounded', unit: 's', value: null, lower: 3600, upper: 7200, reason: null })).toBe('1 h – 2 h')
    expect(fmtMetric({ status: 'unavailable', unit: 's', value: null, lower: null, upper: null, reason: 'x' })).toBe('no data')
    expect(thresholdText(constraint(FAIL, 'max_continuous_darkness'))).toBe('≤ 50 h')
  })

  it('lists failures first and hides constraints that are not configured', () => {
    const list = orderedConstraints(FAIL.assessment)
    expect(list.every((c) => c.status !== 'not_applicable')).toBe(true)
    expect(list[0].status).toBe('fail')
  })
})

describe('Show why: evidence for a constraint', () => {
  it('a violated darkness limit points at its measured window, toward the Sun', () => {
    const c = constraint(FAIL, 'max_continuous_darkness')
    expect(c.status).toBe('fail')
    const ev = evidenceForConstraint(FAIL.assessment, c)!
    expect(ev.role).toBe('measured')
    expect(ev.request).toMatchObject({ siteId: 'connecting-ridge', body: 'sun', startUtc: c.evidence_windows[0].start_utc, endUtc: c.evidence_windows[0].end_utc, dataMissing: false })
    expect(ev.caption).toContain('63 h')
    expect(ev.request.detail).toContain('from landing') // clipped_at_start: the lander lands in darkness
  })

  it('a blackout limit looks toward Earth', () => {
    const ev = evidenceForConstraint(FAIL.assessment, constraint(FAIL, 'max_communication_blackout'))!
    expect(ev.request.body).toBe('earth')
  })

  it('a percentage requirement is offered an illustration, labelled as such', () => {
    const c = constraint(FAIL, 'min_mean_solar_disk_fraction')
    expect(c.evidence_windows).toEqual([])
    const ev = evidenceForConstraint(FAIL.assessment, c)
    if (ev) {
      expect(ev.role).toBe('illustrative')
      expect(ev.caption).toMatch(/^Longest/)
    }
  })

  it('UNKNOWN beyond the data is never shown as measured physics', () => {
    expect(BEYOND.assessment.eligibility).toBe('unknown')
    const blackout = constraint(BEYOND, 'max_communication_blackout')
    expect(blackout.status).toBe('unknown')
    const ev = evidenceForConstraint(BEYOND.assessment, blackout)!
    expect(ev.role).toBe('missing_data')
    expect(ev.request.dataMissing).toBe(true)
    const dark = evidenceForConstraint(BEYOND.assessment, constraint(BEYOND, 'max_continuous_darkness'))!
    expect(dark.caption).toContain('at least')
    expect(dark.caption).toContain('undecided')
  })

  it('never invents a window when the engine gave none', () => {
    const a = { ...FAIL.assessment, windows: [] }
    const c = { ...constraint(FAIL, 'min_earth_visibility_percent'), evidence_windows: [] }
    expect(evidenceForConstraint(a, c)).toBeNull()
    expect(evidenceForConstraint(a, { ...c, status: 'not_applicable' })).toBeNull()
  })

  it('showEvidence moves the shared timeline when the 3D view handles it (state synchronisation)', () => {
    // Scene subscribes to useEvidence; emulate its handler to check the request carries everything it needs.
    const ev = evidenceForConstraint(FAIL.assessment, constraint(FAIL, 'max_continuous_darkness'))!
    const unsub = useEvidence.subscribe((st) => {
      const r = st.request
      if (!r) return
      useAppStore.getState().setPlaying(false)
      useAppStore.getState().setSite(r.siteId)
      useAppStore.getState().setTime(new Date(Date.parse(r.startUtc)).toISOString())
    })
    useAppStore.setState({ playing: true })
    showEvidence(ev.request)
    unsub()
    expect(useAppStore.getState()).toMatchObject({ playing: false, siteId: 'connecting-ridge', timeUtc: '2027-03-01T00:00:00.000Z' })
  })
})

describe('MissionAssessment panel', () => {
  const render = (r: AssessResponse | null, opts: { error?: { message: string; httpStatus: number } } = {}) => {
    seed(useRescueStore, { original: scenario, selected: null })
    const key = scenarioKey(scenario)
    seed(useAssessmentStore, {
      results: opts.error ? { [key]: { status: 'error', ...opts.error } } : r ? { [key]: { status: 'done', response: r } } : { [key]: { status: 'loading' } },
    })
    return renderToString(<MissionAssessment />)
  }

  it('FAIL: verdict, thresholds, measurements, margins, Show why and limitations', () => {
    const html = render(FAIL)
    expect(html).toContain('Fails')
    expect(html).toContain('Breaks at least one operational requirement')
    expect(html).toContain('Maximum continuous power-darkness')
    expect(html).toContain('≤ 50 h')
    expect(html).toContain('63 h')
    expect(html).toContain('−13 h') // margin = limit - measured
    expect(html).toContain('Show why')
    expect(html).toContain('descriptive only, not ranked')
    expect(html).toContain('Solar illumination is not electrical power generation')
    expect(html).toContain('JPL Horizons')
  })

  it('PASS shows an exact, rank-eligible score', () => {
    const html = render(PASS)
    expect(html).toContain('Passes')
    expect(html).toContain('78.0')
    expect(html).toContain('rank-eligible')
  })

  it('UNKNOWN is Unknown, explains the missing data and shows no score', () => {
    const html = render(BEYOND)
    expect(html).toContain('Cannot be decided')
    expect(html).not.toMatch(/>\s*Fails\s*</)
    expect(html).toContain('This is not a failure')
    expect(html).toContain('Not scored – eligibility undecided')
    expect(html).toContain('outside the site data')
    expect(html).toContain('Undecided')
  })

  it('loading and error states are explicit', () => {
    expect(render(null)).toContain('Assessing with the canonical viability engine')
    const err = render(null, { error: { message: 'Backend unavailable: start the API server', httpStatus: 0 } })
    expect(err).toContain('Backend unavailable')
    expect(err).toContain('Retry')
    expect(render(null, { error: { message: 'no file', httpStatus: 404 } })).toContain('has no precomputed scientific data')
  })

  it('the evidence banner gives a way back and labels missing data', () => {
    const ev = evidenceForConstraint(BEYOND.assessment, constraint(BEYOND, 'max_communication_blackout'))!
    showEvidence({ ...ev.request, origin: { kind: 'assessment', label: 'Mission assessment' } })
    const taken = takeEvidence()! // what the 3D view does on receiving it
    markEvidenceShown(taken)
    seed(useEvidence, { request: taken, highlight: useEvidence.getState().highlight })
    seed(useAssessmentStore, { showing: 'x' })
    const html = renderToString(<EvidenceBanner />)
    expect(html).toContain('Data missing')
    expect(html).toContain('undecided, not failed')
    expect(html).toContain('nothing there is a confirmed physical obstruction')
    expect(html).toContain('Back to assessment')
    useAssessmentStore.getState().clearShowing()
    expect(useEvidence.getState().request).toBeNull()
    expect(useEvidence.getState().highlight).toBeNull()
    seed(useEvidence, { request: null, highlight: null })
    seed(useAssessmentStore, { showing: null })
    expect(renderToString(<EvidenceBanner />)).toBe('')
  })

  it('fetches the canonical assessment once per scenario and reports network failure', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => FAIL }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    await useAssessmentStore.getState().assess(scenario)
    await useAssessmentStore.getState().assess(scenario)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]).toBeDefined()
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/viability/assess-scenario')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const other = { ...scenario, duration_days: 7 }
    await useAssessmentStore.getState().assess(other)
    const st = useAssessmentStore.getState().results[scenarioKey(other)]
    expect(st.status === 'error' && st.message).toMatch(/Backend unavailable/)
  })
})
