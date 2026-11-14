// HTTP client for the Mission Rescue endpoints (backend/app/rescue/router.py).
// In development Vite proxies /api to the FastAPI backend (vite.config.ts). For a deployed
// backend on another origin, set VITE_API_URL in frontend/.env.local.
import type {
  CompromiseRequest,
  CompromiseResponse,
  RescueCatalog,
  RescueRequest,
  RescueResponse,
  SensitivityRequest,
  SensitivityResponse,
} from './types'

const API_URL: string = import.meta.env.VITE_API_URL ?? ''

export class ApiError extends Error {
  status: number
  detail: unknown

  constructor(status: number, detail: unknown) {
    super(typeof detail === 'string' ? detail : `Request failed with status ${status}`)
    this.status = status
    this.detail = detail
  }
}

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

const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

export const fetchRescueCatalog = (signal?: AbortSignal) =>
  request<RescueCatalog>('/api/rescue/sites', { signal })

export const runRescue = (req: RescueRequest, signal?: AbortSignal) =>
  post<RescueResponse>('/api/rescue', req, signal)

export const runSensitivity = (req: SensitivityRequest, signal?: AbortSignal) =>
  post<SensitivityResponse>('/api/rescue/sensitivity', req, signal)

export const runCompromise = (req: CompromiseRequest, signal?: AbortSignal) =>
  post<CompromiseResponse>('/api/rescue/compromise', req, signal)

/** Readable one-line message for any error thrown by the functions above. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (typeof e.detail === 'string') return `${e.status}: ${e.detail}`
    if (Array.isArray(e.detail)) {
      // FastAPI validation errors: [{ loc: [...], msg: '...' }, ...]
      return `${e.status}: ` + e.detail.map((d: { loc?: unknown[]; msg?: string }) =>
        `${(d.loc ?? []).slice(1).join('.')} ${d.msg ?? ''}`.trim()).join('; ')
    }
    return e.message
  }
  return e instanceof Error ? e.message : String(e)
}
