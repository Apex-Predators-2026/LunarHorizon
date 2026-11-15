// Test support for the mission story: resets the shared stores and serves the captured real API responses for the
// mission definition (backend/scripts/make_mission_fixtures.py) through a mocked fetch.
import { vi } from 'vitest'

import { markEvidenceShown, takeEvidence } from '../../../viz/evidence'
import { scenarioKey, useAssessmentStore } from '../../assessment/useAssessmentStore'
import { useCompareStore } from '../../compare/useCompareStore'
import { usePlansStore } from '../../plans/usePlansStore'
import { useRescueStore } from '../../rescue/useRescueStore'
import { disruptedScenario, originalScenario } from '../missionDefinition'
import assessDisrupted from './assess-disrupted.json'
import assessOriginal from './assess-original.json'
import assessRecovery from './assess-recovery.json'
import compareRes from './compare.json'
import rescueRes from './rescue.json'

export interface MissionApiControls {
  setRescueBody(b: unknown): void
  setRescueGate(p: Promise<void> | null): void
  setFailRescue(v: boolean): void
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response

/** The compare fixture answers under the keys of whatever the store sends (same order: original, disrupted, recovery). */
function compareFor(body: { scenarios: { key: string }[] }) {
  let text = JSON.stringify(compareRes)
  for (const [i, k] of ['original', 'disrupted', 'recovery'].entries()) text = text.split(`"${k}"`).join(JSON.stringify(body.scenarios[i].key))
  return JSON.parse(text)
}

/** Empty plans, assessments, comparison and Rescue state. */
export function resetMissionStores(): void {
  usePlansStore.setState({ plans: [], activeId: null, compareIds: [] })
  useAssessmentStore.setState({ results: {}, showing: null, target: 'original' })
  useCompareStore.setState({ scenarios: [], selectedIds: [], results: {}, rescueContext: null, rankingSetKey: null, rankingGroups: [], rankingPairs: [], allowDemo: false })
  useRescueStore.getState().reset()
  useRescueStore.setState({ original: null, change: { launch_delay_days: 0, requirement_overrides: {} } })
}

/** Stub the global fetch with the mission fixtures. Undo with vi.unstubAllGlobals(). */
export function stubMissionFetch(): MissionApiControls {
  let rescueBody: unknown = rescueRes
  let rescueGate: Promise<void> | null = null
  let failRescue = false
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
  return {
    setRescueBody: (b) => { rescueBody = b },
    setRescueGate: (p) => { rescueGate = p },
    setFailRescue: (v) => { failRescue = v },
  }
}

export async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Stand in for the 3D view: take the pending evidence request and mark it shown. */
export function viewerShows(): void {
  const r = takeEvidence()
  if (r) markEvidenceShown(r)
}
