// Client for the Mission Assistant endpoints (backend/app/assistant). The browser never holds an API key: the
// backend adds it. Same base-URL convention as the comparison client (VITE_API_URL, else the Vite proxy).
import type { AssistantContext } from './context'

const API_URL: string = import.meta.env.VITE_API_URL ?? ''

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatReply {
  reply: string
  model: string
  source: 'ai'
}

export interface AssistantStatus {
  available: boolean
  reason: string | null
  message: string | null
  model: string | null
}

/** Why the assistant could not answer. `reason` is a short code (not_configured, offline, network, ...). */
export class AssistantError extends Error {
  reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.reason = reason
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, init)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new AssistantError('backend_unreachable', 'The backend is not reachable, so the Mission Assistant cannot answer.')
  }
  if (!res.ok) {
    let detail: unknown = null
    try {
      detail = (await res.json()).detail
    } catch {
      // non-JSON error body
    }
    if (detail && typeof detail === 'object' && 'reason' in detail && 'message' in detail) {
      const d = detail as { reason: string; message: string }
      throw new AssistantError(d.reason, d.message)
    }
    if (res.status === 404) throw new AssistantError('not_installed', 'This backend has no Mission Assistant endpoint (restart it with the latest code).')
    if (res.status === 422) throw new AssistantError('invalid', 'The question could not be sent (too long, or the comparison is too large).')
    throw new AssistantError('server_error', `The backend could not answer (HTTP ${res.status}).`)
  }
  return (await res.json()) as T
}

export const fetchAssistantStatus = (signal?: AbortSignal) => call<AssistantStatus>('/api/assistant/status', { signal })

export const postAssistantChat = (messages: ChatTurn[], context: AssistantContext, signal?: AbortSignal) =>
  call<ChatReply>('/api/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, context }),
    signal,
  })
