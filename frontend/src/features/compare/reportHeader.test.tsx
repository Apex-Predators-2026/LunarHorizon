// "Generate Mission Report" in the page header: visible without scrolling, and when it cannot run yet it says why
// in text a screen reader also announces (not only a hover tooltip).
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { cannotGenerate } from './report'
import { ReportHeaderAction } from './ReportHeaderAction'
import { ReportButton } from './ReportPreview'
import { useCompareStore } from './useCompareStore'

describe('Generate Mission Report action', () => {
  it('is in the header with the reason it is unavailable, linked to the button', () => {
    const html = renderToString(<ReportHeaderAction />)
    expect(html).toContain('Generate Mission Report')
    expect(html).toContain('data-tour="compare-report"')
    const blocker = cannotGenerate(useCompareStore.getInitialState())
    expect(blocker).not.toBeNull() // fresh page: nothing assessed yet, so a report cannot be generated
    expect(html).toContain('disabled=""')
    expect(html).toContain(blocker!)
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1]
    expect(describedBy).toBeTruthy()
    expect(html).toContain(`id="${describedBy}"`)
  })

  it('uses the same name in the decision area', () => {
    expect(renderToString(<ReportButton />)).toContain('Generate Mission Report')
  })
})
