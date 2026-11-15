import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { InteractiveGrainGradient } from '../../ui/InteractiveGrainGradient'
import { playUiTap } from '../../viz/sfx'
import { useReveal } from '../compare/disclosure'
import { tabOfSection, useCompareView } from '../compare/sections'
import { useGuide, type StageModel } from '../guide/mission'
import { TOUR_ACTS, TUTORIAL_STEPS, type TourAct } from './steps'
import { runStoryAction, useStoryModel, type StoryAction } from './storyBridge'
import { useTutorialStore } from './useTutorialStore'
import { computeCoachmarkPosition, handleTutorialKeyDown, PAGE_TOP_CLEARANCE, scrollParent, type RectBox } from './utils'

const SPOTLIGHT_PAD = 8
/** After this long a working story step offers Retry (it never advances on its own). */
const SLOW_MS = 15_000

function findTargetElement(selectors: string[]): HTMLElement | null {
  if (typeof document === 'undefined') return null
  for (const selector of selectors) {
    const matches = document.querySelectorAll<HTMLElement>(selector)
    for (const el of matches) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return el
    }
  }
  return null
}

/** Where the card goes: next to the target; docked left when the step asks; a corner when no free side fits. */
function placeCard(
  step: (typeof TUTORIAL_STEPS)[number],
  target: RectBox | null,
  viewport: { width: number; height: number },
  card: { width: number; height: number },
): { left: number; top: number } {
  const edge = 16
  if (step.dock === 'left') return { left: edge, top: Math.max(edge, Math.min(120, viewport.height - card.height - edge)) }
  const p = computeCoachmarkPosition(target, viewport, card, step.preferredPlacement)
  if (!target) return p
  const covers = !(p.left + card.width <= target.left || p.left >= target.right || p.top + card.height <= target.top || p.top >= target.bottom)
  if (!covers) return p
  // Bottom-right covers the least of a target that was scrolled to the top of the page.
  return { left: Math.max(edge, viewport.width - card.width - edge), top: Math.max(edge, viewport.height - card.height - edge) }
}

export interface StoryCardModel {
  model: StageModel
  catchingUp: boolean
  slow: boolean
}

export function TutorialSpotlight({ uiHidden }: { uiHidden: boolean }) {
  const open = useTutorialStore((s) => s.open)
  const stepIndex = useTutorialStore((s) => s.stepIndex)
  const actionDone = useTutorialStore((s) => s.actionDone)
  const nextStep = useTutorialStore((s) => s.nextStep)
  const prevStep = useTutorialStore((s) => s.prevStep)
  const goToStep = useTutorialStore((s) => s.goToStep)
  const goToAct = useTutorialStore((s) => s.goToAct)
  const skipTour = useTutorialStore((s) => s.skipTour)
  const setNextBlocked = useTutorialStore((s) => s.setNextBlocked)

  const step = TUTORIAL_STEPS[stepIndex] ?? TUTORIAL_STEPS[0]
  const total = TUTORIAL_STEPS.length
  const live = useStoryModel(open ? step.story : undefined)
  const working = !!live && (live.catchingUp || live.model.status === 'working')

  // "Taking long" only offers Retry; it never advances the tour.
  const run = useGuide((g) => g.run)
  const [slowKey, setSlowKey] = useState<string | null>(null)
  const workKey = working ? `${stepIndex}:${run}` : null
  useEffect(() => {
    if (!workKey) return
    const t = setTimeout(() => setSlowKey(workKey), SLOW_MS)
    return () => clearTimeout(t)
  }, [workKey])
  const story: StoryCardModel | null = live ? { ...live, slow: workKey !== null && slowKey === workKey } : null

  // Next (button and ArrowRight) waits for the live result of a story step.
  useEffect(() => {
    setNextBlocked(open && working)
  }, [open, working, setNextBlocked, stepIndex])

  const maskId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLHeadingElement>(null)

  // Keyboard and screen-reader users follow the tour: focus moves to the step heading when the tour opens, and on
  // each step change while focus was in the card (or was dropped to the page).
  const wasOpen = useRef(false)
  useEffect(() => {
    if (!open || uiHidden) {
      wasOpen.current = false
      return
    }
    const active = typeof document !== 'undefined' ? document.activeElement : null
    const inCard = !!active && !!cardRef.current?.contains(active)
    if (!wasOpen.current || inCard || active === document.body || active === null) headRef.current?.focus({ preventScroll: true })
    wasOpen.current = true
  }, [open, uiHidden, stepIndex])
  const [layout, setLayout] = useState<{
    stepIndex: number
    targetRect: RectBox | null
    viewport: { width: number; height: number }
    cardSize: { width: number; height: number }
  }>(() => ({
    stepIndex: -1,
    targetRect: null,
    viewport: typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight } : { width: 1366, height: 768 },
    cardSize: { width: 388, height: 300 },
  }))

  const measure = useCallback(() => {
    if (typeof window === 'undefined' || !open || uiHidden) return
    const nextViewport = { width: window.innerWidth, height: window.innerHeight }
    const el = findTargetElement(step.targetSelectors)
    let nextRect: RectBox | null = null
    if (el) {
      const r = el.getBoundingClientRect()
      const clipParent = el.closest('[data-tour="sidebar-card"]')
      const cr = clipParent ? clipParent.getBoundingClientRect() : null
      const top = Math.max(0, cr ? Math.max(r.top, cr.top) : r.top)
      const bottom = Math.min(window.innerHeight, cr ? Math.min(r.bottom, cr.bottom) : r.bottom)
      const left = Math.max(0, cr ? Math.max(r.left, cr.left) : r.left)
      const right = Math.min(window.innerWidth, cr ? Math.min(r.right, cr.right) : r.right)
      nextRect = bottom > top && right > left
        ? { left, top, right, bottom, width: right - left, height: bottom - top }
        : null
    }
    const card = cardRef.current
    const cr = card ? card.getBoundingClientRect() : null
    const nextCardSize = cr && cr.width > 0 && cr.height > 0 ? { width: Math.round(cr.width), height: Math.round(cr.height) } : null

    setLayout((prev) => {
      const nextCs = nextCardSize ?? prev.cardSize
      const sameStep = prev.stepIndex === stepIndex
      const sameVp = prev.viewport.width === nextViewport.width && prev.viewport.height === nextViewport.height
      const sameCs = Math.abs(prev.cardSize.width - nextCs.width) <= 1 && Math.abs(prev.cardSize.height - nextCs.height) <= 1
      const sameRect =
        prev.targetRect === null && nextRect === null
          ? true
          : prev.targetRect !== null &&
            nextRect !== null &&
            Math.abs(prev.targetRect.left - nextRect.left) <= 1.5 &&
            Math.abs(prev.targetRect.top - nextRect.top) <= 1.5 &&
            Math.abs(prev.targetRect.width - nextRect.width) <= 1.5 &&
            Math.abs(prev.targetRect.height - nextRect.height) <= 1.5
      if (sameStep && sameVp && sameCs && sameRect) return prev
      return { stepIndex, targetRect: nextRect, viewport: nextViewport, cardSize: nextCs }
    })
  }, [open, uiHidden, step, stepIndex])

  // A comparison step opens the tab and expandable block holding its target before the target is looked for.
  useEffect(() => {
    if (!open || !step.reveal) return
    const tab = tabOfSection(step.reveal)
    if (tab) useCompareView.getState().setTab(tab)
    useReveal.getState().reveal(step.reveal)
  }, [open, step])

  // Bring the target into view once per step (and again when it first appears, e.g. after the view switch).
  const scrolledFor = useRef<number>(-1)
  useEffect(() => {
    if (!open) scrolledFor.current = -1
  }, [open])

  useEffect(() => {
    if (!open || uiHidden) return
    const bringIntoView = () => {
      if (scrolledFor.current === stepIndex) return
      const el = findTargetElement(step.targetSelectors)
      if (!el) return
      scrolledFor.current = stepIndex
      if (step.view === 'planner') {
        el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      } else {
        // Scrolling pages: the target goes near the top, below the header, leaving room for the card.
        el.scrollIntoView?.({ block: 'start', behavior: 'auto' })
        scrollParent(el)?.scrollBy({ top: -PAGE_TOP_CLEARANCE, behavior: 'auto' })
      }
    }
    const tick = () => {
      bringIntoView()
      measure()
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(tick) : null
    if (ro) {
      const targetEl = findTargetElement(step.targetSelectors)
      if (targetEl) ro.observe(targetEl)
      if (cardRef.current) ro.observe(cardRef.current)
      ro.observe(document.body)
    }
    window.addEventListener('resize', tick)
    window.addEventListener('scroll', measure, true)
    const raf = requestAnimationFrame(tick)
    // Views and panels mount asynchronously (view switch, lazy sections, Rescue results): keep looking for a while,
    // then stop once the target has been found for ~3 s (resize, scroll and ResizeObserver keep it in place after).
    let ticks = 0
    let found = 0
    const settle = window.setInterval(() => {
      tick()
      ticks++
      if (findTargetElement(step.targetSelectors)) found++
      if (found > 10 || ticks > 100) window.clearInterval(settle)
    }, 300)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', tick)
      window.removeEventListener('scroll', measure, true)
      cancelAnimationFrame(raf)
      window.clearInterval(settle)
    }
  }, [open, uiHidden, stepIndex, actionDone, measure, step.targetSelectors, step.view])

  useEffect(() => {
    if (!open || uiHidden) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (handleTutorialKeyDown(e)) e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, uiHidden])

  if (!open || uiHidden) return null

  const settledStepIndex = layout.stepIndex >= 0 ? layout.stepIndex : stepIndex
  const settledStep = TUTORIAL_STEPS[settledStepIndex] ?? step
  const targetRect = layout.stepIndex === stepIndex ? layout.targetRect : null
  const box = targetRect
    ? {
        x: Math.max(4, Math.round(targetRect.left - SPOTLIGHT_PAD)),
        y: Math.max(4, Math.round(targetRect.top - SPOTLIGHT_PAD)),
        w: Math.max(24, Math.round(targetRect.width + SPOTLIGHT_PAD * 2)),
        h: Math.max(24, Math.round(targetRect.height + SPOTLIGHT_PAD * 2)),
      }
    : null

  const cardPos = placeCard(settledStep, targetRect, layout.viewport, layout.cardSize)

  return (
    <TutorialSpotlightView
      step={step}
      stepIndex={stepIndex}
      total={total}
      actionDone={actionDone}
      box={box}
      cardPos={cardPos}
      cardRef={cardRef}
      headRef={headRef}
      maskId={maskId}
      story={story}
      onPrev={prevStep}
      onNext={nextStep}
      onSkip={skipTour}
      onGoToStep={goToStep}
      onGoToAct={goToAct}
      onStoryAction={runStoryAction}
    />
  )
}

const FACT_TONE: Record<string, string> = {
  pass: 'text-emerald-300',
  fail: 'text-red-300',
  unknown: 'text-slate-300',
  neutral: 'text-slate-200',
  not_applicable: 'text-slate-300',
}

const STATUS_WORD: Record<string, string> = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN', not_applicable: 'n/a' }

/** The engine's own explanation, first sentence only (the facts below carry the numbers). */
function firstSentence(text: string): string {
  const t = text.trim()
  const m = t.match(/^(.+?[.!?])(\s+[A-Z(]|$)/)
  return m ? m[1] : t
}

/** Live mission content for a story step: honest working / problem states, then up to three live facts. */
function StoryBlock({ story, onStoryAction }: { story: StoryCardModel; onStoryAction: (a: StoryAction) => void }) {
  const { model, catchingUp, slow } = story
  if (catchingUp || model.status === 'working') {
    return (
      <div role="status" className="flex items-start gap-2.5 rounded-2xl border border-coral/40 bg-opal-100 px-3 py-2 text-xs text-slate-200">
        <span aria-hidden className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-coral motion-safe:animate-pulse" />
        <div className="min-w-0 flex-1">
          <span className="font-semibold text-slate-100">{catchingUp ? 'Preparing the mission…' : 'Working on it…'}</span>
          {slow && <span> This is taking longer than usual.</span>}
        </div>
        {slow && (
          <button type="button" onClick={() => onStoryAction('retry')} className="md-compact shrink-0 border border-opal-300 bg-opal-50 text-slate-200">
            Retry
          </button>
        )}
      </div>
    )
  }
  if (model.status !== 'ready') {
    const tone = model.status === 'error' ? 'border-red-300/60 bg-red-950 text-red-200' : 'border-amber-300/60 bg-amber-950 text-amber-200'
    const action = model.primary.action
    const showAction = action === 'retry' || action === 'restart' || action === 'view'
    return (
      <div role={model.status === 'error' ? 'alert' : 'status'} className={`rounded-2xl border px-3 py-2 text-xs leading-relaxed ${tone}`}>
        <p>{model.lead}</p>
        {showAction && (
          <button type="button" onClick={() => onStoryAction(action)} className="md-compact mt-2 border border-current bg-transparent">
            {model.primary.label}
          </button>
        )}
      </div>
    )
  }
  // A status change is shown as before -> after with the status words, never by colour alone. When rows exist they
  // carry the change; the facts would repeat them.
  const rows = model.rows.slice(0, 2).map((r) => ({
    label: r.name,
    value: `${r.before} (${STATUS_WORD[r.from] ?? r.from}) → ${r.after} (${STATUS_WORD[r.to] ?? r.to}), limit ${r.limit}`,
    tone: r.to,
  }))
  const facts = rows.length ? rows : model.facts.slice(0, 3).map((f) => ({ label: f.label, value: f.value, tone: f.tone ?? 'neutral' }))
  const lead = firstSentence(model.lead)
  if (!lead && !facts.length && !model.secondary.length) return null
  return (
    <div className="space-y-2">
      {(lead || facts.length > 0) && (
        <div aria-label="Live result" role="group" className="rounded-2xl border border-opal-300 bg-opal-100 px-3 py-2 text-xs">
          {lead && <p className="leading-relaxed text-slate-100">{lead}</p>}
          {facts.length > 0 && (
            <dl className={`space-y-1 ${lead ? 'mt-1.5 border-t border-opal-300 pt-1.5' : ''}`}>
              {facts.map((f, i) => (
                <div key={`${f.label}-${i}`} className="grid grid-cols-[minmax(0,8.5rem)_1fr] gap-2">
                  <dt className="break-words text-slate-400">{f.label || ' '}</dt>
                  <dd className={`break-words tabular-nums ${FACT_TONE[f.tone] ?? FACT_TONE.neutral}`}>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {model.secondary.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {model.secondary.map((x) => (
            <button key={x.label} type="button" onClick={() => onStoryAction(x.action)} className="md-compact border border-opal-300 bg-opal-100 text-slate-200">
              {x.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function TutorialSpotlightView({
  step,
  stepIndex,
  total,
  actionDone,
  box,
  cardPos,
  cardRef,
  headRef,
  maskId = 'tutorial-mask',
  story = null,
  onPrev,
  onNext,
  onSkip,
  onGoToStep,
  onGoToAct,
  onStoryAction = () => {},
}: {
  step: (typeof TUTORIAL_STEPS)[number]
  stepIndex: number
  total: number
  actionDone: boolean
  box: { x: number; y: number; w: number; h: number } | null
  cardPos: { left: number; top: number }
  cardRef?: React.RefObject<HTMLDivElement | null>
  headRef?: React.RefObject<HTMLHeadingElement | null>
  maskId?: string
  story?: StoryCardModel | null
  onPrev: () => void
  onNext: () => void
  onSkip: () => void
  onGoToStep: (idx: number) => void
  onGoToAct: (act: TourAct) => void
  onStoryAction?: (a: StoryAction) => void
}) {
  const progressPct = Math.round(((stepIndex + 1) / total) * 100)
  const isLast = stepIndex === total - 1
  const blocked = !!story && (story.catchingUp || story.model.status === 'working')
  const actSteps = TUTORIAL_STEPS.map((s, idx) => ({ s, idx })).filter(({ s }) => s.act === step.act)
  const actTitle = TOUR_ACTS.find((a) => a.act === step.act)?.title ?? ''
  const showPrompt = !story || (!blocked && story.model.status === 'ready')
  const scrim = step.scrim !== false

  return (
    <div className="pointer-events-none fixed inset-0 z-[90]" role="region" aria-label="Guided tour">
      {/* Translucent scrim with a clickable hole so users interact directly with the live controls */}
      {scrim && (
        <svg className="pointer-events-none fixed inset-0 h-full w-full" aria-hidden>
          <defs>
            <mask id={maskId}>
              <rect width="100%" height="100%" fill="white" />
              {box && <rect className="md-tour-hole" x={box.x} y={box.y} width={box.w} height={box.h} rx={16} ry={16} fill="black" />}
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgba(10, 12, 16, 0.44)" mask={`url(#${maskId})`} />
        </svg>
      )}

      {box && (
        <div
          aria-hidden
          className="md-tour-ring pointer-events-none fixed left-0 top-0 rounded-[16px] border-2 border-coral"
          style={{ transform: `translate3d(${box.x}px, ${box.y}px, 0)`, width: box.w, height: box.h }}
        />
      )}

      {/* Persistent M3 coachmark: the outer wrapper glides via GPU transform; the inner card plays its entrance once */}
      <div
        className="md-tour-card pointer-events-auto fixed left-0 top-0 z-[91]"
        style={{ transform: `translate3d(${cardPos.left}px, ${cardPos.top}px, 0)` }}
      >
        <div
          ref={cardRef}
          role="dialog"
          aria-modal="false"
          aria-label={`Guided tour, step ${stepIndex + 1} of ${total}: ${step.title}`}
          data-testid="tutorial-coachmark"
          data-step={step.id}
          className="lp-light md-dialog-in flex max-h-[calc(100vh-32px)] w-[min(388px,calc(100vw-32px))] flex-col overflow-hidden rounded-[24px] border border-opal-300 bg-opal-50 text-slate-100 shadow-2xl shadow-black/45"
          style={{ fontFamily: 'var(--font-inter)' }}
        >
          {/* Top coral gradient progress strip (whole tour) */}
          <div className="h-1.5 w-full shrink-0 bg-opal-300/60" aria-hidden>
            <div className="h-full transition-[width] duration-300 ease-[var(--md-ease-emph-decel)]" style={{ width: `${progressPct}%` }}>
              <InteractiveGrainGradient className="h-full w-full" />
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
            {/* Acts: where you are, and a one-click jump to any act */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Tour acts">
                {TOUR_ACTS.map((a) => {
                  const current = a.act === step.act
                  return (
                    <button
                      key={a.act}
                      type="button"
                      aria-current={current ? 'true' : undefined}
                      aria-label={`Act ${a.act}: ${a.title}`}
                      onClick={() => {
                        if (!current) onGoToAct(a.act)
                      }}
                      className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold tracking-wide transition-colors ${
                        current ? 'bg-coral/15 text-sky-200' : 'border border-opal-300 bg-opal-100 text-slate-300 hover:text-slate-100'
                      }`}
                    >
                      <span className="tabular-nums">{a.act}</span>
                      {a.label}
                    </button>
                  )
                })}
              </div>
              <button
                type="button"
                data-no-sfx
                onClick={() => {
                  playUiTap()
                  onSkip()
                }}
                aria-label="Skip guided tour"
                className="inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-xs font-medium text-slate-400 transition-colors hover:bg-opal-100 hover:text-slate-100"
              >
                Skip (Esc)
              </button>
            </div>

            <div key={step.id} className="md-tour-content-in">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-semibold tabular-nums text-sky-200">{`${stepIndex + 1} / ${total}`}</span>
                <span className="text-slate-400">{actTitle}</span>
                <span className="inline-flex h-5 items-center rounded-full border border-opal-300 bg-opal-100 px-2 font-medium text-slate-300">
                  {step.badge}
                </span>
              </div>
              <h2 ref={headRef} tabIndex={-1} className="mt-1.5 font-display text-base font-bold leading-snug tracking-tight text-slate-100 outline-none">{step.title}</h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-300">{step.whyItMatters}</p>
            </div>

            <p className="sr-only" aria-live="polite">
              {`Step ${stepIndex + 1} of ${total}: ${step.title}.${story && !blocked && story.model.status === 'ready' ? ' Live result ready.' : ''}`}
            </p>

            {story && <StoryBlock story={story} onStoryAction={onStoryAction} />}

            {/* Try-it / look-for pill */}
            {showPrompt && (
              <div
                className={`flex items-start gap-2.5 rounded-2xl border px-3 py-2 text-xs transition-colors duration-200 ${
                  actionDone ? 'border-emerald-300/60 bg-emerald-950 text-emerald-300' : 'border-coral/40 bg-opal-100 text-slate-200'
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${
                    actionDone ? 'bg-emerald-300' : step.promptKind === 'try' ? 'bg-coral motion-safe:animate-pulse' : 'bg-coral'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-slate-100">
                    {actionDone
                      ? isLast
                        ? 'Great! Click Finish when you are ready.'
                        : 'Nice! Moving on…'
                      : step.promptKind === 'try'
                        ? 'Try it live: '
                        : 'Look for: '}
                  </span>
                  {!actionDone && <span>{step.tryPrompt}</span>}
                </div>
              </div>
            )}

            {/* Steps of this act + Back / Next */}
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="-mx-1 flex items-center" role="group" aria-label={`Steps in act ${step.act}`}>
                {actSteps.map(({ s, idx }) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-current={idx === stepIndex ? 'step' : undefined}
                    aria-label={`Jump to step ${idx + 1}: ${s.title}`}
                    onClick={() => onGoToStep(idx)}
                    className="group grid h-6 min-w-4 place-items-center rounded-full px-1"
                  >
                    <span
                      aria-hidden
                      className={`block h-2 rounded-full transition-all duration-200 ${
                        idx === stepIndex ? 'w-5 bg-coral' : idx < stepIndex ? 'w-2 bg-coral/45 group-hover:bg-coral/70' : 'w-2 bg-opal-300 group-hover:bg-slate-400'
                      }`}
                    />
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={stepIndex === 0}
                  onClick={onPrev}
                  className="md-compact border border-opal-300 bg-opal-100 text-slate-200 disabled:pointer-events-none disabled:opacity-40"
                >
                  Back
                </button>
                <button
                  type="button"
                  aria-disabled={blocked || undefined}
                  onClick={() => {
                    if (!blocked) onNext()
                  }}
                  data-testid="tutorial-next"
                  className="md-compact bg-coral font-semibold text-slate-950 shadow-sm aria-disabled:cursor-wait aria-disabled:opacity-60"
                >
                  {blocked ? 'Working…' : step.nextLabel ?? (isLast ? 'Finish' : 'Next')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
