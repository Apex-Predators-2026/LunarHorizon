// Scenario Comparison tour: steps, navigation, skip / finish, persistence and replay.
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import { COMPARE_TOUR_STEPS, availableSteps } from './steps'
import { TourButton, TourOffer } from './TourButton'
import { COMPARE_TOUR_KEY, readTourPrefs, useCompareTour } from './useCompareTour'

beforeEach(() => useCompareTour.setState({ open: false, index: 0, completed: false, dismissed: false }))

describe('tour content', () => {
  it('has the five stops in order, each on a real page element', () => {
    expect(COMPARE_TOUR_STEPS.map((s) => s.id)).toEqual(['select', 'viability', 'conditions', 'tradeoffs', 'assistant'])
    expect(COMPARE_TOUR_STEPS[0].targets).toContain('#cmp-scenarios')
    expect(COMPARE_TOUR_STEPS[1].targets).toContain('[data-tour="compare-verdict"]')
    expect(COMPARE_TOUR_STEPS[2].targets).toContain('[data-tour="compare-headlines"]')
    expect(COMPARE_TOUR_STEPS[3].targets).toContain('#cmp-summary')
  })

  it('explains PASS / FAIL / UNKNOWN, and that eligibility and ranking are separate', () => {
    const text = COMPARE_TOUR_STEPS[1].body.join(' ')
    expect(text).toMatch(/PASS means/)
    expect(text).toMatch(/FAIL means/)
    expect(text).toMatch(/UNKNOWN means .* not a failure/)
    expect(text).toMatch(/Eligibility and ranking are separate/)
  })

  it('leaves out the assistant stop until the assistant is on the page', () => {
    const none = availableSteps(() => null)
    expect(none.map((s) => s.id)).toEqual(['select', 'viability', 'conditions', 'tradeoffs'])
    const all = availableSteps(() => ({}) as Element)
    expect(all).toHaveLength(5)
  })
})

describe('tour navigation', () => {
  it('Next, Back, and Finish on the last step', () => {
    const t = useCompareTour.getState()
    t.start()
    expect(useCompareTour.getState()).toMatchObject({ open: true, index: 0 })
    t.next(4)
    t.next(4)
    expect(useCompareTour.getState().index).toBe(2)
    t.back()
    expect(useCompareTour.getState().index).toBe(1)
    t.back()
    t.back() // never below the first step
    expect(useCompareTour.getState().index).toBe(0)
    t.next(4); t.next(4); t.next(4)
    expect(useCompareTour.getState().index).toBe(3)
    t.next(4) // Next on the last step finishes
    expect(useCompareTour.getState()).toMatchObject({ open: false, completed: true, dismissed: true })
  })

  it('Skip closes and stops the offer, and the tour can be replayed', () => {
    const t = useCompareTour.getState()
    t.start()
    t.next(5)
    t.skip()
    expect(useCompareTour.getState()).toMatchObject({ open: false, dismissed: true })
    t.start() // replay always starts from the first step
    expect(useCompareTour.getState()).toMatchObject({ open: true, index: 0 })
  })

  it('reads remembered completion and survives broken storage', () => {
    const store = (v: string | null) => ({ getItem: (k: string) => (k === COMPARE_TOUR_KEY ? v : null) })
    expect(readTourPrefs(store(JSON.stringify({ completed: true })))).toEqual({ completed: true, dismissed: false })
    expect(readTourPrefs(store('not json'))).toEqual({ completed: false, dismissed: false })
    expect(readTourPrefs(null)).toEqual({ completed: false, dismissed: false })
  })
})

describe('entry points', () => {
  it('always shows the "How to compare missions" button', () => {
    expect(renderToString(<TourButton />)).toContain('How to compare missions')
  })

  it('offers the tour once, until it is taken, skipped or dismissed', () => {
    expect(renderToString(<TourOffer />)).toContain('Take the tour')
  })
})
