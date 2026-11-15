// Real /api/viability/assess-scenario responses (__fixtures__, written from the backend):
//   assess-fail.json    Malapert Massif, 14 d, initial sunlight required >= 500 h (longer than the mission) -> FAIL
//   assess-unknown.json Malapert Massif, 30 d from 2031-12-30, past the end of the data -> UNKNOWN
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssessmentPanel } from '../features/assessment'
import type { Scenario } from '../types'
import { DEFAULT_REQUIREMENTS } from '../types'
import failJson from './__fixtures__/assess-fail.json'
import unknownJson from './__fixtures__/assess-unknown.json'
import {
  clearAssessmentCache,
  constraintViews,
  fetchAssessment,
  fmtMetric,
  fmtThreshold,
  scoreText,
  type AssessResponse,
} from './assessment'
import { fetchPlanVerdict } from './planVerdict'

const fail = failJson as unknown as AssessResponse
const unknown = unknownJson as unknown as AssessResponse

describe('constraint views: the engine numbers, unit-converted only', () => {
  it('puts the failed requirement first, with measured value, threshold, margin, headroom and evidence', () => {
    const { configured, notConfigured } = constraintViews(fail.assessment)
    expect(configured[0].c.constraint_id).toBe('min_initial_sunlight')
    expect(configured[0].c.status).toBe('fail')
    expect(configured[0].measured).toBe('14.0 d (336 h)')
    expect(configured[0].threshold).toBe('≥ 20.8 d (500 h)')
    expect(configured[0].marginText).toMatch(/^-/) // negative margin: short of the requirement
    expect(configured[0].headroom?.level).toBe('high')
    expect(configured[0].c.evidence_windows[0].kind).toBe('power_lit')
    expect(configured.map((v) => v.c.status).slice(1)).not.toContain('fail')
    expect(notConfigured.every((c) => c.status === 'not_applicable')).toBe(true)
  })

  it('keeps UNKNOWN undecided: unavailable measurement, a proven range as margin, the reason in words', () => {
    const { configured } = constraintViews(unknown.assessment)
    const dark = configured.find((v) => v.c.constraint_id === 'max_continuous_darkness')!
    expect(dark.c.status).toBe('unknown')
    expect(dark.measured).toBe('unavailable')
    expect(dark.marginText).toMatch(/^between -.* and \+50 h$/)
    expect(dark.unknownReason).toBe('no data covers this part of the mission')
  })

  it('never shows a missing score as 0', () => {
    expect(scoreText(unknown.ranking_status)).toBe('withheld: eligibility is UNKNOWN (not a score of 0)')
    expect(scoreText({ ...unknown.ranking_status, score_status: 'bounded', score_bounds: { status: 'bounded', unit: '', value: null, lower: 40, upper: 62.25, reason: null } })).toBe(
      'between 40 and 62.3',
    )
  })

  it('formats metrics and thresholds by unit', () => {
    expect(fmtMetric({ status: 'known', unit: 'percent', value: 73.25, lower: null, upper: null, reason: null })).toBe('73.3 %')
    expect(fmtMetric({ status: 'known', unit: 'fraction', value: 0.5, lower: null, upper: null, reason: null })).toBe('0.5')
    expect(fmtMetric({ status: 'known', unit: 's', value: 7200, lower: null, upper: null, reason: null }, true)).toBe('+2 h')
    expect(fmtMetric({ status: 'not_applicable', unit: 's', value: null, lower: null, upper: null, reason: null })).toBe('not applicable')
    expect(fmtThreshold({ comparison: 'at_most', threshold: 180000, unit: 's' })).toBe('≤ 50 h')
    expect(fmtThreshold({ comparison: null, threshold: null, unit: 's' })).toBe('not configured')
  })
})

describe('AssessmentPanel', () => {
  it('shows the failed requirement, its evidence with a 3D jump, provenance and limitations', () => {
    const html = renderToString(<AssessmentPanel state={{ status: 'done', response: fail }} />)
    expect(html).toContain('Minimum continuous power-lit time after landing')
    expect(html).toContain('Failed')
    expect(html).toContain('Show in 3D')
    expect(html).toContain('JPL Horizons')
    expect(html).toContain('Moon Trek')
    expect(html).toContain(fail.input_dataset.sha256.slice(0, 16))
    expect(html).toContain('Solar illumination is not electrical power generation')
    expect(html).toContain('Not configured, so not evaluated')
  })

  it('says undecided, not failed, past the end of the data', () => {
    const html = renderToString(<AssessmentPanel state={{ status: 'done', response: unknown }} />)
    expect(html).toContain('Undecided')
    expect(html).not.toContain('>Failed<')
    expect(html).toContain('withheld: eligibility is UNKNOWN')
    expect(html).toContain('the mission runs outside it')
  })

  it('has no verdict while loading or after an error', () => {
    expect(renderToString(<AssessmentPanel state={{ status: 'loading' }} />)).toContain('Assessing')
    const err = renderToString(<AssessmentPanel state={{ status: 'error', message: 'backend unavailable' }} />).replace(/<!-- -->/g, '')
    expect(err).toContain('Not assessed: backend unavailable')
    expect(err).not.toMatch(/PASS|FAIL/)
  })
})

describe('one request serves the card verdict and the panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    clearAssessmentCache()
  })

  it('asks the engine once per plan revision, with explanation details', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fail), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const sc: Scenario = {
      site: { id: 'malapert-massif', name: 'Malapert Massif', lat: -86, lon: -2.4 },
      landing_utc: '2027-10-15T00:00:00Z',
      duration_days: 14,
      requirements: { ...DEFAULT_REQUIREMENTS, min_initial_sun_hours: 500 },
    }
    const verdict = await fetchPlanVerdict(sc)
    const full = await fetchAssessment(sc)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.include_explanation_details).toBe(true)
    expect(verdict).toMatchObject({ status: 'done', eligibility: 'fail' })
    expect(verdict.status === 'done' && verdict.failed[0]).toMatch(/power-lit time/)
    expect(full.status).toBe('done')
  })

  it('does not cache errors (retryable, never a verdict)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: 'custom sites are not precomputed' }), { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const sc: Scenario = { site: { id: 'custom:x', name: 'x', lat: -89, lon: 0 }, landing_utc: '2027-01-01T00:00:00Z', duration_days: 1, requirements: DEFAULT_REQUIREMENTS }
    expect(await fetchAssessment(sc)).toEqual({ status: 'error', message: 'custom sites are not precomputed' })
    await fetchAssessment(sc)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
