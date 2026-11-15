// The one thing at the very bottom of Plan Comparison: a button into the methodology subpage. Everything it
// explains (including the data notes for the current plans) lives on that page.
import { btn } from '../ui'
import { METHODOLOGY_INTRO_ID, openMethodology } from './methodology'

export function MethodologyButton() {
  return (
    <div id={METHODOLOGY_INTRO_ID} className="mt-10 flex scroll-mt-24 justify-center">
      <button type="button" className={btn} onClick={openMethodology}>
        Explore Methodology <span aria-hidden="true">→</span>
      </button>
    </div>
  )
}
