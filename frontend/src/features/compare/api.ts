// HTTP client for the comparison endpoint plus the data engine's site and horizon endpoints.
// Same conventions as the rescue client: Vite proxies /api in development; VITE_API_URL otherwise.
import type { Horizon, SiteInfo } from '../../types'
import { ApiError } from '../rescue/api'
import type { CompareRequest, CompareResponse } from './types'

export { errorMessage } from '../rescue/api'

const API_URL: string = import.meta.env.VITE_API_URL ?? ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init)
  if (!res.ok) {
    let detail: unknown = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, detail)
  }
  return (await res.json()) as T
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
