// /api/atlas client. Same base-URL convention as the other features (VITE_API_URL, else the Vite proxy).
import type { AtlasRequest, AtlasResponse } from './atlas'

const API_URL: string = import.meta.env.VITE_API_URL ?? ''

export async function fetchAtlas(req: AtlasRequest, signal?: AbortSignal): Promise<AtlasResponse> {
  const res = await fetch(`${API_URL}/api/atlas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
  if (!res.ok) {
    let detail = `Request failed (${res.status})`
    try {
      const body = await res.json()
      detail = typeof body.detail === 'string' ? body.detail : Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : detail
    } catch {
      // non-JSON error body
    }
    throw new Error(detail)
  }
  return (await res.json()) as AtlasResponse
}
