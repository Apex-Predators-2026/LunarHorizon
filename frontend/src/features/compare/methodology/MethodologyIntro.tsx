import { btnPrimary } from '../ui'
import { METHODOLOGY_INTRO_ID, openMethodology } from './methodology'

export function MethodologyButton() {
  return (
    <div id={METHODOLOGY_INTRO_ID}
      className="mt-10 flex scroll-mt-24 flex-wrap items-center justify-between gap-4 border border-line bg-surface bg-linear-to-r from-transparent from-55% to-coral/15 px-5 py-5 sm:px-7">
      <span className="text-base font-semibold text-ink sm:text-lg">See the thought behind the analysis</span>
      <button type="button" className={`${btnPrimary} ml-auto shrink-0`} onClick={openMethodology}>
        Explore methodology <span aria-hidden="true">→</span>
      </button>
    </div>
  )
}
