// The compact "How This Analysis Was Built" section at the very bottom of Scenario Comparison. It only
// introduces the methodology; the explanation itself lives on the subpage it opens.
import { btnPrimary } from '../ui'
import './methodology.css'
import { METHODOLOGY_INTRO_ID, openMethodology } from './methodology'

const FACTS = [
  'NASA JPL Horizons + LRO LOLA terrain',
  'Hour-by-hour, 720-direction horizons',
  'Pass / Fail / Unknown from proven bounds',
  'Ranked only against comparable plans',
]

export function MethodologyIntro() {
  return (
    <section id={METHODOLOGY_INTRO_ID} aria-labelledby={`${METHODOLOGY_INTRO_ID}-h`} className="cmp-method-intro scroll-mt-24">
      <div className="min-w-0 flex-[1_1_22rem]">
        <p className="cmp-kicker">Methodology</p>
        <h2 id={`${METHODOLOGY_INTRO_ID}-h`} className="mt-1 text-lg font-medium text-ink">How This Analysis Was Built</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-3">
          The data, models and rules behind every comparison above: how sunlight and Earth contact are computed from
          the terrain, how requirements are judged, and how plans are ranked.
        </p>
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="In short">
          {FACTS.map((f) => <li key={f} className="cmp-method-chip">{f}</li>)}
        </ul>
      </div>
      <button type="button" className={`${btnPrimary} shrink-0`} onClick={openMethodology}>
        Explore Methodology <span aria-hidden="true">→</span>
      </button>
    </section>
  )
}
