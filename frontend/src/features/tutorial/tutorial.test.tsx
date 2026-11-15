import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StageModel } from '../guide/mission'
import { TOUR_ACTS, TOUR_PATHS, TUTORIAL_STEPS, actStart, pathSteps } from './steps'
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

  const idAt = () => TUTORIAL_STEPS[useTutorialStore.getState().stepIndex].id
  const indexOf = (id: string) => TUTORIAL_STEPS.findIndex((s) => s.id === id)

  it('defines 19 steps in 3 acts covering all four views, and two paths', () => {
    expect(TUTORIAL_STEPS).toHaveLength(19)
    expect(TUTORIAL_STEPS.map((s) => s.act)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3])
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual([
      'mission', 'terrain', 'timeline', 'countdown', 'sky', 'jpl', 'original', 'delay', 'evidence', 'rescue',
      'compare', 'headroom', 'sync', 'tradeoffs', 'science', 'report',
      'atlas', 'method', 'your-turn',
    ])
    expect(TOUR_PATHS.quick).toEqual(['mission', 'delay', 'evidence', 'rescue', 'compare', 'science', 'your-turn'])
    expect(TOUR_PATHS.full).toEqual(TUTORIAL_STEPS.map((s) => s.id))
    expect(pathSteps('quick').map((i) => TUTORIAL_STEPS[i].id)).toEqual(TOUR_PATHS.quick)
    expect(new Set(TUTORIAL_STEPS.map((s) => s.view))).toEqual(new Set(['planner', 'compare', 'atlas', 'method']))
    expect(TUTORIAL_STEPS.filter((s) => s.story).map((s) => s.story)).toEqual([
      'mission',
      'original',
      'changed',
      'evidence',
      'rescue',
      'compare',
      'report',
    ])
  })

  it('keeps every step concise', () => {
    for (const s of TUTORIAL_STEPS) {
      expect((s.whyItMatters.match(/[.!?](\s|$)/g) ?? []).length).toBeLessThanOrEqual(2)
      expect(s.whyItMatters.length).toBeLessThanOrEqual(240)
      expect(s.tryPrompt.length).toBeLessThanOrEqual(120)
      expect(s.promptKind === 'try' ? s.triggers.length > 0 : s.triggers.length === 0).toBe(true)
    }
  })

  it('goToAct jumps to the first step of each act', () => {
    useTutorialStore.getState().startTour(0)
    useTutorialStore.getState().goToAct(2)
    expect(idAt()).toBe('compare')
    useTutorialStore.getState().goToAct(3)
    expect(idAt()).toBe('atlas')
    expect(actStart(1)).toBe(0)
  })

  it('the quick tour moves only through its steps and finishes after Your turn', () => {
    useTutorialStore.getState().startTour(undefined, 'quick')
    expect(useTutorialStore.getState()).toMatchObject({ open: true, path: 'quick' })
    expect(idAt()).toBe('mission')
    useTutorialStore.getState().nextStep()
    expect(idAt()).toBe('delay')
    useTutorialStore.getState().prevStep()
    expect(idAt()).toBe('mission')
    useTutorialStore.getState().goToAct(2)
    expect(idAt()).toBe('compare')
    useTutorialStore.getState().nextStep()
    expect(idAt()).toBe('science')
    useTutorialStore.getState().goToAct(3)
    expect(idAt()).toBe('your-turn')
    useTutorialStore.getState().nextStep()
    expect(useTutorialStore.getState()).toMatchObject({ open: false, completed: true })
  })

  it('the full tour still visits every step, and the Comparison entry opens it at Act 2', () => {
    useTutorialStore.getState().startTour(0)
    expect(useTutorialStore.getState().path).toBe('full')
    useTutorialStore.getState().nextStep()
    expect(idAt()).toBe('terrain')
    useTutorialStore.getState().startTour(actStart(2), 'full')
    expect(idAt()).toBe('compare')
    useTutorialStore.getState().nextStep()
    expect(idAt()).toBe('headroom')
  })

  it('Your turn never auto-advances after a try action', () => {
    useTutorialStore.getState().startTour(undefined, 'quick')
    useTutorialStore.getState().goToAct(3)
    useTutorialStore.getState().recordInteraction('site-select')
    vi.advanceTimersByTime(2000)
    expect(useTutorialStore.getState()).toMatchObject({ open: true, actionDone: true })
    expect(idAt()).toBe('your-turn')
  })

  it('?tour=quick starts the quick path and ?tour=1 the full path', () => {
    expect(initTutorialFromSearch('?tour=quick')).toBe(true)
    expect(useTutorialStore.getState().path).toBe('quick')
    useTutorialStore.getState().skipTour()
    expect(initTutorialFromSearch('?tour=1')).toBe(true)
    expect(useTutorialStore.getState().path).toBe('full')
  })

  it('step copy claims only what the engine computes', () => {
    for (const s of TUTORIAL_STEPS) {
      const text = `${s.title} ${s.whyItMatters} ${s.tryPrompt}`
      expect(text).not.toMatch(/Gracy|direct link|nearby|WAC_POLE/i)
    }
    const method = TUTORIAL_STEPS[indexOf('method')].whyItMatters
    expect(method).toContain('DE421')
    expect(method).toContain('LROC')
    expect(TUTORIAL_STEPS[indexOf('countdown')].targetSelectors).toContain('[data-tour="hud-readout"]')
    expect(TUTORIAL_STEPS[indexOf('science')].reveal).toBe('cmp-science')
    expect(TUTORIAL_STEPS[indexOf('your-turn')]).toMatchObject({ view: 'planner', promptKind: 'try', nextLabel: 'Explore on my own' })
  })

  it('ArrowRight is ignored while next is blocked', () => {
    useTutorialStore.getState().startTour(0)
    useTutorialStore.getState().setNextBlocked(true)
    expect(handleTutorialKeyDown({ key: 'ArrowRight' })).toBe(false)
    expect(useTutorialStore.getState().stepIndex).toBe(0)
    useTutorialStore.getState().nextStep()
    expect(useTutorialStore.getState().nextBlocked).toBe(false)
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

    store.goToStep(18)
    expect(useTutorialStore.getState().stepIndex).toBe(18)

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
    // Step 0 is a story ('look') step; the first 'try' step is the terrain stop.
    useTutorialStore.getState().startTour(1)
    const step1 = TUTORIAL_STEPS[1]

    useTutorialStore.getState().recordInteraction(step1.triggers[0])
    expect(useTutorialStore.getState().actionDone).toBe(true)
    expect(useTutorialStore.getState().stepIndex).toBe(1)

    vi.advanceTimersByTime(1000)
    expect(useTutorialStore.getState().stepIndex).toBe(2)
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
    // Off the planner the offer sits in the corner with its Start button and no pointer to the toolbar.
    expect(chipHtml).toContain('Quick tour · 90 s')
    expect(chipHtml).toContain('Full tour')
    expect(chipHtml).not.toContain('More (⋮)')
    // In the planner it waits for the toolbar's More (⋮) button to point at, instead of flashing in a corner first.
    expect(renderToString(<TutorialOfferChip uiHidden={false} compareActive={false} anchorToMenu />)).toBe('')

    const spotHtml = renderToString(
      <TutorialSpotlightView
        step={TUTORIAL_STEPS[0]}
        stepIndex={0}
        total={TUTORIAL_STEPS.length}
        actionDone={false}
        box={{ x: 20, y: 20, w: 120, h: 48 }}
        cardPos={{ left: 100, top: 100 }}
        onPrev={() => {}}
        onNext={() => {}}
        onSkip={() => {}}
        onGoToStep={() => {}}
        onGoToAct={() => {}}
      />,
    )
    expect(spotHtml).toContain('1 / 19')
    expect(spotHtml).toContain('Your mission: Peak Near Shackleton')
    expect(spotHtml).toContain(TUTORIAL_STEPS[0].whyItMatters)
    expect(spotHtml).toContain('lp-light')

    expect(renderToString(<TutorialSpotlight uiHidden={true} />)).toBe('')
  })

  describe('one coachmark for the whole tour', () => {
    const noop = () => {}
    const base = {
      total: TUTORIAL_STEPS.length, actionDone: false, box: null, cardPos: { left: 0, top: 0 },
      onPrev: noop, onNext: noop, onSkip: noop, onGoToStep: noop, onGoToAct: noop, onStoryAction: noop,
    }
    const model = (over: Partial<StageModel>): StageModel => ({
      status: 'ready', lead: '', facts: [], rows: [], note: null, secondary: [], primary: { label: 'Next', action: 'next' }, ...over,
    })
    const nextButton = (html: string) => html.match(/<button[^>]*data-testid="tutorial-next"[^>]*>([^<]*)</)

    it('shows the three act tabs with the current act selected, and only this act’s step dots', () => {
      const html = renderToString(<TutorialSpotlightView {...base} stepIndex={actStart(2)} step={TUTORIAL_STEPS[actStart(2)]} story={null} />)
      for (const a of TOUR_ACTS) expect(html).toContain(`Act ${a.act}: ${a.title}`)
      expect(html).toMatch(/aria-current="true"[^>]*aria-label="Act 2: Make the decision"/)
      const actTwo = TUTORIAL_STEPS.filter((s) => s.act === 2).length
      expect((html.match(/aria-label="Jump to step /g) ?? []).length).toBe(actTwo)
    })

    it('renders live story facts on a ready story step, with the step’s own Next label', () => {
      const i = TUTORIAL_STEPS.findIndex((s) => s.id === 'original')
      const html = renderToString(
        <TutorialSpotlightView {...base} stepIndex={i} step={TUTORIAL_STEPS[i]}
          story={{ catchingUp: false, slow: false, model: model({ facts: [{ label: 'Verdict', value: 'PASS', tone: 'pass' }] }) }} />,
      )
      expect(html).toContain('Verdict')
      expect(html).toContain('PASS')
      expect(html).toContain('Look for: ')
      expect(nextButton(html)?.[1]).toBe('Apply a 4-day delay')
    })

    it('blocks Next while the story is preparing, and offers Retry when it is slow', () => {
      const html = renderToString(
        <TutorialSpotlightView {...base} stepIndex={0} step={TUTORIAL_STEPS[0]}
          story={{ catchingUp: true, slow: true, model: model({ status: 'working' }) }} />,
      )
      expect(html).toContain('Preparing the mission…')
      expect(html).toContain('Retry')
      expect(nextButton(html)?.[0]).toContain('aria-disabled="true"')
      expect(nextButton(html)?.[1]).toBe('Working…')
      expect(html).not.toContain('Look for: ') // the prompt waits for the live result
    })

    it('shows the engine’s own message and action when the example is outdated or inputs changed', () => {
      const html = renderToString(
        <TutorialSpotlightView {...base} stepIndex={5} step={TUTORIAL_STEPS[5]}
          story={{ catchingUp: false, slow: false, model: model({ status: 'modified', lead: 'The running plan was changed.', primary: { label: 'Restart the example', action: 'restart' } }) }} />,
      )
      expect(html).toContain('The running plan was changed.')
      expect(html).toContain('Restart the example')
      expect(nextButton(html)?.[0]).not.toContain('aria-disabled="true"') // never trapped
    })

    it('on the quick path shows progress within the path, a Quick tour label and only its steps', () => {
      const html = renderToString(<TutorialSpotlightView {...base} path="quick" stepIndex={0} step={TUTORIAL_STEPS[0]} story={null} />)
      expect(html).toContain('1 / 7')
      expect(html).toContain('Quick tour')
      expect((html.match(/aria-label="Jump to step /g) ?? []).length).toBe(4) // mission, delay, evidence, rescue
    })

    it('a step-specific Next label is used only when the path really goes to that next step', () => {
      const i = TUTORIAL_STEPS.findIndex((s) => s.id === 'science')
      const full = renderToString(<TutorialSpotlightView {...base} stepIndex={i} step={TUTORIAL_STEPS[i]} story={null} />)
      expect(nextButton(full)?.[1]).toBe('Generate the report')
      // On the quick path the step after Science vs engineering is Your turn, not the report.
      const quick = renderToString(<TutorialSpotlightView {...base} path="quick" stepIndex={i} step={TUTORIAL_STEPS[i]} story={null} />)
      expect(nextButton(quick)?.[1]).toBe('Next')
      const d = TUTORIAL_STEPS.findIndex((s) => s.id === 'delay')
      const quickDelay = renderToString(<TutorialSpotlightView {...base} path="quick" stepIndex={d} step={TUTORIAL_STEPS[d]} story={null} />)
      expect(nextButton(quickDelay)?.[1]).toBe('Show me why')
    })

    it('Your turn shows the live recap, offers the full tour on the quick path, and leaves with Explore on my own', () => {
      const i = TUTORIAL_STEPS.findIndex((s) => s.id === 'your-turn')
      const recap = [
        { label: 'Original plan', value: 'Peak Near Shackleton · PASS', tone: 'pass' as const },
        { label: 'After the delay', value: 'Peak Near Shackleton · FAIL', tone: 'fail' as const },
        { label: 'Recovery', value: 'Malapert Massif · PASS', tone: 'pass' as const },
      ]
      const quick = renderToString(<TutorialSpotlightView {...base} path="quick" stepIndex={i} step={TUTORIAL_STEPS[i]} recap={recap} onStartFull={() => {}} />)
      expect(quick).toContain('Malapert Massif · PASS')
      expect(quick).toContain('Take the full tour')
      expect(quick).toContain('7 / 7')
      expect(nextButton(quick)?.[1]).toBe('Explore on my own')
      const full = renderToString(<TutorialSpotlightView {...base} stepIndex={i} step={TUTORIAL_STEPS[i]} recap={recap} onStartFull={() => {}} />)
      expect(full).not.toContain('Take the full tour')
      expect(full).toContain('19 / 19')
    })

    it('uses "Look for" on observation steps, keeps the 3D view clear on the evidence step, and ends with Explore on my own', () => {
      const atlas = TUTORIAL_STEPS.findIndex((s) => s.id === 'atlas')
      expect(renderToString(<TutorialSpotlightView {...base} stepIndex={atlas} step={TUTORIAL_STEPS[atlas]} />)).toContain('Look for: ')
      const ev = TUTORIAL_STEPS.findIndex((s) => s.id === 'evidence')
      expect(renderToString(<TutorialSpotlightView {...base} stepIndex={ev} step={TUTORIAL_STEPS[ev]} />)).not.toContain('<mask')
      const last = TUTORIAL_STEPS.length - 1
      expect(nextButton(renderToString(<TutorialSpotlightView {...base} stepIndex={last} step={TUTORIAL_STEPS[last]} />))?.[1]).toBe('Explore on my own')
    })
  })
})
