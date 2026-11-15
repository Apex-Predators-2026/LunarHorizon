// Mission Assistant: a collapsible chat panel on the right of the Scenario Comparison page.
//
// It reads the comparison exactly as the page shows it (context.ts), asks the backend (which holds the API key),
// and only explains: it cannot change scenarios, requirements, rankings or Rescue plans. When the AI service is
// unavailable it says so plainly and never makes an answer up.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { createPortal } from 'react-dom'

import { RoverMascot } from '../../../ui/RoverMascot'
import type { Entry } from '../analysis'
import type { PairEvidence, RankingGroup } from '../types'
import { Icon } from '../ui'
import { useCompareStore } from '../useCompareStore'
import { useCompareTour } from '../tour/useCompareTour'
import { buildAssistantContext, contextLine, type AssistantContext } from './context'
import type { NavTarget } from './navigation'
import { RichText } from './RichText'
import { suggestedQuestions } from './suggestions'
import { MAX_QUESTION, useAssistant, type ChatMessage } from './useAssistant'

/** Width of the open panel; the page leaves this much room on wide screens so nothing is covered. */
export const ASSISTANT_WIDTH = 400

// Same style scope as the comparison page, without its page background or padding.
const SCOPE = 'cmp-page lp-light md-host'
const SCOPE_STYLE = { background: 'transparent', minHeight: 0, padding: 0, margin: 0 } as const

/** Space taken by the app's floating header (the scrolling <main> is padded by exactly that much). */
function useHeaderOffset(): number {
  const [top, setTop] = useState(88)
  useLayoutEffect(() => {
    const read = () => {
      const main = document.querySelector('main')
      const pad = main ? parseFloat(getComputedStyle(main).paddingTop) : NaN
      setTop(Number.isFinite(pad) && pad > 0 ? Math.round(pad) + 4 : 88)
    }
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])
  return top
}

/** Below this width the open panel covers the page, so following a link closes it to show the section. */
const SIDE_BY_SIDE_MIN = 1100

export function MissionAssistant({ entries, groups, pairs, notes, ready, onJump }: {
  entries: Entry[]
  groups: RankingGroup[]
  pairs: PairEvidence[]
  notes: string[]
  ready: boolean
  /** Scroll the page to a section (the section bar's own jump). */
  onJump?: (sectionId: string) => void
}) {
  const open = useAssistant((s) => s.open)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useLayoutEffect(() => {
    if (open || !restoreFocus.current) return
    restoreFocus.current = false
    launcherRef.current?.focus({ preventScroll: true })
  }, [open])
  const close = () => {
    restoreFocus.current = true
    useAssistant.getState().setOpen(false)
  }
  const rescue = useCompareStore((s) => s.rescueContext)
  // Rebuilt whenever the selection, the requirements, the results or the Rescue import change, so a question always
  // goes out with the comparison as it is at that moment (never a stale copy).
  const context = useMemo(() => buildAssistantContext(entries, groups, pairs, notes, ready, rescue),
    [entries, groups, pairs, notes, ready, rescue])
  // Links in answers only move around the page or start the tour: they never change anything.
  const onNav = (target: NavTarget) => {
    if (typeof window !== 'undefined' && window.innerWidth < SIDE_BY_SIDE_MIN) useAssistant.getState().setOpen(false)
    if (target === 'tour') useCompareTour.getState().start()
    else onJump?.(target)
  }
  if (typeof document === 'undefined') return null
  return createPortal(
    <>
      {!open && <Launcher buttonRef={launcherRef} />}
      <div className="pointer-events-none fixed inset-0 z-[70] overflow-hidden" inert={!open}>
        <Panel open={open} context={context} onNav={onNav} onClose={close} />
      </div>
    </>,
    document.body,
  )
}

function Launcher({ buttonRef }: { buttonRef: Ref<HTMLButtonElement> }) {
  const { setOpen } = useAssistant.getState()
  return (
    <div className={`${SCOPE} fixed bottom-5 right-5 z-[70]`} style={SCOPE_STYLE}>
      <button ref={buttonRef} type="button" data-tour="compare-assistant" onClick={() => setOpen(true)}
        className="cmp-btn-primary shadow-lg" aria-label="Open the Mission Assistant" data-tip="Ask about this comparison">
        <RoverMascot facing="left" size={24} animated={false} /> Mission Assistant
      </button>
    </div>
  )
}

function Panel({ open, context, onNav, onClose }: {
  open: boolean
  context: AssistantContext
  onNav: (t: NavTarget) => void
  onClose: () => void
}) {
  const messages = useAssistant((s) => s.messages)
  const pending = useAssistant((s) => s.pending)
  const streamingReply = useAssistant((s) => s.streamingReply)
  const error = useAssistant((s) => s.error)
  const availability = useAssistant((s) => s.availability)
  const availabilityMessage = useAssistant((s) => s.availabilityMessage)
  const queued = useAssistant((s) => s.queued)
  const { takeQueued, ask, askBasic, showBasic, retry, stop, clear, checkStatus } = useAssistant.getState()
  const [draft, setDraft] = useState('')
  const top = useHeaderOffset()
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Check once per opening whether the backend can answer (no AI call, nothing billed).
  useEffect(() => {
    if (!open) return
    setDraft('')
    void checkStatus()
    inputRef.current?.focus({ preventScroll: true })
  }, [open, checkStatus])

  // Keep the newest message in view.
  useEffect(() => {
    const el = logRef.current
    if (open && el) el.scrollTop = el.scrollHeight
  }, [open, messages.length, pending, streamingReply, error])

  const unavailable = availability === 'unavailable'
  const submit = (text: string) => {
    if (!text.trim() || pending) return
    setDraft('')
    // AI unavailable: answer from the page's own results instead (clearly labelled), never a made-up answer.
    if (unavailable) askBasic(text, context)
    else void ask(text, context)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit(draft)
    }
  }
  const suggestions = suggestedQuestions(context)

  // A question asked from a button on the page: sent once the availability check is done, with the current context.
  useEffect(() => {
    if (!open || !queued || pending || availability === 'checking' || availability === 'unknown') return
    const q = takeQueued()
    if (q) submit(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit reads the latest context on each render
  }, [open, queued, pending, availability])

  return (
    <div className={`${SCOPE} cmp-assistant-panel absolute bottom-4 right-4 flex`} data-open={open} style={{ ...SCOPE_STYLE, top, width: `min(${ASSISTANT_WIDTH}px, calc(100vw - 32px))` }}>
      <aside aria-label="Mission Assistant" data-tour={open ? 'compare-assistant' : undefined}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        className="flex min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface text-ink shadow-xl">
        {/* Header */}
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <RoverMascot facing="right" size={36} state={streamingReply ? 'talking' : 'idle'} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-medium leading-tight text-ink">Rover · Mission Assistant</h2>
            <p className="mt-0.5 text-xs leading-snug text-ink-3">Explains this comparison and how to use the page. Read-only: it can't change your plans.</p>
          </div>
          {messages.length > 0 && (
            <button type="button" className="cmp-btn-quiet text-xs" onClick={clear} data-tip="Start a new conversation">New chat</button>
          )}
          <button type="button" className="cmp-btn-quiet" onClick={onClose} aria-label="Close the Mission Assistant">
            <Icon name="close" size={16} />
          </button>
        </header>

        {/* What it is reading */}
        <div className="border-b border-line bg-inset px-4 py-2 text-[11px] leading-snug text-ink-3" aria-live="polite">
          <span className="font-medium text-ink-2">Reading:</span> {contextLine(context)}
        </div>

        {unavailable && (
          <div role="status" className="mx-4 mt-3 flex items-start gap-2 rounded-xl border border-line px-3 py-2 text-xs leading-relaxed text-ink-2">
            <Icon name="info" size={14} className="mt-0.5 shrink-0 text-ink-3" />
            <div className="flex-1">
              <p>{availabilityMessage ?? 'The Mission Assistant is not available right now.'}</p>
              <p className="mt-1 text-ink-3">Questions get a basic answer built from the page's own results instead (no AI).</p>
              <button type="button" className="cmp-btn-quiet mt-1 text-xs" onClick={() => void checkStatus()}>Check again</button>
            </div>
          </div>
        )}

        {/* Conversation */}
        <div ref={logRef} role="log" aria-live="polite" aria-label="Conversation" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-ink-2">
          {messages.length === 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 rounded-xl bg-inset px-3 py-3">
                <p>Hi, I'm Rover! I'm here to help you understand your missions. Ask me anything about your mission data.</p>
                <RoverMascot facing="left" size={56} />
              </div>
              {context.state === 'empty' && (
                <p>No scenarios are selected yet. I can show you how to set up a comparison, or explain what the page shows.</p>
              )}
              <Suggestions items={suggestions} disabled={pending} onPick={submit} />
            </div>
          )}
          {messages.map((m) => <Message key={m.id} m={m} onNav={onNav} />)}
          {streamingReply && (
            <div aria-live="off">
              <RichText text={streamingReply} />
            </div>
          )}
          {pending && (
            <div className="flex items-center gap-2 text-xs text-ink-3" role="status">
              <span className="inline-flex gap-1" aria-hidden="true">
                <span className="h-1.5 w-1.5 rounded-full bg-ink-4 motion-safe:animate-pulse" />
                <span className="h-1.5 w-1.5 rounded-full bg-ink-4 motion-safe:animate-pulse [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 rounded-full bg-ink-4 motion-safe:animate-pulse [animation-delay:300ms]" />
              </span>
              {streamingReply ? 'Rover is responding…' : 'Reading the comparison…'}
              <button type="button" className="cmp-btn-quiet ml-auto text-xs" onClick={stop}>Stop</button>
            </div>
          )}
          {error && !pending && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900">
              <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                <p>{error.message}</p>
                <span className="mt-1 flex flex-wrap gap-x-3">
                  {!unavailable && <button type="button" className="cmp-btn-quiet text-xs" onClick={() => void retry(context)}>Try again</button>}
                  <button type="button" className="cmp-btn-quiet text-xs" onClick={() => showBasic(context)}>Basic answer from the page (no AI)</button>
                </span>
              </div>
            </div>
          )}
        </div>

        {messages.length > 0 && !pending && (
          <div className="border-t border-line px-4 pt-2">
            <Suggestions items={suggestions.slice(0, 3)} disabled={pending} onPick={submit} compact />
          </div>
        )}

        {/* Composer */}
        <form className="flex items-end gap-2 px-4 pb-4 pt-2" onSubmit={(e) => { e.preventDefault(); submit(draft) }}>
          <label htmlFor="cmp-assistant-input" className="sr-only">Ask the Mission Assistant</label>
          <textarea id="cmp-assistant-input" ref={inputRef} rows={2} maxLength={MAX_QUESTION} value={draft}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
            placeholder={unavailable ? 'AI unavailable: basic answers from the page…' : 'Ask about this comparison…'}
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-4 focus:border-ink-3 disabled:opacity-60" />
          <button type="submit" className="cmp-btn-primary h-11" disabled={!draft.trim() || pending} aria-label="Send question">
            <Icon name="send" size={16} />
          </button>
        </form>
      </aside>
    </div>
  )
}

function Suggestions({ items, disabled, onPick, compact = false }: { items: string[]; disabled: boolean; onPick: (q: string) => void; compact?: boolean }) {
  return (
    <div>
      {!compact && <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-4">Suggested questions</p>}
      <ul className={compact ? 'flex gap-1.5 overflow-x-auto pb-1' : 'flex flex-col items-start gap-1.5'}>
        {items.map((q) => (
          <li key={q} className={compact ? 'shrink-0' : ''}>
            <button type="button" disabled={disabled} onClick={() => onPick(q)}
              className="rounded-lg border border-line px-2.5 py-1 text-left text-xs text-ink-2 hover:border-ink-3 hover:text-ink disabled:opacity-50">
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Message({ m, onNav }: { m: ChatMessage; onNav: (t: NavTarget) => void }) {
  if (m.role === 'notice') {
    return <p className="border-y border-dashed border-line py-1.5 text-center text-[11px] text-ink-3">{m.content}</p>
  }
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-inset px-3 py-2 text-ink">{m.content}</p>
      </div>
    )
  }
  const basic = m.role === 'basic'
  return (
    <div>
      {basic && (
        <p className="mb-1.5 inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-3">
          Basic answer · not AI
        </p>
      )}
      <RichText text={m.content} onNav={onNav} />
      {m.verdicts && m.verdicts.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1" aria-label="The page's verdicts when this was answered">
          {m.verdicts.map((v) => <span key={v} className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-3">{v}</span>)}
        </p>
      )}
      <p className="mt-1 text-[10px] text-ink-4">
        {basic ? 'Assembled from the page’s own results, without AI' : 'AI answer from this comparison · the chips show the page’s own verdicts'}
      </p>
    </div>
  )
}
