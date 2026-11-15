// The Mission Report inside the preview: section navigation with the current page, the report document, and the
// detailed technical record (the summary report's own document) as an appendix. Plus the one-click PDF button.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ReportSnapshot } from './report'
import { buildReportCard, type ReportCard } from './reportCard'
import { ReportCardDocument } from './ReportCardDocument'
import { PAGE_COUNT, SECTIONS } from './reportLayout'
import { downloadReportPdf } from './reportPdf'
import { ReportDocument } from './ReportPreview'

/** Built once per snapshot: the card never changes for an open report. */
const useReportCard = (snapshot: ReportSnapshot) => useMemo(() => buildReportCard(snapshot), [snapshot])

export function PdfButton({ card, className = 'report-btn report-btn-primary' }: { card: ReportCard; className?: string }) {
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle')
  const run = async () => {
    setState('working')
    try {
      await downloadReportPdf(card)
      setState('idle')
    } catch {
      setState('error')
    }
  }
  return (
    <>
      <button type="button" className={className} onClick={() => void run()} disabled={state === 'working'} aria-busy={state === 'working'}
        data-testid="download-report-pdf">
        {state === 'working' ? 'Preparing PDF…' : 'Download PDF'}
      </button>
      {state === 'error' && <span role="alert" className="report-pdf-error">The PDF could not be created. Try again, or use Print.</span>}
    </>
  )
}

/** The PDF button for an open snapshot (builds its own card, so it can sit in the toolbar). */
export function SnapshotPdfButton({ snapshot }: { snapshot: ReportSnapshot }) {
  return <PdfButton card={useReportCard(snapshot)} />
}

export function MissionReportBody({ snapshot, scrollRef }: { snapshot: ReportSnapshot; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const card = useReportCard(snapshot)
  const [page, setPage] = useState(1)
  const docRef = useRef<HTMLDivElement>(null)

  // The page in view: the last page whose top has passed the top third of the scroll area.
  const measure = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const top = scroller.getBoundingClientRect().top + scroller.clientHeight / 3
    let current = 1
    docRef.current?.querySelectorAll<HTMLElement>('.rc-page').forEach((p) => {
      if (p.getBoundingClientRect().top <= top) current = Number(p.dataset.page)
    })
    setPage(current)
  }, [scrollRef])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', measure, { passive: true })
    return () => scroller.removeEventListener('scroll', measure)
  }, [scrollRef, measure])

  const go = (id: string) => {
    const el = document.getElementById(id)
    const scroller = scrollRef.current
    if (!el || !scroller) return
    // Instant jump (like the tour): nothing animates for users who prefer reduced motion.
    scroller.scrollTo({ top: scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 56, behavior: 'auto' })
    measure() // update the page at once, without waiting for the scroll event
  }

  return (
    <>
      <nav className="report-sections" aria-label="Report sections">
        <span className="report-page" aria-live="polite">Page {Math.min(page, PAGE_COUNT)} of {PAGE_COUNT}</span>
        {SECTIONS.filter((s) => s.id !== 'rc-disclaimer').map((s, i) => (
          <button key={s.id} type="button" className="report-section-link" onClick={() => go(s.id)}>
            <span aria-hidden="true">{i + 1}</span> {s.title}
          </button>
        ))}
        <button type="button" className="report-section-link" onClick={() => go('rpt-appendix')}>Appendix</button>
      </nav>
      <div ref={docRef}>
        <ReportCardDocument card={card} />
        <details className="report-appendix" id="rpt-appendix">
          <summary>Appendix: technical record (ranking evidence, pairwise comparisons, reproduction details)</summary>
          <p className="report-appendix-note">The engineering record behind this report, from the same snapshot. It is part of the preview and of the JSON download; the PDF contains the report pages above.</p>
          <ReportDocument s={snapshot} />
        </details>
      </div>
    </>
  )
}
