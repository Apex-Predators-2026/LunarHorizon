// The way back from the 3D evidence view ("Show why") to where it was asked for: the Comparison section, the
// per-plan assessment dialog (origin.returnTo reopens it), or the Mission assessment panel (rows are marked there).
import { goToView, routeHash } from '../../appRoute'
import { clearEvidence, type ActiveEvidence } from '../../viz/evidence'
import { useAssessmentStore } from './useAssessmentStore'

export const ASSESSMENT_ID = 'mission-assessment'

/** Leave the evidence view and go back to where "Show why" was pressed. */
export function returnFromEvidence(h: Pick<ActiveEvidence, 'origin'> | null) {
  const kind = h?.origin?.kind
  if (kind === 'comparison') {
    clearEvidence()
    const section = h?.origin?.section
    if (section && typeof window !== 'undefined') window.location.hash = routeHash('compare', section)
    else goToView('compare')
    return
  }
  useAssessmentStore.getState().clearShowing()
  clearEvidence()
  // A screen that supplied its own way back (the per-plan assessment dialog) is restored as it was.
  const back = h?.origin?.returnTo
  if (back) {
    back()
    return
  }
  if ((kind === 'assessment' || kind === undefined) && typeof document !== 'undefined') {
    const el = document.getElementById(ASSESSMENT_ID)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el?.focus({ preventScroll: true })
  }
}
