// The one client/state layer for canonical assessments of an exact mission (site, landing instant, duration and
// every requirement). The Mission assessment panel, the Planner's plan cards (lib/planVerdict.ts) and Mission
// Playback all read it, so one plan is assessed once and every surface shows the same verdict.
//
// Rules:
//   - A result is stored under the key of the exact inputs it was requested for (scenarioKey). Editing the mission
//     changes the key, so a response can never attach to a mission it was not computed for: the old response lands
//     under the old key and is simply never read for the new one.
//   - While loading, after an error or when the backend refuses, there is NO verdict. Errors are retryable.
//   - Nothing is decided on the client; every status and number is the engine's.
//   - `assess` returns a promise for the final state and shares the in-flight request between callers.
import { create } from 'zustand'

import type { Scenario } from '../../types'
import { clearEvidence } from '../../viz/evidence'
import { assessScenario, AssessError } from './api'
import type { AssessResponse } from './types'

export type AssessState =
  | { status: 'loading' }
  | { status: 'done'; response: AssessResponse }
  | { status: 'error'; message: string; httpStatus: number }

/** Everything the verdict depends on, exactly. Safe for an unparseable date (it just stays distinct). */
export const scenarioKey = (s: Scenario) =>
  JSON.stringify([s.site.id, Date.parse(s.landing_utc) || s.landing_utc, s.duration_days, s.requirements])

const MAX_CACHE = 24

/** Which plan the panel shows: the running plan, the plan after Rescue's change (delay etc.), or the Rescue pick. */
export type AssessTarget = 'original' | 'changed' | 'selected'

interface AssessmentStore {
  target: AssessTarget
  setTarget: (t: AssessTarget) => void
  results: Record<string, AssessState>
  /** Constraint whose evidence is shown in the 3D view, as `${scenarioKey}|${constraint_id}`. */
  showing: string | null
  /** Assess this exact mission (cached; an error is retried). Resolves with the final state for it. */
  assess: (s: Scenario) => Promise<AssessState>
  /** Forget a stored result (e.g. before an explicit refresh). */
  forget: (s: Scenario) => void
  setShowing: (key: string | null) => void
  clearShowing: () => void
}

const inflight = new Map<string, Promise<AssessState>>()

export const useAssessmentStore = create<AssessmentStore>((set, get) => ({
  target: 'original',
  setTarget: (target) => set({ target }),
  results: {},
  showing: null,
  assess: (s) => {
    const key = scenarioKey(s)
    const cur = get().results[key]
    if (cur?.status === 'done') return Promise.resolve(cur)
    const running = inflight.get(key)
    if (running) return running
    set((st) => {
      const results = { ...st.results }
      const evictable = Object.keys(results).filter((k) => !inflight.has(k))
      if (Object.keys(results).length >= MAX_CACHE && evictable.length) delete results[evictable[0]]
      results[key] = { status: 'loading' }
      return { results }
    })
    const p: Promise<AssessState> = (async (): Promise<AssessState> => {
      let next: AssessState
      try {
        next = { status: 'done', response: await assessScenario(s) }
      } catch (e) {
        next = { status: 'error', message: (e as Error).message, httpStatus: e instanceof AssessError ? e.status : 0 }
      }
      set((st) => ({ results: { ...st.results, [key]: next } }))
      return next
    })().finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    })
    inflight.set(key, p)
    return p
  },
  forget: (s) => {
    const key = scenarioKey(s)
    if (inflight.has(key)) return
    set((st) => {
      const results = { ...st.results }
      delete results[key]
      return { results }
    })
  },
  setShowing: (showing) => set({ showing }),
  // Clears only evidence this panel opened (a row was marked). The panel's unmount cleanup calls this, and React
  // StrictMode runs that cleanup right after mount: it must not wipe a request just made on another page.
  clearShowing: () => {
    const had = get().showing !== null
    set({ showing: null })
    if (had) clearEvidence()
  },
}))
