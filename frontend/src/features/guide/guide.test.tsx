// "Try a mission": the orchestration drives the shared stores (running plan, Rescue, assessment, evidence, comparison)
// and every stage reads the live result. Backend responses are the real API responses for the mission definition
// (captured by backend/scripts/make_mission_fixtures.py), served through a mocked fetch.
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNav } from './nav'
import { markEvidenceShown, takeEvidence, useEvidence } from '../../viz/evidence'
import type { AssessResponse } from '../assessment/types'
import { scenarioKey, useAssessmentStore } from '../assessment/useAssessmentStore'
import { useCompareStore } from '../compare/useCompareStore'
import { usePlansStore } from '../plans/usePlansStore'
import type { RescueResponse } from '../rescue/types'
import { useRescueStore } from '../rescue/useRescueStore'
import { useTutorialStore } from '../tutorial/useTutorialStore'
import assessDisrupted from './__fixtures__/assess-disrupted.json'
import assessOriginal from './__fixtures__/assess-original.json'
import assessRecovery from './__fixtures__/assess-recovery.json'
import compareRes from './__fixtures__/compare.json'
import rescueRes from './__fixtures__/rescue.json'
import { GuideCard } from './GuideCard'
import {
  checkDisrupted,
  checkOriginal,
  disruptedScenario,
  evidenceWindow,
  MISSION,
  originalScenario,
  recoveryCandidates,
  statusChanges,
} from './missionDefinition'
import { snapshot, stageIndex, stageModel, STAGES, useGuide } from './mission'

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

let rescueBody: unknown = rescueRes
let rescueGate: Promise<void> | null = null
let failRescue = false

/** The compare fixture answers under the keys of whatever the store sends (same order: original, disrupted, recovery). */
function compareFor(body: { scenarios: { key: string }[] }) {
  let text = JSON.stringify(compareRes)
  for (const [i, k] of ['original', 'disrupted', 'recovery'].entries()) text = text.split(`"${k}"`).join(JSON.stringify(body.scenarios[i].key))
  return JSON.parse(text)
}

beforeEach(() => {
  usePlansStore.setState({ plans: [], activeId: null, compareIds: [] })
  useAssessmentStore.setState({ results: {}, showing: null, target: 'original' })
  useCompareStore.setState({ scenarios: [], selectedIds: [], results: {}, rescueContext: null, rankingSetKey: null, rankingGroups: [], rankingPairs: [], allowDemo: false })
  useRescueStore.getState().reset()
  useRescueStore.setState({ original: null, change: { launch_delay_days: 0, requirement_overrides: {} } })
  rescueBody = rescueRes
  rescueGate = null
  failRescue = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (url.includes('/api/viability/assess-scenario')) {
      const k = scenarioKey(body.scenario)
      if (k === scenarioKey(originalScenario())) return json(assessOriginal)
      if (k === scenarioKey(disruptedScenario())) return json(assessDisrupted)
      return json(assessRecovery)
    }
    if (url.includes('/api/rescue')) {
      if (rescueGate) await rescueGate
      if (failRescue) throw new TypeError('Failed to fetch')
      return json(rescueBody)
    }
    if (url.includes('/api/compare')) return json(compareFor(body))
    return json([])
  }))
})
afterEach(() => {
  useGuide.getState().exit()
  vi.unstubAllGlobals()
})

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
const model = () => stageModel(snapshot())
/** Stand in for the 3D view: take the pending evidence request and mark it shown. */
const viewerShows = () => {
  const r = takeEvidence()
  if (r) markEvidenceShown(r)
}

async function advanceTo(id: (typeof STAGES)[number]['id']) {
  const target = stageIndex(id)
  while (useGuide.getState().stage < target) {
    useGuide.getState().next()
    await flush()
    if (STAGES[useGuide.getState().stage].id === 'evidence') viewerShows()
  }
}

describe('mission definition', () => {
  it('declares a pure date shift and is verified against the captured real responses', () => {
    const o = originalScenario(), d = disruptedScenario()
    expect(new Date(d.landing_utc).getTime() - new Date(o.landing_utc).getTime()).toBe(MISSION.disruption.launch_delay_days * 86_400_000)
    expect(d.duration_days).toBe(o.duration_days)
    expect(d.requirements).toEqual(o.requirements)
    const oa = (assessOriginal as unknown as AssessResponse).assessment
    const da = (assessDisrupted as unknown as AssessResponse).assessment
    expect(checkOriginal(oa)).toEqual({ ok: true })
    expect(checkDisrupted(da)).toEqual({ ok: true })
    expect(statusChanges(oa, da).map((c) => [c.id, c.from, c.to])).toEqual([['max_communication_blackout', 'pass', 'fail']])
    expect(evidenceWindow(da).check).toEqual({ ok: true })
    const rec = recoveryCandidates(rescueRes as unknown as RescueResponse)
    expect(rec.length).toBeGreaterThan(0)
    expect(rec.every((a) => a.scenario.duration_days === o.duration_days)).toBe(true)
    expect(MISSION.provenance.datasets.every((x) => /^[0-9a-f]{64}$/.test(x.sha256))).toBe(true)
  })

  it('reports an outdated baseline instead of narrating a failure the result does not show', () => {
    const da = clone((assessDisrupted as unknown as AssessResponse).assessment)
    da.eligibility = 'pass'
    for (const c of da.constraints) if (c.status === 'fail') c.status = 'pass'
    const chk = checkDisrupted(da)
    expect(chk.ok).toBe(false)
    expect(!chk.ok && chk.reason).toMatch(/PASS; the example was verified with FAIL/)
  })
})

describe('guided mission flow', () => {
  it('starts on the mission with the definition as the running plan, without duplicating plans on restart', async () => {
    usePlansStore.getState().add('My own plan', originalScenario()) // a user plan: must survive
    useGuide.getState().start()
    await flush()
    expect(useGuide.getState()).toMatchObject({ active: true, stage: 0 })
    expect(scenarioKey(useRescueStore.getState().original!)).toBe(scenarioKey(originalScenario()))
    expect(useNav.getState().view).toBe('planner')
    expect(model().status).toBe('ready')
    const plans = usePlansStore.getState().plans.length
    for (let i = 0; i < 3; i++) {
      useGuide.getState().restart()
      await flush()
    }
    expect(usePlansStore.getState().plans.length).toBe(plans)
    expect(usePlansStore.getState().plans.some((p) => p.name === 'My own plan')).toBe(true)
  })

  it('walks PASS -> delay -> FAIL -> evidence -> Rescue -> comparison from live results', async () => {
    useGuide.getState().start()
    await flush()
    await advanceTo('original')
    expect(model()).toMatchObject({ status: 'ready' })
    expect(model().lead).toMatch(/PASSES every requirement/)

    await advanceTo('delay')
    expect(useRescueStore.getState().change.launch_delay_days).toBe(MISSION.disruption.launch_delay_days) // the normal control
    expect(useAssessmentStore.getState().target).toBe('changed')

    await advanceTo('changed')
    const m = model()
    expect(m.status).toBe('ready')
    expect(m.rows).toEqual([expect.objectContaining({ name: 'Maximum direct-to-Earth line-of-sight blackout', before: '22 h', after: '118 h', from: 'pass', to: 'fail' })])

    useGuide.getState().next()
    await flush()
    expect(model().status).toBe('working') // the 3D view has not shown it yet: no pretending
    viewerShows()
    expect(model().status).toBe('ready')
    const ev = useEvidence.getState().highlight!
    expect(new Date(ev.startUtc).getTime()).toBe(new Date(MISSION.expected.evidence.start_utc).getTime())
    expect(ev.body).toBe('earth')

    await advanceTo('rescue')
    await flush(12)
    expect(useGuide.getState().recovery?.site.id).toBe('malapert-massif')
    expect(useRescueStore.getState().selected?.site.id).toBe('malapert-massif')
    expect(model().status).toBe('ready')
    expect(model().lead).toMatch(/same date, different site/)

    await advanceTo('compare')
    await useCompareStore.getState().refresh()
    await flush()
    const cs = useCompareStore.getState()
    const ids = useGuide.getState().compareIds
    expect(cs.selectedIds).toEqual(ids)
    expect(ids.map((id) => cs.rescueContext!.roles[id].role)).toEqual(['original', 'changed', 'alternative'])
    expect(cs.scenarios.find((s) => s.id === ids[2])!.site.id).toBe('malapert-massif')
    expect(cs.baselineId).toBe(ids[0])
    expect(useNav.getState().view).toBe('compare')
    const cm = model()
    expect(cm.status).toBe('ready')
    expect(cm.lead).toMatch(/recommends the recovery/)
  })

  it('pauses with a clear "modified" state when the user edits the guided inputs', async () => {
    useGuide.getState().start()
    await flush()
    await advanceTo('delay')
    useRescueStore.getState().setChange({ launch_delay_days: 9 })
    expect(model().status).toBe('modified')
    expect(model().primary.action).toBe('restart')
  })

  it('an older Rescue request cannot overwrite a newer step', async () => {
    useGuide.getState().start()
    await flush()
    await advanceTo('evidence')
    let release!: () => void
    rescueGate = new Promise((r) => (release = r))
    useGuide.getState().next() // rescue starts, then the user goes back before it answers
    await flush()
    useGuide.getState().back()
    release()
    await flush(12)
    expect(STAGES[useGuide.getState().stage].id).toBe('evidence')
    expect(useGuide.getState().recovery).toBeNull()
  })

  it('a failed Rescue offers retry, and retry recovers', async () => {
    useGuide.getState().start()
    await flush()
    await advanceTo('evidence')
    failRescue = true
    useGuide.getState().next()
    await flush(12)
    expect(model()).toMatchObject({ status: 'error', primary: { action: 'retry' } })
    failRescue = false
    useGuide.getState().retry()
    await flush(12)
    expect(model().status).toBe('ready')
  })

  it('Rescue without a qualifying recovery is reported as outdated, not narrated', async () => {
    const r = clone(rescueRes) as unknown as RescueResponse
    r.alternatives = []
    rescueBody = r
    useGuide.getState().start()
    await flush()
    await advanceTo('rescue')
    await flush(12)
    expect(model().status).toBe('outdated')
  })

  it('opening the feature tutorial stops the story; exit leaves the user’s tools as they are', async () => {
    useGuide.getState().start()
    await flush()
    useTutorialStore.getState().startTour(0)
    expect(useGuide.getState().active).toBe(false)
    useTutorialStore.getState().skipTour()
    useGuide.getState().start()
    await flush()
    await advanceTo('delay')
    useGuide.getState().exit()
    expect(useGuide.getState().active).toBe(false)
    expect(useRescueStore.getState().change.launch_delay_days).toBe(MISSION.disruption.launch_delay_days)
  })

  it('the card renders progress, the stage and one primary action', async () => {
    useGuide.getState().start()
    await flush()
    // Server rendering reads a store's initial state: render the card for the running story.
    const init = useGuide.getInitialState()
    const saved = { active: init.active, stage: init.stage }
    Object.assign(init, { active: true, stage: 0 })
    const html = renderToString(<GuideCard />).replace(/<!-- -->/g, "")
    Object.assign(init, saved)
    expect(html).toContain('step 1 of 8')
    expect(html).toContain('Your mission')
    expect(html).toContain('aria-current="step"')
    expect(html).toContain('Assess the original plan')
    expect(html).toContain('Restart')
    expect(html).toContain('Exit and explore')
  })
})
