// The canonical (viability-engine) eligibility of one exact plan, for the Planner cards and Mission Playback.
//
// Compatibility adapter: the assessment itself is fetched and cached by features/assessment/useAssessmentStore.ts
// (POST /api/viability/assess-scenario, docs/viability-api.md), the single canonical client shared with the Mission
// assessment panel, so a plan is assessed once and the card, the panel and Playback show the same verdict. Callers
// keep the small PlanVerdict shape. Nothing is decided on the client: while the answer is loading, failed or
// refused there is NO verdict (never a PASS), and UNKNOWN stays UNKNOWN.
import { useEffect } from 'react'

import { scenarioKey, useAssessmentStore, type AssessState } from '../features/assessment/useAssessmentStore'
import type { Eligibility, Scenario } from '../types'

export type PlanVerdict =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; eligibility: Eligibility; failed: string[]; undecided: string[] }

/** Everything the verdict depends on: site, exact landing instant, duration and every requirement. */
export const planVerdictKey = scenarioKey

/** The adapter's view of one stored assessment state. */
export function toPlanVerdict(state: AssessState | undefined): PlanVerdict {
  if (!state || state.status === 'loading') return { status: 'loading' }
  if (state.status === 'error')
    return { status: 'error', message: state.httpStatus === 404 ? 'no scientific data for this site' : state.httpStatus === 0 ? 'backend unavailable' : `request failed (${state.httpStatus})` }
  const a = state.response.assessment
  return {
    status: 'done',
    eligibility: a.eligibility,
    failed: a.constraints.filter((c) => c.status === 'fail').map((c) => c.message),
    undecided: a.constraints.filter((c) => c.status === 'unknown').map((c) => c.message),
  }
}

export function fetchPlanVerdict(sc: Scenario): Promise<PlanVerdict> {
  return useAssessmentStore.getState().assess(sc).then(toPlanVerdict)
}

/**
 * The plan's canonical verdict (loading until the engine has answered), or null when not enabled. It reads the shared
 * store under the exact plan's key, so an edited plan shows "loading" until its own assessment arrives and an old
 * response never describes it.
 */
export function usePlanVerdict(sc: Scenario | null | undefined, enabled = true): PlanVerdict | null {
  const key = sc && enabled && typeof fetch === 'function' ? scenarioKey(sc) : null
  const state = useAssessmentStore((s) => (key ? s.results[key] : undefined))
  useEffect(() => {
    if (!key || !sc) return
    void useAssessmentStore.getState().assess(sc)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the plan revision
  }, [key])
  return key ? toPlanVerdict(state) : null
}
