// Entry points for the comparison tour: an always-available "How to compare missions" button, and a one-time,
// non-blocking offer shown until the user takes, skips or dismisses the tour.
import { Icon } from '../ui'
import { useCompareTour } from './useCompareTour'

export function TourButton() {
  const start = useCompareTour((s) => s.start)
  return (
    <button type="button" className="cmp-btn" onClick={start} data-tip="A 30-second guided tour of this page">
      <Icon name="info" size={16} /> How to compare missions
    </button>
  )
}

export function TourOffer() {
  const dismissed = useCompareTour((s) => s.dismissed)
  const completed = useCompareTour((s) => s.completed)
  const open = useCompareTour((s) => s.open)
  const { start, dismissOffer } = useCompareTour.getState()
  if (dismissed || completed || open) return null
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-2">
      <Icon name="info" size={16} className="text-ink-3" />
      <span>New here? A short guided tour shows how to compare mission plans (about 30 seconds).</span>
      <span className="ml-auto flex gap-2">
        <button type="button" className="cmp-btn-text" onClick={dismissOffer}>Not now</button>
        <button type="button" className="cmp-btn-primary" onClick={start}>Take the tour</button>
      </span>
    </div>
  )
}
