// Entry point on the Scenario Comparison page: "How to compare missions" opens the site's guided tour at Act 2
// (making the decision), which walks through this page on the live mission story.
import { actStart } from '../../tutorial/steps'
import { useTutorialStore } from '../../tutorial/useTutorialStore'
import { Icon } from '../ui'

export function TourButton() {
  return (
    <button type="button" className="cmp-btn" onClick={() => useTutorialStore.getState().startTour(actStart(2))}
      data-tip="Start the guided tour at Act 2: it loads the example mission's three plans into this comparison and selects them">

      <Icon name="info" size={16} /> How to compare missions
    </button>
  )
}
