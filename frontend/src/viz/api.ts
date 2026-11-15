// Client + React hooks for the data-engine endpoints (backend/app/main.py, /api/sites/*).
// Same base-URL convention as features/rescue/api.ts (VITE_API_URL, else the Vite proxy).
import { useEffect, useState } from 'react'
import type { Horizon, PsrData, SiteInfo, SiteStatus, TimelineStep, VerifyResult } from '../types'

export const API_URL: string = import.meta.env.VITE_API_URL ?? ''

/**
 * A readable sentence for a failed API call. FastAPI sends `detail` as a string for our own errors and as a list of
 * {loc, msg} objects for request validation (422); anything else falls back to the HTTP status, never raw JSON.
 */
export function apiErrorMessage(status: number, statusText: string, body: unknown): string {
  const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        if (!d || typeof d !== 'object') return ''
        const { loc, msg } = d as { loc?: unknown; msg?: unknown }
        const field = Array.isArray(loc) ? loc.filter((x) => x !== 'body').join('.') : ''
        return typeof msg === 'string' ? (field ? `${field}: ${msg}` : msg) : ''
      })
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  return `${statusText || 'Request failed'} (HTTP ${status})`
}

async function errorFrom(res: Response): Promise<Error> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // non-JSON error body (a proxy page, or an unhandled server error): the status line is all we have
  }
  return new Error(apiErrorMessage(res.status, res.statusText, body))
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { signal })
  if (!res.ok) throw await errorFrom(res)
  return (await res.json()) as T
}

// Includes custom (pin-dropped) sites so they can be selected after they're created.
export const fetchSites = (signal?: AbortSignal) => getJson<SiteInfo[]>('/api/sites?include_custom=true', signal)
export const fetchPsr = (signal?: AbortSignal) => getJson<PsrData>('/api/psr', signal)
export const fetchVerify = (id: string, timeUtc: string, signal?: AbortSignal) =>
  getJson<VerifyResult>(`/api/sites/${encodeURIComponent(id)}/verify?time=${encodeURIComponent(timeUtc)}`, signal)

/** Analyse any point on the Moon (POST /api/sites/custom). Can take ~10-60 s in a new area. */
export async function createCustomSite(lat: number, lon: number, name?: string): Promise<SiteInfo> {
  const res = await fetch(`${API_URL}/api/sites/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lon, name }),
  })
  if (!res.ok) throw await errorFrom(res)
  return (await res.json()) as SiteInfo
}
export const fetchHorizon = (id: string, signal?: AbortSignal) =>
  getJson<Horizon>(`/api/sites/${encodeURIComponent(id)}/horizon`, signal)
export const fetchTimeline = (id: string, startUtc: string, endUtc: string, stepHours = 1, signal?: AbortSignal) =>
  getJson<TimelineStep[]>(
    `/api/sites/${encodeURIComponent(id)}/timeline?start=${encodeURIComponent(startUtc)}&end=${encodeURIComponent(
      endUtc,
    )}&step_hours=${stepHours}`,
    signal,
  )
export const fetchStatus = (id: string, timeUtc: string, signal?: AbortSignal) =>
  getJson<SiteStatus>(`/api/sites/${encodeURIComponent(id)}/status?time=${encodeURIComponent(timeUtc)}`, signal)

export interface Async<T> {
  data: T | null
  error: string | null
  loading: boolean
}

/** Runs `load` whenever `key` changes; ignores stale responses. `key = null` means "nothing to load". */
export function useAsync<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Async<T> {
  const [state, setState] = useState<Async<T>>({ data: null, error: null, loading: false })
  useEffect(() => {
    if (key === null) {
      setState({ data: null, error: null, loading: false })
      return
    }
    const ctrl = new AbortController()
    setState((s) => ({ data: s.data, error: null, loading: true }))
    load(ctrl.signal)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false })
      })
    return () => ctrl.abort()
    // `load` is recreated every render; `key` captures everything it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}
