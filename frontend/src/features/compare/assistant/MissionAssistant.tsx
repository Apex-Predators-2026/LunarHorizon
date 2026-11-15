// Mission Assistant: a chat panel on the right of the Scenario Comparison page.
//
// It reads the comparison exactly as the page shows it (context.ts), asks the backend (which holds the API key),
// and only explains: it cannot change scenarios, requirements, rankings or Rescue plans. When the AI service is
// unavailable it says so plainly and never makes an answer up.
//
// Layouts: docked on the side (drag its left / top edge to resize), full screen (Rover is in the panel), or
// minimized to a slim dock with Rover standing beside it. The title bar carries the mango mesh and the controls.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'

import { InteractiveGrainGradient } from '../../../ui/InteractiveGrainGradient'
import { RoverMascot } from '../../../ui/RoverMascot'
import type { Entry } from '../analysis'
import type { PairEvidence, RankingGroup } from '../types'
import { Icon } from '../ui'
import { useCompareStore } from '../useCompareStore'
import './assistantUi.css'
import { buildAssistantContext, contextLine, type AssistantContext } from './context'
import { openReport } from './openReport'
import { reportForAssistant } from './reportContext'
import { selectionKeyOf, useReportStore } from '../report'
import { SIDE_MIN_H, SIDE_MIN_W, useAssistantLayout, type AssistantLayout } from './layout'
import { countWords, firstWords } from './paced'
import type { NavTarget } from './navigation'
import { RichText } from './RichText'
import { suggestedQuestions } from './suggestions'
import { MAX_QUESTION, useAssistant, type ChatMessage } from './useAssistant'
import { actStart } from '../../tutorial/steps'
import { useTutorialStore } from '../../tutorial/useTutorialStore'

/** Default width of the side panel; the page leaves this much room on wide screens so nothing is covered. */
export const ASSISTANT_WIDTH = 400

// Same style scope as the comparison page, without its page background or padding.
const SCOPE = 'cmp-page lp-light md-host'
const SCOPE_STYLE = { background: 'transparent', minHeight: 0, padding: 0, margin: 0 } as const

const GAP = 16 // distance from the window's edges
const WORD_MS = 85 // one word about every 85 ms (roughly 12 words a second)
const DOCK_W = 64
const DOCK_H = 232
const ROVER_SIZE = 230 // Rover's width everywhere he stands (beside the panel, the dock, or in the full-screen rail)
const ROVER_H = Math.round((ROVER_SIZE * 148) / 160)

/** Space taken by the app's floating header (the scrolling <main> is padded by exactly that much). */
function useHeaderOffset(): number {
  const [top, setTop] = useState(88)
  useLayoutEffect(() => {
    const read = () => {
      // The visible page: the Planner stays mounted (aria-hidden) behind the other pages.
      const main = document.querySelector('main:not([aria-hidden="true"])')
      const pad = main ? parseFloat(getComputedStyle(main).paddingTop) : NaN
      setTop(Number.isFinite(pad) && pad > 0 ? Math.round(pad) + 4 : 88)
    }
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])
  return top
}

function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return vp
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
    useAssistantLayout.getState().setLayout('side')
  }
  const rescue = useCompareStore((s) => s.rescueContext)
  // Rebuilt whenever the selection, the requirements, the results or the Rescue import change, so a question always
  // goes out with the comparison as it is at that moment (never a stale copy).
  // The generated Mission Report (frozen), flagged out of date when the live comparison has changed since.
  const snapshot = useReportStore((s) => s.snapshot)
  const reportOpen = useReportStore((s) => s.open)
  const liveKey = useCompareStore((s) => selectionKeyOf(s))
  const report = useMemo(() => reportForAssistant(snapshot, liveKey, reportOpen), [snapshot, liveKey, reportOpen])
  const context = useMemo(() => buildAssistantContext(entries, groups, pairs, notes, ready, rescue, report),
    [entries, groups, pairs, notes, ready, rescue, report])
  // Links in answers only move around the page or start the tour: they never change anything.
  const onNav = (target: NavTarget) => {
    if (typeof window !== 'undefined' && (window.innerWidth < SIDE_BY_SIDE_MIN || useAssistantLayout.getState().layout === 'full')) {
      useAssistantLayout.getState().setLayout('min')
    }
    if (target === 'tour') useTutorialStore.getState().startTour(actStart(2), 'full')
    else if (target === 'report') openReport()
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

const ASK_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g font-family='Helvetica,Arial,sans-serif' font-weight='700' font-size='25' text-anchor='middle' fill='black'><text x='50' y='46'>Ask</text><text x='50' y='74'>Rover</text></g></svg>",
)}")`

/** The launcher's words as a mask image drawn in Inter Light (falls back to Helvetica until the font has loaded). */
function useAskMask(): string {
  const [mask, setMask] = useState(ASK_MASK)
  useEffect(() => {
    let live = true
    void document.fonts?.load('300 100px Inter').then(() => {
      if (!live) return
      const c = document.createElement('canvas')
      c.width = c.height = 400
      const g = c.getContext('2d')
      if (!g) return
      g.fillStyle = '#000'
      g.textAlign = 'center'
      g.font = '300 112px Inter, sans-serif'
      g.fillText('Ask', 200, 178)
      g.fillText('Rover', 200, 296)
      setMask(`url(${c.toDataURL('image/png')})`)
    }).catch(() => {})
    return () => { live = false }
  }, [])
  return mask
}

function Launcher({ buttonRef }: { buttonRef: Ref<HTMLButtonElement> }) {
  const { setOpen } = useAssistant.getState()
  const mask = useAskMask()
  return (
    <div className={`${SCOPE} fixed bottom-5 right-12 z-[70]`} style={SCOPE_STYLE}>
      <div className="ask-rover">
        {/* Rover waits behind the button and peeks his head over the top when it is hovered. */}
        <div className="ask-rover-peek" aria-hidden="true"><div className="ask-rover-in"><RoverMascot facing="left" size={160} /></div></div>
        <button ref={buttonRef} type="button" data-tour="compare-assistant" onClick={() => { useAssistantLayout.getState().setLayout('side'); setOpen(true) }}
          className="md-pop-fab relative z-[1] flex h-32 w-32 items-center justify-center rounded-[20%] bg-opal-50 shadow-lg shadow-black/40"
          aria-label="Open the Mission Assistant" data-tip="Ask Rover about this comparison">
          {/* The words are cut out of the mango mesh. */}
          <span aria-hidden className="block h-full w-full" style={{ WebkitMaskImage: mask, maskImage: mask, WebkitMaskSize: '100% 100%', maskSize: '100% 100%' }}>
            <InteractiveGrainGradient className="h-full w-full" />
          </span>
        </button>
      </div>
    </div>
  )
}

// ---- small icons for the title bar (24 x 24, stroked) -------------------------------------------------------
const BAR_ICONS = {
  minimize: 'M5 19h14',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  restore: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  expand: 'M14 5l-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
} as const

/** Makes whatever is inside bounce up and down, energetically, while `on` (Rover while he talks). */
function Bounce({ on, lift = 10, children }: { on: boolean; lift?: number; children: ReactNode }) {
  return (
    <span className="cmp-ai-bounce" data-on={on} style={{ ['--bounce' as string]: `${-lift}px` }}>
      {children}
    </span>
  )
}

/** Rover standing on the page: he poofs in (he pops in and shrinks away) and poofs out when `show` ends. */
function PoofRover({ show, pos, facing = 'right', talking = false, onClick, bubble }: {
  show: boolean
  pos: { left: number; top: number } | null
  facing?: 'right' | 'left'
  talking?: boolean
  onClick?: () => void
  bubble?: string
}) {
  const visible = show && pos !== null
  const [mounted, setMounted] = useState(visible)
  const last = useRef(pos)
  if (visible) last.current = pos
  useEffect(() => {
    if (visible) { setMounted(true); return }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const t = window.setTimeout(() => setMounted(false), reduce ? 0 : 700)
    return () => window.clearTimeout(t)
  }, [visible])
  const at = visible ? pos : last.current
  if (!at || (!visible && !mounted)) return null
  return (
    <div className="rover-poof" data-phase={visible ? 'in' : 'out'} style={{ left: at.left, top: at.top, width: ROVER_SIZE, height: ROVER_H }}>
      <div className="rover-poof-body" onClick={onClick} style={{ cursor: onClick ? 'pointer' : undefined }}>
        {bubble && <span className="cmp-ai-bubble">{bubble}</span>}
        <Bounce on={talking} lift={30}><RoverMascot facing={facing} size={ROVER_SIZE} state={talking ? 'talking' : 'idle'} /></Bounce>
      </div>
    </div>
  )
}

function BarIcon({ name, size = 18 }: { name: keyof typeof BAR_ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={BAR_ICONS[name]} />
    </svg>
  )
}

function BarButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} data-tip={label} data-no-ripple onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-full text-white transition-colors hover:bg-white/25 focus-visible:bg-white/25"
      style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.35))' }}>
      {children}
    </button>
  )
}

/** Drag handles on the side panel's left and top edges (and the corner between them). */
function ResizeGrips({ width, height, maxW, maxH, onSize, onActive }: {
  width: number
  height: number
  maxW: number
  maxH: number
  onSize: (w: number, h: number) => void
  onActive: (active: boolean) => void
}) {
  const start = (dir: 'w' | 'n' | 'nw') => (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const x0 = e.clientX
    const y0 = e.clientY
    try { el.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    el.dataset.active = 'true'
    onActive(true)
    const move = (ev: PointerEvent) => {
      const w = dir === 'n' ? width : Math.min(maxW, Math.max(SIDE_MIN_W, width + (x0 - ev.clientX)))
      const h = dir === 'w' ? height : Math.min(maxH, Math.max(SIDE_MIN_H, height + (y0 - ev.clientY)))
      onSize(w, h)
    }
    const up = () => {
      el.dataset.active = 'false'
      onActive(false)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return (
    <>
      <div className="cmp-ai-grip cmp-ai-grip-w" aria-hidden="true" onPointerDown={start('w')} />
      <div className="cmp-ai-grip cmp-ai-grip-n" aria-hidden="true" onPointerDown={start('n')} />
      <div className="cmp-ai-grip cmp-ai-grip-nw" aria-hidden="true" onPointerDown={start('nw')} />
    </>
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
  const layout = useAssistantLayout((s) => s.layout)
  const sideW = useAssistantLayout((s) => s.w)
  const sideH = useAssistantLayout((s) => s.h)
  const { setLayout, setSize } = useAssistantLayout.getState()
  const [draft, setDraft] = useState('')
  const [resizing, setResizing] = useState(false)

  // ---- Paced reveal: answers appear word by word (not as the stream or reply lands) while Rover talks ----
  const lastMsg = messages[messages.length - 1]
  const lastIsAnswer = lastMsg && (lastMsg.role === 'assistant' || lastMsg.role === 'basic')
  const [seenId, setSeenId] = useState<string | null>(() => (lastIsAnswer ? lastMsg.id : null)) // answers already shown in full
  const [shown, setShown] = useState(0) // words revealed of the answer being typed
  const sawStream = useRef(false)
  const reduced = useRef(typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const fresh = lastIsAnswer && lastMsg.id !== seenId && !reduced.current ? lastMsg : null // the answer still being typed
  const answerText = streamingReply || fresh?.content || ''
  const totalWords = countWords(answerText)
  const totalRef = useRef(0)
  totalRef.current = totalWords
  const typing = Boolean(streamingReply) || (fresh !== null && shown < totalWords)

  // A new question starts a new reveal.
  useEffect(() => {
    if (pending) {
      setShown(0)
      sawStream.current = false
    }
  }, [pending])
  useEffect(() => {
    if (streamingReply) sawStream.current = true
  }, [streamingReply])
  // A reply that did not stream (a basic answer) starts from the first word.
  const freshId = fresh?.id ?? null
  useEffect(() => {
    if (freshId && !sawStream.current) setShown(0)
  }, [freshId])
  // The ticker: one more word every WORD_MS; it speeds up if the text is far ahead of what is shown.
  useEffect(() => {
    if (!streamingReply && !freshId) return
    const id = window.setInterval(() => {
      setShown((n) => {
        const total = totalRef.current
        return n >= total ? n : Math.min(total, n + (total - n > 60 ? 4 : total - n > 30 ? 2 : 1))
      })
    }, WORD_MS)
    return () => window.clearInterval(id)
  }, [Boolean(streamingReply), freshId])
  // Fully shown: it becomes an ordinary message.
  useEffect(() => {
    if (freshId && !pending && shown >= totalWords && totalWords > 0) {
      setSeenId(freshId)
      sawStream.current = false
    }
  }, [freshId, pending, shown, totalWords])
  const top = useHeaderOffset()
  const vp = useViewport()
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ---- geometry (all px, so changes between layouts animate) ----
  const maxH = Math.max(SIDE_MIN_H, vp.h - top - GAP)
  const maxW = Math.max(SIDE_MIN_W, vp.w - 2 * GAP)
  const w = Math.min(maxW, Math.max(SIDE_MIN_W, sideW))
  const h = Math.min(maxH, Math.max(SIDE_MIN_H, sideH ?? maxH))
  const geo =
    layout === 'full' ? { left: GAP, top, width: vp.w - 2 * GAP, height: vp.h - top - GAP }
    : layout === 'min' ? { left: vp.w - GAP - DOCK_W, top: vp.h - GAP - DOCK_H, width: DOCK_W, height: DOCK_H }
    : { left: vp.w - GAP - w, top: vp.h - GAP - h, width: w, height: h }

  // The page leaves room for the side panel (and only for it).
  useEffect(() => {
    document.documentElement.style.setProperty('--assistant-w', `${w}px`)
    return () => { document.documentElement.style.removeProperty('--assistant-w') }
  }, [w])

  // Check once per opening whether the backend can answer (no AI call, nothing billed).
  useEffect(() => {
    if (!open) return
    setDraft('')
    void checkStatus()
    inputRef.current?.focus({ preventScroll: true })
  }, [open, checkStatus])

  // A question asked from a button on the page needs the panel visible: open it out of the dock.
  useEffect(() => {
    if (open && queued && useAssistantLayout.getState().layout === 'min') setLayout('side')
  }, [open, queued, setLayout])

  // Keep the newest message in view.
  useEffect(() => {
    const el = logRef.current
    if (open && el) el.scrollTop = el.scrollHeight
  }, [open, layout, messages.length, pending, streamingReply, shown, error])

  // The composer grows with what is typed (up to about six lines).
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 168)}px`
    }
    fit()
    // Also when the panel's width changes (resizing, full screen): the placeholder / text re-wraps.
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [draft, layout])

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

  const full = layout === 'full'
  const min = layout === 'min'
  // Rover's stand: left of the panel (side), left of the dock (minimized), or in the full-screen rail.
  const standLeft = geo.left - ROVER_SIZE - 4
  const standTop = geo.top + geo.height - ROVER_H
  const sidePos = standLeft >= 8 ? { left: standLeft, top: standTop } : null
  const fullPos = vp.w >= 768 ? { left: geo.left + 1 + 35, top: geo.top + 1 + 48 + 32 } : null
  const sideRover = open && layout === 'side' && sidePos !== null
  const talking = typing

  const chat = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* What it is reading */}
      <div className="border-b border-line bg-inset/60 px-4 py-1.5 text-[11px] leading-snug text-ink-3" aria-live="polite">
        <span className="font-medium text-ink-2">Reading:</span> {contextLine(context)}
      </div>

      {unavailable && (
        <div role="status" className={`mx-auto mt-3 flex w-[calc(100%-32px)] items-start gap-2 rounded-2xl border border-line px-3 py-2 text-xs leading-relaxed text-ink-2 ${full ? 'max-w-3xl' : ''}`}>
          <Icon name="info" size={14} className="mt-0.5 shrink-0 text-ink-3" />
          <div className="flex-1">
            <p>{availabilityMessage ?? 'The Mission Assistant is not available right now.'}</p>
            <p className="mt-1 text-ink-3">Questions get a basic answer built from the page's own results instead (no AI).</p>
            <button type="button" className="cmp-btn-quiet mt-1 text-xs" onClick={() => void checkStatus()}>Check again</button>
          </div>
        </div>
      )}

      {/* Conversation */}
      <div ref={logRef} role="log" aria-live="polite" aria-label="Conversation" className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm leading-relaxed text-ink-2">
        <div className={`mx-auto space-y-5 ${full ? 'max-w-3xl' : ''}`}>
          {messages.length === 0 && (
            <div className="space-y-4">
              {!full && (
                <div className="flex flex-col items-center gap-2 pt-2 text-center">
                  {!sideRover && <Bounce on={talking} lift={16}><RoverMascot facing="left" size={92} state={talking ? 'talking' : 'idle'} /></Bounce>}
                  <h3 className="text-lg font-medium text-ink">Ask Rover about this comparison</h3>
                  <p className="max-w-[28ch] text-sm text-ink-3">I'm here to help you understand your missions. Ask me anything about your mission data.</p>
                </div>
              )}
              {full && (
                <div className="pt-6 text-center">
                  <h3 className="text-2xl font-medium text-ink">What would you like to know?</h3>
                  <p className="mt-1 text-sm text-ink-3">I read this comparison as you see it, and I only explain: I can't change your plans.</p>
                </div>
              )}
              {context.state === 'empty' && (
                <p className="text-center">No plans are selected yet. I can show you how to set up a comparison, or explain what the page shows.</p>
              )}
              <Suggestions items={suggestions} disabled={pending} onPick={submit} cards={suggestions.length > 0} />
            </div>
          )}
          {messages.map((m) => <Message key={m.id} m={m} onNav={onNav} reveal={fresh?.id === m.id ? { words: shown, talking: typing } : undefined} />)}
          {streamingReply && (
            <div aria-live="off" className="flex gap-3">
              <span className="mt-0.5 shrink-0"><Bounce on lift={7}><RoverMascot facing="right" size={28} state="talking" /></Bounce></span>
              <div className="min-w-0 flex-1"><RichText text={firstWords(streamingReply, shown)} /></div>
            </div>
          )}
          {pending && (
            <div className="flex items-center gap-2 text-xs text-ink-3" role="status">
              <span className="inline-flex gap-1" aria-hidden="true">
                <span className="h-1.5 w-1.5 rounded-full bg-coral/80 motion-safe:animate-pulse" />
                <span className="h-1.5 w-1.5 rounded-full bg-coral/80 motion-safe:animate-pulse [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 rounded-full bg-coral/80 motion-safe:animate-pulse [animation-delay:300ms]" />
              </span>
              {streamingReply ? 'Rover is responding…' : 'Reading the comparison…'}
            </div>
          )}
          {error && !pending && (
            <div role="alert" className="flex items-start gap-2 rounded-2xl border border-red-800 bg-red-950 px-3 py-2 text-xs leading-relaxed text-red-200">
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
      </div>

      {messages.length > 0 && !pending && (
        <div className={`mx-auto w-full px-4 pt-1 ${full ? 'max-w-3xl' : ''}`}>
          <Suggestions items={suggestions.slice(0, 3)} disabled={pending} onPick={submit} compact />
        </div>
      )}

      {/* Composer: one rounded field, the send button inside it */}
      <form className={`mx-auto w-full px-4 pb-3 pt-1 ${full ? 'max-w-3xl' : ''}`} onSubmit={(e) => { e.preventDefault(); submit(draft) }}>
        <div className="cmp-ai-composer flex items-end gap-2 rounded-[26px] border border-line bg-surface py-2 pl-4 pr-2 shadow-sm transition-shadow">
          <label htmlFor="cmp-assistant-input" className="sr-only">Ask the Mission Assistant</label>
          <textarea id="cmp-assistant-input" ref={inputRef} rows={1} maxLength={MAX_QUESTION} value={draft}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
            placeholder={unavailable ? 'AI unavailable: basic answers from the page…' : 'Ask anything about this comparison'}
            className="max-h-[168px] min-h-[28px] flex-1 resize-none self-center bg-transparent py-1 text-sm leading-6 text-ink outline-none placeholder:text-ink-4 disabled:opacity-60" />
          {pending ? (
            <button type="button" onClick={stop} aria-label="Stop" data-tip="Stop answering"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-surface transition-opacity hover:opacity-85">
              <span className="block h-3 w-3 rounded-[3px] bg-current" />
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim()} aria-label="Send question" data-tip="Send"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-coral text-white transition-opacity hover:opacity-90 disabled:bg-inset disabled:text-ink-4">
              <Icon name="send" size={16} />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[11px] text-ink-4">Rover only explains this comparison. Check important numbers on the page.</p>
      </form>
    </div>
  )

  return (
    <>
      {full && <div className="pointer-events-auto absolute inset-0 bg-black/35" aria-hidden="true" onClick={() => setLayout('side')} />}

      <div className={`${SCOPE} cmp-assistant-panel cmp-ai absolute`} data-open={open} data-layout={layout} data-resizing={resizing}
        style={{ ...SCOPE_STYLE, left: geo.left, top: geo.top, width: geo.width, height: geo.height }}>
        <aside aria-label="Mission Assistant" data-tour={open ? 'compare-assistant' : undefined}
          onKeyDown={(e) => { if (e.key === 'Escape') { if (full) setLayout('side'); else onClose() } }}
          className="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[22px] border border-line bg-surface text-ink shadow-2xl">

          {/* Minimized: a slim dock (Rover stands beside it) */}
          {min && (
            <button type="button" onClick={() => setLayout('side')} aria-label="Open the Mission Assistant" data-tip="Open the Mission Assistant" data-no-ripple
              className="relative flex h-full w-full flex-col items-center justify-between py-3 text-white">
              <InteractiveGrainGradient fill strength={1.6} patternScale={0.45} />
              <span className="relative text-white" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.35))' }}><BarIcon name="expand" size={22} /></span>
              <span className="relative text-sm font-semibold tracking-wide [writing-mode:vertical-rl]" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.4)', transform: 'rotate(180deg)' }}>
                Mission Assistant
              </span>
              <span className="relative h-1.5 w-1.5 rounded-full bg-white/80" aria-hidden="true" />
            </button>
          )}

          {/* Title bar: the mango mesh, with the window controls */}
          <header className={`relative flex h-12 shrink-0 select-none items-center gap-2 px-3 text-white ${min ? 'hidden' : ''}`}
            onDoubleClick={() => setLayout(full ? 'side' : 'full')}>
            <InteractiveGrainGradient fill strength={1.6} patternScale={0.45} />
            <span className="relative flex min-w-0 flex-1 items-center gap-2">
              <span className="cmp-ai-babydoll truncate text-[26px] leading-none" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>Rover</span>
            </span>
            <span className="relative flex items-center gap-0.5">
              {messages.length > 0 && <BarButton label="New chat" onClick={clear}><BarIcon name="plus" /></BarButton>}
              <BarButton label="Minimize" onClick={() => (full ? setLayout('side') : onClose())}><BarIcon name="minimize" /></BarButton>
              <BarButton label={full ? 'Exit full screen' : 'Full screen'} onClick={() => setLayout(full ? 'side' : 'full')}>
                <BarIcon name={full ? 'restore' : 'full'} />
              </BarButton>
              <BarButton label="Close the Mission Assistant" onClick={onClose}><BarIcon name="close" /></BarButton>
            </span>
          </header>

          {/* Body */}
          <div className={`flex min-h-0 flex-1 ${min ? 'hidden' : ''}`} aria-hidden={min}>
            {full && (
              <aside aria-label="About Rover" className="hidden w-[300px] shrink-0 flex-col items-center gap-4 overflow-y-auto border-r border-line bg-inset/50 px-6 py-8 text-center md:flex">
                {fullPos ? <div className="shrink-0" style={{ height: ROVER_H }} aria-hidden="true" /> : <RoverMascot facing="right" size={ROVER_SIZE} state={talking ? 'talking' : 'idle'} />}
                <div>
                  <h2 className="text-xl font-medium text-ink">Ask Rover about this comparison</h2>
                  <p className="mt-1 text-sm leading-relaxed text-ink-3">Your mission assistant. I explain this comparison and show you around the page. Read-only: I can't change your plans.</p>
                </div>
                {messages.length > 0 && (
                  <button type="button" className="cmp-btn-quiet text-sm" onClick={clear}>Start a new chat</button>
                )}
              </aside>
            )}
            {chat}
          </div>

          {/* Resize handles (side layout only) */}
          {layout === 'side' && (
            <ResizeGrips width={w} height={h} maxW={maxW} maxH={maxH} onActive={setResizing}
              onSize={(nw, nh) => setSize(nw, nh >= maxH - 1 ? null : nh)} />
          )}
        </aside>
      </div>

      {/* Rover poofs in and out as the panel changes layout */}
      <PoofRover show={open && layout === 'side'} pos={sidePos} talking={talking} />
      <PoofRover show={open && layout === 'min'} pos={sidePos} onClick={() => setLayout('side')} bubble="Need a hand? Ask me!" />
      <PoofRover show={open && layout === 'full'} pos={fullPos} talking={talking} />
    </>
  )
}

function Suggestions({ items, disabled, onPick, compact = false, cards = false }: { items: string[]; disabled: boolean; onPick: (q: string) => void; compact?: boolean; cards?: boolean }) {
  if (cards && !compact) {
    return (
      <div>
        <p className="mb-2 text-center text-[11px] font-medium text-ink-4">Try asking</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {items.slice(0, 4).map((q) => (
            <li key={q}>
              <button type="button" disabled={disabled} onClick={() => onPick(q)}
                className="h-full w-full rounded-2xl border border-line px-3.5 py-2.5 text-left text-sm leading-snug text-ink-2 transition-colors hover:bg-inset hover:text-ink disabled:opacity-50">
                {q}
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div>
      {!compact && <p className="mb-1.5 text-[11px] font-medium text-ink-4">Suggested questions</p>}
      <ul className={compact ? 'flex gap-1.5 overflow-x-auto pb-1' : 'flex flex-col items-start gap-1.5'}>
        {items.map((q) => (
          <li key={q} className={compact ? 'shrink-0' : ''}>
            <button type="button" disabled={disabled} onClick={() => onPick(q)}
              className="rounded-full border border-line px-3 py-1 text-left text-xs text-ink-2 transition-colors hover:bg-inset hover:text-ink disabled:opacity-50">
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Message({ m, onNav, reveal }: { m: ChatMessage; onNav: (t: NavTarget) => void; reveal?: { words: number; talking: boolean } }) {
  if (m.role === 'notice') {
    return <p className="border-y border-dashed border-line py-1.5 text-center text-[11px] text-ink-3">{m.content}</p>
  }
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-3xl bg-inset px-4 py-2.5 text-ink">{m.content}</p>
      </div>
    )
  }
  const basic = m.role === 'basic'
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 shrink-0"><Bounce on={Boolean(reveal?.talking)} lift={7}><RoverMascot facing="right" size={28} animated={Boolean(reveal)} state={reveal?.talking ? 'talking' : 'idle'} /></Bounce></span>
      <div className="min-w-0 flex-1">
        {basic && (
          <p className="cmp-ai-babydoll mb-1 text-[20px] leading-none text-coral">Rover says...</p>
        )}
        <RichText text={reveal ? firstWords(m.content, reveal.words) : m.content} onNav={onNav} />
        {!reveal && m.verdicts && m.verdicts.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-1" aria-label="The page's verdicts when this was answered">
            {m.verdicts.map((v) => <span key={v} className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-3">{v}</span>)}
          </p>
        )}
        {!reveal && <p className="mt-1 text-[10px] text-ink-4">
          {basic ? 'Assembled from the page’s own results, without AI' : 'AI answer from this comparison · the chips show the page’s own verdicts'}
        </p>}
      </div>
    </div>
  )
}

export type { AssistantLayout }
