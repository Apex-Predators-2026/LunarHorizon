// HTTP client for the comparison endpoint plus the data engine's site and horizon endpoints.
// Same conventions as the rescue client: Vite proxies /api in development; VITE_API_URL otherwise.
import type { Horizon, SiteInfo } from '../../types'
import { ApiError } from '../rescue/api'
import type { CompareRequest, CompareResponse } from './types'

export { errorMessage } from '../rescue/api'

const API_URL: string = import.meta.env.VITE_API_URL ?? ''

/** An error response from the API itself (it sent a JSON `detail`), as opposed to a proxy or gateway answering for it. */
const FROM_API = Symbol('fromApi')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init)
  if (!res.ok) {
    let detail: unknown = res.statusText
    let fromApi = false
    try {
      const body = await res.json()
      fromApi = body?.detail !== undefined
      detail = body.detail ?? detail
    } catch {
      // non-JSON error body
    }
    throw Object.assign(new ApiError(res.status, detail), { [FROM_API]: fromApi })
  }
  return (await res.json()) as T
}

/**
 * Whether a failed request never reached the backend: the network request itself failed (fetch throws a TypeError),
 * or a proxy or gateway answered 502/503/504 without the API's own error body (the dev server's proxy answers 502
 * when the backend is not running). Any other failure is a response from the backend, with its own message.
 */
export function isUnreachable(e: unknown): boolean {
  if (e instanceof ApiError) return !(e as ApiError & { [FROM_API]?: boolean })[FROM_API] && e.status >= 502 && e.status <= 504
  return e instanceof TypeError
}

export const postCompare = (req: CompareRequest, signal?: AbortSignal) =>
  request<CompareResponse>('/api/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })

export const fetchSites = (signal?: AbortSignal) => request<SiteInfo[]>('/api/sites', { signal })

export const fetchHorizon = (siteId: string, signal?: AbortSignal) =>
  request<Horizon>(`/api/sites/${encodeURIComponent(siteId)}/horizon`, { signal })
