import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TUTORIAL_STEPS } from './steps'
import { TutorialOfferChip } from './TutorialOfferChip'
import { TutorialSpotlight, TutorialSpotlightView } from './TutorialSpotlight'
import { computeCoachmarkPosition, handleTutorialKeyDown } from './utils'
import {
  TUTORIAL_STORAGE_KEY,
  initTutorialFromSearch,
  resetTutorialStoreForTests,
  useTutorialStore,
} from './useTutorialStore'

function makeMemoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
  }
}

describe('Guided Mission Briefing Tutorial', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTutorialStoreForTests(makeMemoryStorage())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('defines 8 interactive stops covering all core mission planner workflows', () => {
    expect(TUTORIAL_STEPS).toHaveLength(8)
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual([
      'site-selection',
      'camera-views',
      'solar-timeline',
      'sky-obstructions',
      'traverse-measure',
      'jpl-verify',
      'viability-rescue',
      'plans-compare',
    ])
    for (const step of TUTORIAL_STEPS) {
      expect(step.title.length).toBeGreaterThan(3)
      expect(step.whyItMatters.length).toBeGreaterThan(10)
      expect(step.tryPrompt.length).toBeGreaterThan(5)
      expect(step.triggers.length).toBeGreaterThan(0)
    }
  })

  it('progresses steps forward, backward, and skips/completes properly', () => {
    const store = useTutorialStore.getState()
    expect(store.open).toBe(false)

    store.startTour()
    expect(useTutorialStore.getState().open).toBe(true)
    expect(useTutorialStore.getState().stepIndex).toBe(0)

    store.prevStep()
    expect(useTutorialStore.getState().stepIndex).toBe(0)

    store.nextStep()
    expect(useTutorialStore.getState().stepIndex).toBe(1)

    store.goToStep(7)
    expect(useTutorialStore.getState().stepIndex).toBe(7)

    store.nextStep()
    expect(useTutorialStore.getState().open).toBe(false)
    expect(useTutorialStore.getState().completed).toBe(true)

    useTutorialStore.getState().startTour(2)
    expect(useTutorialStore.getState().stepIndex).toBe(2)
    useTutorialStore.getState().skipTour()
    expect(useTutorialStore.getState().open).toBe(false)
  })

  it('persists dontShowAgain and completion in localStorage', () => {
    const storage = makeMemoryStorage()
    resetTutorialStoreForTests(storage)

    useTutorialStore.getState().dismissOffer(true)
    expect(useTutorialStore.getState().dontShowAgain).toBe(true)
    expect(useTutorialStore.getState().offerDismissed).toBe(true)

    const saved = JSON.parse(storage.getItem(TUTORIAL_STORAGE_KEY) ?? '{}')
    expect(saved.dontShowAgain).toBe(true)

    resetTutorialStoreForTests(storage)
    expect(useTutorialStore.getState().dontShowAgain).toBe(true)
  })

  it('launches immediately when ?tour=1 query param is present even if dontShowAgain was set', () => {
    const storage = makeMemoryStorage()
    storage.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify({ dontShowAgain: true, completed: true }))
    resetTutorialStoreForTests(storage)

    const launched = initTutorialFromSearch('?foo=bar&tour=1')
    expect(launched).toBe(true)
    expect(useTutorialStore.getState().open).toBe(true)
    expect(useTutorialStore.getState().stepIndex).toBe(0)

    resetTutorialStoreForTests(storage)
    const launchedFromHash = initTutorialFromSearch('', '#app?tour=1')
    expect(launchedFromHash).toBe(true)
    expect(useTutorialStore.getState().open).toBe(true)
  })

  it('auto-advances when the user interacts with the active step control', () => {
    useTutorialStore.getState().startTour(0)
    const step0 = TUTORIAL_STEPS[0]

    useTutorialStore.getState().recordInteraction(step0.triggers[0])
    expect(useTutorialStore.getState().actionDone).toBe(true)
    expect(useTutorialStore.getState().stepIndex).toBe(0)

    vi.advanceTimersByTime(1000)
    expect(useTutorialStore.getState().stepIndex).toBe(1)
    expect(useTutorialStore.getState().actionDone).toBe(false)
  })

  it('handles keyboard shortcuts Escape, ArrowRight, and ArrowLeft', () => {
    useTutorialStore.getState().startTour(1)

    expect(handleTutorialKeyDown({ key: 'ArrowRight' })).toBe(true)
    expect(useTutorialStore.getState().stepIndex).toBe(2)

    expect(handleTutorialKeyDown({ key: 'ArrowLeft' })).toBe(true)
    expect(useTutorialStore.getState().stepIndex).toBe(1)

    expect(handleTutorialKeyDown({ key: 'Escape' })).toBe(true)
    expect(useTutorialStore.getState().open).toBe(false)

    // Ignored when closed
    expect(handleTutorialKeyDown({ key: 'ArrowRight' })).toBe(false)
  })

  it('clamps coachmark card position inside the viewport and falls back safely when target rect is null', () => {
    const fallback = computeCoachmarkPosition(null, { width: 1366, height: 768 }, { width: 380, height: 280 })
    expect(fallback.mode).toBe('centered')
    expect(fallback.left).toBeGreaterThanOrEqual(16)
    expect(fallback.top).toBeGreaterThanOrEqual(16)
    expect(fallback.left + 380).toBeLessThanOrEqual(1366 - 16)
    expect(fallback.top + 280).toBeLessThanOrEqual(768 - 16)

    // Near bottom-right corner target
    const anchored = computeCoachmarkPosition(
      { left: 1200, top: 680, right: 1350, bottom: 750, width: 150, height: 70 },
      { width: 1366, height: 768 },
      { width: 380, height: 280 },
    )
    expect(anchored.mode).toBe('anchored')
    expect(anchored.left).toBeGreaterThanOrEqual(16)
    expect(anchored.top).toBeGreaterThanOrEqual(16)
    expect(anchored.left + 380).toBeLessThanOrEqual(1366 - 16)
    expect(anchored.top + 280).toBeLessThanOrEqual(768 - 16)
  })

  it('renders M3 offer chip and active spotlight coachmark markup cleanly and hides when uiHidden', () => {
    const chipHtml = renderToString(<TutorialOfferChip uiHidden={false} compareActive={false} />)
    expect(chipHtml).toContain('Guided Tour')
    expect(chipHtml).toContain('lp-light')

    expect(renderToString(<TutorialOfferChip uiHidden={true} compareActive={false} />)).toBe('')

    const spotHtml = renderToString(
      <TutorialSpotlightView
        step={TUTORIAL_STEPS[0]}
        stepIndex={0}
        total={TUTORIAL_STEPS.length}
        actionDone={false}
        box={{ x: 20, y: 20, w: 120, h: 48 }}
        cardPos={{ left: 100, top: 100 }}
        appView="planner"
        onPrev={() => {}}
        onNext={() => {}}
        onSkip={() => {}}
        onGoToStep={() => {}}
      />,
    )
    expect(spotHtml).toContain('1 / 8')
    expect(spotHtml).toContain('Mission &amp; Site Selection')
    expect(spotHtml).toContain(TUTORIAL_STEPS[0].whyItMatters)
    expect(spotHtml).toContain('lp-light')

    expect(renderToString(<TutorialSpotlight uiHidden={true} />)).toBe('')
  })
})
