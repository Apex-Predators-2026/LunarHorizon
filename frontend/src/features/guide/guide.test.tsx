// "Try a mission": the orchestration drives the shared stores (running plan, Rescue, assessment, evidence, comparison)
// and every stage reads the live result. Backend responses are the real API responses for the mission definition
// (captured by backend/scripts/make_mission_fixtures.py), served through a mocked fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNav } from './nav'
import { useEvidence } from '../../viz/evidence'
import type { AssessResponse } from '../assessment/types'
import { scenarioKey, useAssessmentStore } from '../assessment/useAssessmentStore'
import { useCompareStore } from '../compare/useCompareStore'
import { usePlansStore } from '../plans/usePlansStore'
import type { RescueResponse } from '../rescue/types'
import { useRescueStore } from '../rescue/useRescueStore'
import assessDisrupted from './__fixtures__/assess-disrupted.json'
import assessOriginal from './__fixtures__/assess-original.json'
import { flush, resetMissionStores, stubMissionFetch, viewerShows, type MissionApiControls } from './__fixtures__/mockApi'
import rescueRes from './__fixtures__/rescue.json'
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
import { plainName, snapshot, stageIndex, stageModel, STAGES, useGuide, withDays } from './mission'

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

let api: MissionApiControls

beforeEach(() => {
  resetMissionStores()
  api = stubMissionFetch()
})
afterEach(() => {
  useGuide.getState().exit()
  vi.unstubAllGlobals()
})

const model = () => stageModel(snapshot())

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

describe('plain live text', () => {
  it('adds days to long hour values only', () => {
    expect(withDays('22 h')).toBe('22 h')
    expect(withDays('118 h')).toBe('118 h (4.9 days)')
    expect(withDays('96 h')).toBe('96 h (4 days)')
    expect(withDays('48 h')).toBe('48 h (2 days)')
    expect(withDays('93.5%')).toBe('93.5%')
    expect(withDays('unavailable')).toBe('unavailable')
  })

  it('maps engine requirement names to plain labels, keeping unknown ids', () => {
    const da = (assessDisrupted as unknown as AssessResponse).assessment
    const c = da.constraints.find((x) => x.constraint_id === 'max_communication_blackout')!
    expect(plainName(c)).toBe('Longest time Earth is out of sight')
    expect(plainName({ ...c, constraint_id: 'something_else', name: 'Engine name' })).toBe('Engine name')
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
    expect(m.rows).toEqual([expect.objectContaining({ name: 'Longest time Earth is out of sight', before: '22 h', after: '118 h (4.9 days)', limit: '≤ 96 h (4 days)', from: 'pass', to: 'fail' })])
    expect(m.facts[0].value).toMatch(/^Longest time Earth is out of sight: 118 h \(4\.9 days\)/)

    useGuide.getState().next()
    await flush()
    expect(model().status).toBe('working') // the 3D view has not shown it yet: no pretending
    viewerShows()
    expect(model().status).toBe('ready')
    const ev = useEvidence.getState().highlight!
    expect(new Date(ev.startUtc).getTime()).toBe(new Date(MISSION.expected.evidence.start_utc).getTime())
    expect(ev.body).toBe('earth')
    const em = model()
    expect(em.lead).not.toContain('direct-to-Earth link')
    expect(em.lead).toContain('Earth drops out of view')
    if (MISSION.expected.evidence.clipped_at_end) expect(em.note).toContain('Earth is still out of view when the mission ends')

    await advanceTo('rescue')
    await flush(12)
    expect(useGuide.getState().recovery?.site.id).toBe('malapert-massif')
    expect(useRescueStore.getState().selected?.site.id).toBe('malapert-massif')
    expect(model().status).toBe('ready')
    expect(model().lead).toMatch(/keeps the delayed landing date and moves to another site/)
    expect(model().facts).toContainEqual(expect.objectContaining({ label: 'Moved', value: '143 km from the original site' }))

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
    expect(cm.lead).toMatch(/recovery ranks first/)
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
    api.setRescueGate(new Promise((r) => (release = r)))
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
    api.setFailRescue(true)
    useGuide.getState().next()
    await flush(12)
    expect(model()).toMatchObject({ status: 'error', primary: { action: 'retry' } })
    api.setFailRescue(false)
    useGuide.getState().retry()
    await flush(12)
    expect(model().status).toBe('ready')
  })

  it('Rescue without a qualifying recovery is reported as outdated, not narrated', async () => {
    const r = clone(rescueRes) as unknown as RescueResponse
    r.alternatives = []
    api.setRescueBody(r)
    useGuide.getState().start()
    await flush()
    await advanceTo('rescue')
    await flush(12)
    expect(model().status).toBe('outdated')
  })

  it('begin() activates the story without entering a stage or navigating', () => {
    useNav.setState({ view: 'atlas' })
    useGuide.getState().begin()
    expect(useGuide.getState()).toMatchObject({ active: true, stage: 0, planId: null })
    expect(useNav.getState().view).toBe('atlas')
  })

  it('go() resolves once the stage has its live result', async () => {
    useGuide.getState().start()
    await flush()
    await useGuide.getState().go(stageIndex('original'))
    expect(model().status).toBe('ready')
  })
})
