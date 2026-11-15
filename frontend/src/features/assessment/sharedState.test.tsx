// The shared canonical-assessment state: one request per exact mission, no stale attachment after an edit, retry after
// failure, the Planner-card adapter reading the same state, and the panel's progressive disclosure.
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchPlanVerdict, toPlanVerdict } from '../../lib/planVerdict'
import { DEFAULT_REQUIREMENTS, type Scenario } from '../../types'
import { clearEvidence } from '../../viz/evidence'
import { useRescueStore } from '../rescue/useRescueStore'
import beyond from './__fixtures__/assess-beyond-data.json'
import fail from './__fixtures__/assess-fail.json'
import pass from './__fixtures__/assess-pass.json'
import { evidenceForConstraint } from './logic'
import { MissionAssessment } from './MissionAssessment'
import type { AssessResponse } from './types'
import { scenarioKey, useAssessmentStore } from './useAssessmentStore'

const FAIL = fail as unknown as AssessResponse
const PASS = pass as unknown as AssessResponse
const BEYOND = beyond as unknown as AssessResponse

const plan: Scenario = {
  site: { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767 },
  landing_utc: '2027-03-01T00:00:00.000Z',
  duration_days: 14,
  requirements: DEFAULT_REQUIREMENTS,
}
const edited: Scenario = { ...plan, duration_days: 10 }

const seed = <T extends object>(store: { setState: (p: Partial<T>) => void; getInitialState: () => T }, patch: Partial<T>) => {
  store.setState(patch)
  Object.assign(store.getInitialState(), patch)
}
const ok = (body: AssessResponse) => ({ ok: true, status: 200, json: async () => body }) as Response

beforeEach(() => {
  useAssessmentStore.setState({ results: {}, showing: null })
  clearEvidence()
})
afterEach(() => vi.unstubAllGlobals())

describe('one request per exact mission', () => {
  it('the panel layer and the plan-card adapter share a single canonical request', async () => {
    const fetchMock = vi.fn(async () => ok(PASS))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b, c] = await Promise.all([
      useAssessmentStore.getState().assess(plan),
      fetchPlanVerdict(plan),
      useAssessmentStore.getState().assess({ ...plan }), // an equal copy is the same mission
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a.status).toBe('done')
    expect(c.status).toBe('done')
    expect(b).toEqual({ status: 'done', eligibility: 'pass', failed: [], undecided: [] })
  })

  it('a different duration, landing or requirement is a different mission', () => {
    const k = scenarioKey(plan)
    expect(scenarioKey(edited)).not.toBe(k)
    expect(scenarioKey({ ...plan, landing_utc: '2027-03-01T01:00:00.000Z' })).not.toBe(k)
    expect(scenarioKey({ ...plan, requirements: { ...plan.requirements, battery_hours: 51 } })).not.toBe(k)
    expect(scenarioKey({ ...plan, landing_utc: '2027-03-01T00:00:00Z' })).toBe(k) // same instant, written differently
  })
})

describe('edited missions never show an old response', () => {
  it('a slow response for the old mission lands under the old key only', async () => {
    let release!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = res })))
    const slow = useAssessmentStore.getState().assess(plan)
    // The user edits the mission while the first request is still in flight.
    vi.stubGlobal('fetch', vi.fn(async () => ok(FAIL)))
    await useAssessmentStore.getState().assess(edited)
    release(ok(PASS))
    await slow
    const results = useAssessmentStore.getState().results
    expect(results[scenarioKey(edited)]).toMatchObject({ status: 'done', response: { assessment: { eligibility: 'fail' } } })
    expect(results[scenarioKey(plan)]).toMatchObject({ status: 'done', response: { assessment: { eligibility: 'pass' } } })
    // What the card of the edited plan reads is its own answer, not the old PASS.
    expect(toPlanVerdict(results[scenarioKey(edited)])).toMatchObject({ status: 'done', eligibility: 'fail' })
  })

  it('an edited mission with no answer yet has no verdict (loading), never the previous one', () => {
    seed(useAssessmentStore, { results: { [scenarioKey(plan)]: { status: 'done', response: PASS } } })
    expect(toPlanVerdict(useAssessmentStore.getState().results[scenarioKey(edited)])).toEqual({ status: 'loading' })
  })
})

describe('errors, unavailable data and retry', () => {
  it('maps failures to "no verdict" and retries with a new request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const first = await useAssessmentStore.getState().assess(plan)
    expect(first).toMatchObject({ status: 'error', httpStatus: 0 })
    expect(toPlanVerdict(first)).toEqual({ status: 'error', message: 'backend unavailable' })

    const fetchMock = vi.fn(async () => ok(BEYOND))
    vi.stubGlobal('fetch', fetchMock)
    const retry = await useAssessmentStore.getState().assess(plan)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(retry.status).toBe('done')
    expect(toPlanVerdict(retry)).toMatchObject({ status: 'done', eligibility: 'unknown' }) // UNKNOWN stays UNKNOWN
  })

  it('a 404 says there is no scientific data for the site', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ detail: 'no file' }) }) as Response))
    const s = await useAssessmentStore.getState().assess(plan)
    expect(toPlanVerdict(s)).toEqual({ status: 'error', message: 'no scientific data for this site' })
  })
})

describe('panel: progressive disclosure and evidence honesty', () => {
  const render = (r: AssessResponse) => {
    seed(useRescueStore, { original: plan, selected: null })
    seed(useAssessmentStore, { results: { [scenarioKey(plan)]: { status: 'done', response: r } } })
    return renderToString(<MissionAssessment />).replace(/<!-- -->/g, '')
  }
  const metGroup = /<details[^>]*><summary[^>]*>\d+ requirements? met/

  it('FAIL leads with the failing requirement and keeps the met ones collapsed', () => {
    const html = render(FAIL)
    expect(html).toContain('Requirements that fail or cannot be decided')
    expect(html).toContain('data-testid="assessment-decision"')
    expect(html).toContain('Evaluated ')
    expect(html).toContain('on the hourly grid')
    expect(html).toContain('aria-label="Show why: ')
    const met = metGroup.exec(html)
    expect(met).not.toBeNull()
    expect(met![0]).not.toContain(' open')
  })

  it('PASS has nothing to flag, so the met requirements are open', () => {
    const html = render(PASS)
    expect(html).not.toContain('Requirements that fail or cannot be decided')
    const met = metGroup.exec(html)
    expect(met).not.toBeNull()
    expect(met![0]).toContain(' open')
  })

  it('UNKNOWN with no usable window offers no Show why for that row and invents nothing', () => {
    const c = BEYOND.assessment.constraints.find((x) => x.status === 'unknown')!
    const bare = { ...BEYOND.assessment, windows: [] }
    expect(evidenceForConstraint(bare, { ...c, evidence_windows: [] })).toBeNull()
    const html = render({
      ...BEYOND,
      assessment: { ...BEYOND.assessment, constraints: BEYOND.assessment.constraints.map((x) => ({ ...x, evidence_windows: [] })), windows: [] },
    })
    expect(html).toContain('No time window to show for this requirement.')
    expect(html).toContain('This is not a failure')
  })
})
