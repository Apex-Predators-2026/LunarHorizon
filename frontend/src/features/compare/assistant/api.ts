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

async function request(path: string, init?: RequestInit): Promise<Response> {
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
  return res
}

export const fetchAssistantStatus = async (signal?: AbortSignal): Promise<AssistantStatus> =>
  (await request('/api/assistant/status', { signal })).json()

const STREAM_TYPE = 'application/x-ndjson'

export async function postAssistantChat(
  messages: ChatTurn[],
  context: AssistantContext,
  signal: AbortSignal,
  onDraft: (draft: string) => void,
): Promise<ChatReply> {
  const res = await request('/api/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: STREAM_TYPE },
    body: JSON.stringify({ messages, context }),
    signal,
  })
  if (!res.headers.get('content-type')?.startsWith(STREAM_TYPE)) return res.json()

  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader()
  const interrupted = () => new AssistantError('network', 'The AI response was interrupted. Try again.')
  if (!reader) throw interrupted()
  let buffer = ''
  let draft = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) throw interrupted()
      const lines = (buffer + value).split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line)
        if (event.type === 'error') throw new AssistantError(event.reason, event.message)
        if (event.type === 'done' && typeof event.model === 'string' && draft.trim()) {
          return { reply: draft.trim(), model: event.model, source: 'ai' }
        }
        if (event.type !== 'delta' || typeof event.text !== 'string') throw interrupted()
        draft += event.text
      }
      if (draft.trim()) onDraft(draft)
    }
  } catch (error) {
    if (signal.aborted || error instanceof AssistantError) throw error
    throw interrupted()
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
