// Client + React hooks for the data-engine endpoints (backend/app/main.py, /api/sites/*).
// Same base-URL convention as features/rescue/api.ts (VITE_API_URL, else the Vite proxy).
import { useEffect, useState } from 'react'
import type { Horizon, PsrData, SiteInfo, SiteStatus, TimelineStep, VerifyResult } from '../types'

export const API_URL: string = import.meta.env.VITE_API_URL ?? ''

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { signal })
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      // non-JSON error body
    }
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`)
  }
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
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      // non-JSON error body
    }
    throw new Error(detail || `Request failed (${res.status})`)
  }
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
