// "Generate Mission Report" in the page header: the report is one click away without scrolling to the decision.
// Generation itself is the summary report's (report.ts): a frozen snapshot of the evaluated selection. When it
// cannot be generated yet, the reason is shown next to the button (not only as a hover tooltip).
import { useId } from 'react'

import { LastReportButton } from './ReportPreview'
import { cannotGenerate, useReportStore } from './report'
import { Icon } from './ui'
import { useCompareStore } from './useCompareStore'

export function ReportHeaderAction() {
  const blocker = useCompareStore((s) => cannotGenerate(s))
  const generate = useReportStore((s) => s.generate)
  const hintId = useId()
  return (
    <span className="flex flex-wrap items-center gap-2" data-tour="compare-report">
      <button type="button" className="cmp-btn-primary" disabled={!!blocker} onClick={() => generate()}
        aria-describedby={blocker ? hintId : undefined} data-testid="header-generate-report"
        data-tip={blocker ? undefined : 'Freeze the current comparison into a Mission Report you can preview and download'}>
        <Icon name="report" size={16} /> Generate Mission Report
      </button>
      <LastReportButton />
      {blocker && <span id={hintId} className="max-w-[16rem] text-[11px] leading-snug text-ink-3">{blocker}</span>}
    </span>
  )
}
