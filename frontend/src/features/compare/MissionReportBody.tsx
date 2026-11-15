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

/** The contents: every report section, then the appendix. */
const CONTENTS = [...SECTIONS.map((s) => ({ id: s.id, title: s.title })), { id: 'rpt-appendix', title: 'Appendix' }]

export function MissionReportBody({ snapshot, scrollRef }: { snapshot: ReportSnapshot; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const card = useReportCard(snapshot)
  const [page, setPage] = useState(1)
  const [active, setActive] = useState<string | null>(null)
  const docRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)

  // The page and section in view: the last ones whose top has passed the top third of the scroll area.
  const measure = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const top = scroller.getBoundingClientRect().top + scroller.clientHeight / 3
    let current = 1
    docRef.current?.querySelectorAll<HTMLElement>('.rc-page').forEach((p) => {
      if (p.getBoundingClientRect().top <= top) current = Number(p.dataset.page)
    })
    setPage(current)
    let section: string | null = null
    for (const c of CONTENTS) {
      const el = document.getElementById(c.id)
      if (el && el.getBoundingClientRect().top <= top) section = c.id
    }
    setActive(section)
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
    // Beside the report (wide screens) the contents take no room above it; as a bar across the top they do.
    const nav = navRef.current
    const offset = nav && getComputedStyle(nav).flexDirection !== 'column' ? nav.offsetHeight + 12 : 16
    // Instant jump (like the tour): nothing animates for users who prefer reduced motion.
    scroller.scrollTo({ top: scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset, behavior: 'auto' })
    measure() // update the page at once, without waiting for the scroll event
    setActive(id) // the section chosen, even near the end where the report cannot scroll it to the reading line
  }

  return (
    <div className="report-layout">
      {/* The contents: a sticky column beside the report on wide screens, a bar across the top on narrow ones. */}
      <nav ref={navRef} className="report-sections" aria-label="Report sections">
        <span className="report-page" aria-live="polite">Page {Math.min(page, PAGE_COUNT)} of {PAGE_COUNT}</span>
        <span className="report-toc-title" aria-hidden="true">Contents</span>
        <ol className="report-toc-list">
          {CONTENTS.map((c, i) => (
            <li key={c.id}>
              <button type="button" className="report-section-link" aria-current={active === c.id ? 'location' : undefined} onClick={() => go(c.id)}>
                {c.id !== 'rpt-appendix' && <span aria-hidden="true">{i + 1}</span>} {c.title}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div ref={docRef} className="report-main">
        <ReportCardDocument card={card} />
        <details className="report-appendix" id="rpt-appendix">
          <summary>Appendix: technical record (ranking evidence, pairwise comparisons, reproduction details)</summary>
          <p className="report-appendix-note">The engineering record behind this report, from the same snapshot. It is part of the preview and of the JSON download; the PDF contains the report pages above.</p>
          <ReportDocument s={snapshot} />
        </details>
      </div>
    </div>
  )
}
