// Mission Assistant state: panel open/closed, the conversation for this browser session, and request status.
// The conversation persists in sessionStorage (like the comparison workspace); nothing is sent anywhere except
// the backend's /api/assistant/chat when the user asks a question.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { AssistantError, fetchAssistantStatus, postAssistantChat, type ChatTurn } from './api'
import { contextLine, contextSignature, verdictChips, type AssistantContext } from './context'
import { basicAnswer } from './fallback'

export interface ChatMessage {
  id: string
  /**
   * notice = a note in the chat (e.g. "the comparison changed"); basic = an answer assembled from the page's own
   * results without AI (shown when the AI service is unavailable). Neither is ever sent to the AI.
   */
  role: 'user' | 'assistant' | 'notice' | 'basic'
  content: string
  at: number
  model?: string
  /** The page's verdict per scenario when the answer was given (e.g. "B PASS #1"), shown under the answer. */
  verdicts?: string[]
}

export type AssistantAvailability = 'unknown' | 'checking' | 'available' | 'unavailable'

export interface AssistantState {
  open: boolean
  messages: ChatMessage[]
  pending: boolean
  streamingReply: string
  error: { reason: string; message: string } | null
  availability: AssistantAvailability
  availabilityMessage: string | null
  /** Signature of the comparison the last question was asked about. */
  lastSignature: string | null
  /** A question asked from a button on the page; the panel sends it with the current comparison. */
  queued: string | null
  setOpen: (open: boolean) => void
  /** Open the panel and ask this question (from an "Ask the assistant" button on the page). */
  askFromPage: (question: string) => void
  takeQueued: () => string | null
  checkStatus: () => Promise<void>
  ask: (question: string, context: AssistantContext) => Promise<void>
  retry: (context: AssistantContext) => Promise<void>
  /** Answer the last question (or summarize) from the page's own results, without AI. */
  showBasic: (context: AssistantContext) => void
  /** With the AI unavailable: record the question and answer it from the page's own results. */
  askBasic: (question: string, context: AssistantContext) => void
  stop: () => void
  clear: () => void
}

export const MAX_QUESTION = 1000
const MAX_SENT_TURNS = 24
const MAX_KEPT = 80
const UNAVAILABLE = new Set(['not_configured', 'offline', 'not_installed'])

let seq = 0
const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`
let inflight: AbortController | null = null

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

export const useAssistant = create<AssistantState>()(
  persist(
    (set, get) => {
      /** Send the conversation (which ends with the user's question) with the comparison as it is now. */
      const send = async (context: AssistantContext) => {
        const turns: ChatTurn[] = get().messages
          .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content }))
          .slice(-MAX_SENT_TURNS)
        if (!turns.length || turns[turns.length - 1].role !== 'user') return
        inflight?.abort()
        const ctl = new AbortController()
        inflight = ctl
        set({ pending: true, streamingReply: '', error: null, lastSignature: contextSignature(context) })
        try {
          const r = await postAssistantChat(turns, context, ctl.signal, (draft) => {
            if (inflight === ctl) set({ streamingReply: draft })
          })
          if (inflight !== ctl) return
          set((s) => ({
            messages: [...s.messages, { id: newId(), role: 'assistant' as const, content: r.reply, at: Date.now(), model: r.model, verdicts: verdictChips(context) }].slice(-MAX_KEPT),
            availability: 'available',
            availabilityMessage: null,
            streamingReply: '',
          }))
        } catch (e) {
          if (isAbort(e) || inflight !== ctl) return
          const err = e instanceof AssistantError ? e : new AssistantError('unknown', e instanceof Error ? e.message : String(e))
          set({
            error: { reason: err.reason, message: err.message },
            ...(UNAVAILABLE.has(err.reason) ? { availability: 'unavailable' as const, availabilityMessage: err.message } : {}),
          })
        } finally {
          if (inflight === ctl) {
            inflight = null
            set({ pending: false, streamingReply: '' })
          }
        }
      }

      return {
        open: false,
        messages: [],
        pending: false,
        streamingReply: '',
        error: null,
        availability: 'unknown',
        availabilityMessage: null,
        lastSignature: null,
        queued: null,

        setOpen: (open) => set({ open }),

        askFromPage: (question) => set({ open: true, queued: question }),

        takeQueued: () => {
          const q = get().queued
          if (q) set({ queued: null })
          return q
        },

        checkStatus: async () => {
          set({ availability: 'checking' })
          try {
            const s = await fetchAssistantStatus()
            set({ availability: s.available ? 'available' : 'unavailable', availabilityMessage: s.available ? null : s.message })
          } catch (e) {
            set({ availability: 'unavailable', availabilityMessage: e instanceof Error ? e.message : String(e) })
          }
        },

        ask: async (question, context) => {
          const text = question.trim().slice(0, MAX_QUESTION)
          if (!text || get().pending) return
          const sig = contextSignature(context)
          const { lastSignature, messages } = get()
          const added: ChatMessage[] = []
          // The comparison changed since the last question: say so, so earlier answers aren't read as current.
          if (lastSignature && lastSignature !== sig && messages.some((m) => m.role === 'assistant')) {
            added.push({ id: newId(), role: 'notice', content: `The comparison changed. Now reading: ${contextLine(context)}`, at: Date.now() })
          }
          added.push({ id: newId(), role: 'user', content: text, at: Date.now() })
          set({ messages: [...messages, ...added].slice(-MAX_KEPT) })
          await send(context)
        },

        retry: (context) => send(context),

        showBasic: (context) => {
          const lastQ = [...get().messages].reverse().find((m) => m.role === 'user')
          const content = basicAnswer(lastQ?.content ?? 'Summarize my current comparison.', context)
          set((s) => ({
            error: null,
            messages: [...s.messages, { id: newId(), role: 'basic' as const, content, at: Date.now(), verdicts: verdictChips(context) }].slice(-MAX_KEPT),
          }))
        },

        askBasic: (question, context) => {
          const text = question.trim().slice(0, MAX_QUESTION)
          if (!text || get().pending) return
          set((s) => ({ messages: [...s.messages, { id: newId(), role: 'user' as const, content: text, at: Date.now() }].slice(-MAX_KEPT) }))
          get().showBasic(context)
        },

        stop: () => {
          inflight?.abort()
          inflight = null
          set({ pending: false, streamingReply: '' })
        },

        clear: () => {
          inflight?.abort()
          inflight = null
          set({ messages: [], pending: false, streamingReply: '', error: null, lastSignature: null })
        },
      }
    },
    {
      name: 'lunar-compare-assistant',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ open: s.open, messages: s.messages, lastSignature: s.lastSignature }),
    },
  ),
)
