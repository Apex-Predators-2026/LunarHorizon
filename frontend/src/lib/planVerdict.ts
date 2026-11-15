// The canonical (viability-engine) eligibility of one exact plan, for the Planner cards and Mission Playback.
//
// Source: POST /api/viability/assess-scenario (backend/app/viability/api, docs/viability-api.md): the canonical
// engine on the same hourly grid as Comparison, Rescue and the Atlas. Nothing is decided on the client: while the
// answer is loading, failed or refused there is NO verdict (never a PASS), and UNKNOWN stays UNKNOWN.
import { useEffect, useState } from 'react'

import { API_URL } from '../viz/api'
import type { Eligibility, Scenario } from '../types'

export type PlanVerdict =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; eligibility: Eligibility; failed: string[]; undecided: string[] }

/** Everything the verdict depends on: site, exact landing instant, duration and every requirement. */
export function planVerdictKey(sc: Scenario): string {
  return JSON.stringify([sc.site.id, Date.parse(sc.landing_utc) || sc.landing_utc, sc.duration_days, sc.requirements])
}

interface AssessWire {
  assessment: { eligibility: Eligibility; constraints: { status: string; message: string }[] }
}

const cache = new Map<string, Promise<PlanVerdict>>()

export function fetchPlanVerdict(sc: Scenario): Promise<PlanVerdict> {
  const key = planVerdictKey(sc)
  const hit = cache.get(key)
  if (hit) return hit
  const p: Promise<PlanVerdict> = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/viability/assess-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: sc, include_explanation_details: false }),
      })
      if (!res.ok) {
        cache.delete(key) // errors are retryable and never a verdict
        return { status: 'error', message: res.status === 404 ? 'no scientific data for this site' : `request failed (${res.status})` }
      }
      const a = ((await res.json()) as AssessWire).assessment
      return {
        status: 'done',
        eligibility: a.eligibility,
        failed: a.constraints.filter((c) => c.status === 'fail').map((c) => c.message),
        undecided: a.constraints.filter((c) => c.status === 'unknown').map((c) => c.message),
      }
    } catch {
      cache.delete(key)
      return { status: 'error', message: 'backend unavailable' }
    }
  })()
  cache.set(key, p)
  return p
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
