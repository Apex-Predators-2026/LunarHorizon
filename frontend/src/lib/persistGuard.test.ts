// Saved state that parses as JSON but has the wrong shape (an old version, a hand edit, another app on the same
// origin) must never stop the app from starting: the stores load what is valid and drop the rest.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_REQUIREMENTS } from '../types'

function memoryStorage(seed: Record<string, string>): Storage {
  const m = new Map(Object.entries(seed))
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k) },
    setItem: (k, v) => { m.set(k, String(v)) },
  }
}

/** Imports the stores fresh, as the app does at startup, with the given saved state. */
async function boot(local: Record<string, unknown>, session: Record<string, unknown> = {}) {
  const enc = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)]))
  vi.resetModules()
  vi.stubGlobal('localStorage', memoryStorage(enc(local)))
  vi.stubGlobal('sessionStorage', memoryStorage(enc(session)))
  const { usePlansStore } = await import('../features/plans/usePlansStore')
  const { useCompareStore } = await import('../features/compare/useCompareStore')
  const { useAssistant } = await import('../features/compare/assistant/useAssistant')
  return { plans: usePlansStore.getState(), compare: useCompareStore.getState(), assistant: useAssistant.getState() }
}

const SITE = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }
const GOOD_PLAN = { id: 'plan-1', name: 'Good', scenario: { site: SITE, landing_utc: '2027-01-15T00:00:00Z', duration_days: 7, requirements: DEFAULT_REQUIREMENTS } }

afterEach(() => vi.unstubAllGlobals())

describe('saved state with the wrong shape', () => {
  it.each([
    ['plans is not a list', { plans: 'oops' }],
    ['a plan is null', { plans: [null] }],
    ['a plan has an empty scenario', { plans: [{ id: 'p', name: 'x', scenario: {} }] }],
  ])('lunar-plans: %s → starts with no plans instead of crashing', async (_, state) => {
    const s = await boot({ 'lunar-plans': { state, version: 0 } })
    expect(s.plans.plans).toEqual([])
  })

  it('lunar-plans: keeps the valid plans and drops only the broken ones', async () => {
    const s = await boot({ 'lunar-plans': { state: { plans: [null, GOOD_PLAN, { id: 'p2' }], activeId: 7, compareIds: 'x' }, version: 0 } })
    expect(s.plans.plans.map((p) => p.id)).toEqual(['plan-1'])
    expect(s.plans.activeId).toBeNull()
    expect(s.plans.compareIds).toEqual([])
  })

  it.each([
    ['scenarios is not a list', { scenarios: 'x' }],
    ['a scenario is null', { scenarios: [null] }],
  ])('lunar-compare-workspace: %s → starts with an empty workspace instead of crashing', async (_, state) => {
    const s = await boot({}, { 'lunar-compare-workspace': { state, version: 2 } })
    expect(Array.isArray(s.compare.scenarios)).toBe(true)
  })

  it.each([
    ['messages is not a list', { open: true, messages: 'hello' }],
    ['a message is null', { open: true, messages: [null] }],
  ])('lunar-compare-assistant: %s → starts with no messages instead of crashing', async (_, state) => {
    const s = await boot({}, { 'lunar-compare-assistant': { state, version: 0 } })
    expect(s.assistant.messages).toEqual([])
  })
})
