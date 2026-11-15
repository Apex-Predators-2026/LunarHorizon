// Client for the canonical viability API (backend app/viability/api/router.py, docs/viability-api.md).
import type { Scenario } from '../../types'
import type { AssessResponse } from './types'

const API_URL: string = import.meta.env.VITE_API_URL ?? ''

export class AssessError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function assessScenario(scenario: Scenario, signal?: AbortSignal): Promise<AssessResponse> {
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/viability/assess-scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario, include_explanation_details: true }),
      signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new AssessError(0, 'Backend unavailable: start the API server (see docs/demo-setup.md).')
  }
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      // non-JSON body
    }
    throw new AssessError(res.status, detail)
  }
  return (await res.json()) as AssessResponse
}

export async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { signal })
  if (!res.ok) throw new AssessError(res.status, res.statusText)
  return (await res.json()) as T
}
