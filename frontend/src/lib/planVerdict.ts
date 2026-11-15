// The canonical (viability-engine) eligibility of one exact plan, for the Planner cards and Mission Playback.
//
// Source: POST /api/viability/assess-scenario (backend/app/viability/api, docs/viability-api.md): the canonical
// engine on the same hourly grid as Comparison, Rescue and the Atlas. Nothing is decided on the client: while the
// answer is loading, failed or refused there is NO verdict (never a PASS), and UNKNOWN stays UNKNOWN.
// It reads the same cached request as the full Mission assessment panel (lib/assessment.ts), so the card's verdict
// and the panel's evidence always come from one answer.
import { useEffect, useState } from 'react'

import type { Eligibility, Scenario } from '../types'
import { assessmentKey, fetchAssessment } from './assessment'

export type PlanVerdict =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; eligibility: Eligibility; failed: string[]; undecided: string[] }

/** Everything the verdict depends on: site, exact landing instant, duration and every requirement. */
export const planVerdictKey = assessmentKey

export async function fetchPlanVerdict(sc: Scenario): Promise<PlanVerdict> {
  const s = await fetchAssessment(sc)
  if (s.status !== 'done') return s
  const a = s.response.assessment
  return {
    status: 'done',
    eligibility: a.eligibility,
    failed: a.constraints.filter((c) => c.status === 'fail').map((c) => c.message),
    undecided: a.constraints.filter((c) => c.status === 'unknown').map((c) => c.message),
  }
}

/** The plan's canonical verdict (loading until the engine has answered). Re-asked when the plan changes. */
export function usePlanVerdict(sc: Scenario | null | undefined, enabled = true): PlanVerdict | null {
  const key = sc && enabled && typeof fetch === 'function' ? planVerdictKey(sc) : null
  const [got, setGot] = useState<{ key: string; v: PlanVerdict } | null>(null)
  useEffect(() => {
    if (!key || !sc) return
    let live = true
    void fetchPlanVerdict(sc).then((v) => live && setGot({ key, v }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the plan revision
  }, [key])
  if (!key) return null
  return got?.key === key ? got.v : { status: 'loading' }
}
