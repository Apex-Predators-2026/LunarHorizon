import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { InteractiveGrainGradient } from '../../ui/InteractiveGrainGradient'
import { playUiTap } from '../../viz/sfx'
import { TUTORIAL_STEPS } from './steps'
import { useTutorialStore } from './useTutorialStore'
import { computeCoachmarkPosition, handleTutorialKeyDown, type RectBox } from './utils'

const SPOTLIGHT_PAD = 8

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

export function TutorialSpotlight({
  uiHidden,
  onOpenCompare,
  onResetTourView,
  appView,
}: {
  uiHidden: boolean
  onOpenCompare?: () => void
  onResetTourView?: () => void
  appView?: 'planner' | 'compare'
}) {
  const open = useTutorialStore((s) => s.open)
  const stepIndex = useTutorialStore((s) => s.stepIndex)
  const actionDone = useTutorialStore((s) => s.actionDone)
  const nextStep = useTutorialStore((s) => s.nextStep)
  const prevStep = useTutorialStore((s) => s.prevStep)
  const goToStep = useTutorialStore((s) => s.goToStep)
  const skipTour = useTutorialStore((s) => s.skipTour)
  const recordInteraction = useTutorialStore((s) => s.recordInteraction)

  const maskId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<{
    stepIndex: number
    targetRect: RectBox | null
    viewport: { width: number; height: number }
    cardSize: { width: number; height: number }
  }>(() => ({
    stepIndex: -1,
    targetRect: null,
    viewport: typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight } : { width: 1366, height: 768 },
    cardSize: { width: 384, height: 268 },
  }))

  const step = TUTORIAL_STEPS[stepIndex] ?? TUTORIAL_STEPS[0]
  const total = TUTORIAL_STEPS.length

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
      nextRect = {
        left,
        top,
        right,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      }
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
      return {
        stepIndex,
        targetRect: nextRect,
        viewport: nextViewport,
        cardSize: nextCs,
      }
    })
  }, [open, uiHidden, step, stepIndex])

  useEffect(() => {
    if (!open || uiHidden) return
    const targetEl = findTargetElement(step.targetSelectors)
    targetEl?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => measure())
        : null
    if (ro) {
      if (targetEl) ro.observe(targetEl)
      if (cardRef.current) ro.observe(cardRef.current)
      ro.observe(document.body)
    }

    const onViewportChange = () => measure()
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)

    // Measure on next animation frame after step/panel prep settles; one delayed pass catches async layout mounts.
    const raf = requestAnimationFrame(measure)
    const t1 = setTimeout(measure, 180)

    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
      cancelAnimationFrame(raf)
      clearTimeout(t1)
    }
  }, [open, uiHidden, stepIndex, appView, actionDone, measure, step.targetSelectors])

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
  const targetRect = layout.targetRect
  const box = targetRect
    ? {
        x: Math.max(4, Math.round(targetRect.left - SPOTLIGHT_PAD)),
        y: Math.max(4, Math.round(targetRect.top - SPOTLIGHT_PAD)),
        w: Math.max(24, Math.round(targetRect.width + SPOTLIGHT_PAD * 2)),
        h: Math.max(24, Math.round(targetRect.height + SPOTLIGHT_PAD * 2)),
      }
    : null

  const cardPos = computeCoachmarkPosition(targetRect, layout.viewport, layout.cardSize, settledStep.preferredPlacement)

  return (
    <TutorialSpotlightView
      step={step}
      stepIndex={stepIndex}
      total={total}
      actionDone={actionDone}
      box={box}
      cardPos={cardPos}
      appView={appView}
      cardRef={cardRef}
      maskId={maskId}
      onPrev={prevStep}
      onNext={nextStep}
      onSkip={skipTour}
      onGoToStep={goToStep}
      onOpenCompare={() => {
        recordInteraction('compare-open')
        onOpenCompare?.()
      }}
      onResetTourView={onResetTourView}
    />
  )
}

export function TutorialSpotlightView({
  step,
  stepIndex,
  total,
  actionDone,
  box,
  cardPos,
  appView,
  cardRef,
  maskId = 'tutorial-mask',
  onPrev,
  onNext,
  onSkip,
  onGoToStep,
  onOpenCompare,
  onResetTourView,
}: {
  step: (typeof TUTORIAL_STEPS)[number]
  stepIndex: number
  total: number
  actionDone: boolean
  box: { x: number; y: number; w: number; h: number } | null
  cardPos: { left: number; top: number }
  appView?: 'planner' | 'compare'
  cardRef?: React.RefObject<HTMLDivElement | null>
  maskId?: string
  onPrev: () => void
  onNext: () => void
  onSkip: () => void
  onGoToStep: (idx: number) => void
  onOpenCompare?: () => void
  onResetTourView?: () => void
}) {
  const progressPct = Math.round(((stepIndex + 1) / total) * 100)
  const isLast = stepIndex === total - 1

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[55]"
      role="region"
      aria-label="Guided mission briefing tutorial"
    >
      {/* Translucent scrim with clickable spotlight hole so users interact directly with live controls */}
      <svg className="pointer-events-none fixed inset-0 h-full w-full" aria-hidden>
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {box && <rect className="md-tour-hole" x={box.x} y={box.y} width={box.w} height={box.h} rx={16} ry={16} fill="black" />}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(10, 12, 16, 0.44)" mask={`url(#${maskId})`} />
      </svg>

      {box && (
        <div
          aria-hidden
          className="md-tour-ring pointer-events-none fixed left-0 top-0 rounded-[16px] border-2 border-coral"
          style={{
            transform: `translate3d(${box.x}px, ${box.y}px, 0)`,
            width: box.w,
            height: box.h,
          }}
        />
      )}

      {/* Persistent M3 Coachmark Card: outer wrapper glides via GPU transform; inner card plays entrance once */}
      <div
        className="md-tour-card pointer-events-auto fixed left-0 top-0 z-[56]"
        style={{ transform: `translate3d(${cardPos.left}px, ${cardPos.top}px, 0)` }}
      >
        <div
          ref={cardRef}
          role="dialog"
          aria-modal="false"
          aria-label={`Step ${stepIndex + 1} of ${total}: ${step.title}`}
          data-testid="tutorial-coachmark"
          className="lp-light md-dialog-in flex w-[min(388px,calc(100vw-32px))] flex-col overflow-hidden rounded-[24px] border border-opal-300 bg-opal-50 text-slate-100 shadow-2xl shadow-black/45"
          style={{ fontFamily: 'var(--font-inter)' }}
        >
        {/* Top coral gradient progress strip */}
        <div className="h-1.5 w-full bg-opal-300/60" aria-hidden>
          <div
            className="h-full transition-[width] duration-300 ease-[var(--md-ease-emph-decel)]"
            style={{ width: `${progressPct}%` }}
          >
            <InteractiveGrainGradient className="h-full w-full" />
          </div>
        </div>

        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-6 items-center rounded-full bg-coral/15 px-2.5 text-[11px] font-semibold tracking-wide text-coral tabular-nums">
                {`${stepIndex + 1} / ${total}`}
              </span>
              <span className="inline-flex h-6 items-center rounded-full border border-opal-300 bg-opal-100 px-2.5 text-[11px] font-medium text-slate-300">
                {step.badge}
              </span>
            </div>
            <button
              type="button"
              data-no-sfx
              onClick={() => {
                playUiTap()
                onSkip()
              }}
              aria-label="Skip guided tour"
              className="inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium text-slate-400 transition-colors hover:bg-opal-100 hover:text-slate-100"
            >
              Skip (Esc)
            </button>
          </div>

          <div key={step.id} className="md-tour-content-in">
            <h2 className="font-display text-base font-bold leading-snug tracking-tight text-slate-100">
              {step.title}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-300">{step.whyItMatters}</p>
          </div>

          {/* Interactive Try-It trigger pill */}
          <div
            className={`flex items-start gap-2.5 rounded-2xl border px-3 py-2 text-xs transition-colors duration-200 ${
              actionDone
                ? 'border-emerald-300/60 bg-emerald-950 text-emerald-300'
                : 'border-coral/40 bg-opal-100 text-slate-200'
            }`}
          >
            <span
              aria-hidden
              className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${
                actionDone ? 'bg-emerald-300' : 'animate-pulse bg-coral'
              }`}
            />
            <div className="min-w-0 flex-1">
              <span className="font-semibold text-slate-100">
                {actionDone
                  ? isLast
                    ? 'Great — click Finish when you are ready.'
                    : 'Nice! Advancing to next control…'
                  : 'Try it live: '}
              </span>
              {!actionDone && <span>{step.tryPrompt}</span>}
            </div>
          </div>

          {/* Step 8 convenience switch between 3D Planner & Scenario Comparison */}
          {isLast && appView === 'planner' && onOpenCompare && (
            <button
              type="button"
              onClick={onOpenCompare}
              className="md-compact w-full justify-center border border-coral/50 bg-coral/12 text-coral hover:bg-coral/20"
            >
              Open Scenario Comparison
            </button>
          )}
          {isLast && appView === 'compare' && onResetTourView && (
            <button
              type="button"
              onClick={onResetTourView}
              className="md-compact w-full justify-center border border-opal-300 bg-opal-100 text-slate-200"
            >
              Return to 3D Mission Planner
            </button>
          )}

          {/* Step dots + Back / Next controls */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-1" role="tablist" aria-label="Tour stops">
              {TUTORIAL_STEPS.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={idx === stepIndex}
                  aria-label={`Jump to step ${idx + 1}: ${s.title}`}
                  onClick={() => onGoToStep(idx)}
                  className={`h-2 rounded-full transition-all duration-200 ${
                    idx === stepIndex ? 'w-5 bg-coral' : idx < stepIndex ? 'w-2 bg-coral/45 hover:bg-coral/70' : 'w-2 bg-opal-300 hover:bg-slate-400'
                  }`}
                />
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
                onClick={onNext}
                className="md-compact bg-coral font-semibold text-slate-950 shadow-sm"
              >
                {isLast ? 'Finish' : 'Next'}
              </button>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
