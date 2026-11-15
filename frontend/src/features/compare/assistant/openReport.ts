// The assistant's "Open the report" link. It only shows things: it reopens the last generated report, or, when there
// is none, brings the "Generate Mission Report" button into view and focuses it. It never generates a report itself.
import { useReportStore } from '../report'

export function openReport(): 'reopened' | 'pointed' | 'none' {
  if (useReportStore.getState().snapshot) {
    useReportStore.getState().reopen()
    return 'reopened'
  }
  if (typeof document === 'undefined') return 'none'
  const area = document.querySelector<HTMLElement>('[data-tour="compare-report"]')
  if (!area) return 'none'
  area.scrollIntoView({ block: 'center', behavior: 'auto' })
  area.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  return 'pointed'
}
