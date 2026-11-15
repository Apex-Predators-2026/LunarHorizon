// One-click PDF download of the Mission Report. The PDF library and the PDF layout are loaded only here, on the
// first click, so they never weigh on the comparison page.
import { createElement } from 'react'

import type { ReportCard } from './reportCard'
import { reportFileName } from './reportLayout'

/** Render the report card to a PDF blob (the library is imported on demand). */
export async function renderReportPdf(card: ReportCard): Promise<Blob> {
  const [{ pdf }, { ReportCardPdf }] = await Promise.all([import('@react-pdf/renderer'), import('./ReportCardPdf')])
  // ReportCardPdf returns a <Document>, which is what pdf() expects.
  return pdf(createElement(ReportCardPdf, { card }) as Parameters<typeof pdf>[0]).toBlob()
}

/** Build the PDF and save it through the browser's normal download. */
export async function downloadReportPdf(card: ReportCard): Promise<void> {
  const blob = await renderReportPdf(card)
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = reportFileName(card)
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}
