// The way back from the 3D evidence view: each origin returns to the screen that asked for it. The per-plan
// assessment dialog supplies its own return (it reopens), so "Back" never lands on a different plan's panel.
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clearEvidence, showEvidence, useEvidence, type ActiveEvidence } from '../../viz/evidence'
import { AssessmentPanel } from './AssessmentPanel'
import { returnFromEvidence } from './evidenceReturn'
import { useAssessmentStore } from './useAssessmentStore'
import fail from './__fixtures__/assess-fail.json'
import type { AssessmentState } from '../../lib/assessment'

const ASK = { siteId: 'connecting-ridge', startUtc: '2027-03-10T00:30:00Z', endUtc: '2027-03-10T20:00:00Z', body: 'earth' as const }
const pending = () => useEvidence.getState().request as ActiveEvidence

beforeEach(() => {
  clearEvidence()
  useEvidence.setState({ request: null, highlight: null, problem: null })
  useAssessmentStore.setState({ results: {} })
})

describe('returnFromEvidence', () => {
  it('a dialog origin runs its own return and clears the evidence (it does not fall back to the running plan panel)', () => {
    const reopen = vi.fn()
    expect(showEvidence({ ...ASK, origin: { kind: 'assessment', label: 'Plan X assessment', returnTo: reopen } }).ok).toBe(true)
    useEvidence.setState({ highlight: pending() })
    returnFromEvidence(useEvidence.getState().highlight)
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(useEvidence.getState().highlight).toBeNull()
  })

  it('without a return of its own it keeps the old behaviour (leave the evidence view, no callback needed, no DOM required)', () => {
    showEvidence({ ...ASK, origin: { kind: 'assessment', label: 'Mission assessment' } })
    useEvidence.setState({ highlight: pending() })
    expect(() => returnFromEvidence(useEvidence.getState().highlight)).not.toThrow()
    expect(useEvidence.getState().highlight).toBeNull()
  })

  it('a Comparison origin still goes back to the comparison and never calls a dialog return', () => {
    const reopen = vi.fn()
    const hash = { value: '' }
    vi.stubGlobal('window', { location: { set hash(v: string) { hash.value = v }, get hash() { return hash.value } } })
    try {
      showEvidence({ ...ASK, origin: { kind: 'comparison', label: 'Scenario B', section: 'cmp-performance', returnTo: reopen } })
      returnFromEvidence(pending())
      expect(hash.value).toMatch(/compare\/cmp-performance/)
      expect(reopen).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// Clicking the control (origin passed through, dialog reopened by Back) is exercised in a real browser:
// frontend/scripts/smoke-prod.mjs, step "Plan assessment dialog: Show in 3D, then Back returns to the same dialog".
describe('the plan dialog panel', () => {
  it('offers Show in 3D on the evidence windows of a failing requirement', () => {
    const state = { status: 'done', response: fail } as unknown as AssessmentState
    const html = renderToString(<AssessmentPanel state={state} origin={{ kind: 'assessment', label: 'Plan X assessment', returnTo: () => {} }} />)
    expect(html).toContain('Show in 3D')
  })
})
