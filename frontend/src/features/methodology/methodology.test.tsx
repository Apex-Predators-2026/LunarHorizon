// Validation & Methodology: every number shown comes from the stored report's summary (a real
// /api/validation response captured in __fixtures__), and the view is reachable at #app/method.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { parseRoute, routeHash } from '../../appRoute'
import summary from './__fixtures__/validation-summary.json'
import viability from './__fixtures__/viability-validation-summary.json'
import { reportVerdict, siteName, type ValidationSummary, type ViabilityValidationState, type ViabilityValidationSummary } from './api'
import { Checks, LrocChart, MethodologyView } from './MethodologyView'
import { ViabilityChecks } from './ViabilityChecks'

const s = summary as unknown as ValidationSummary

describe('validation checks', () => {
  it('shows the ephemeris and horizon numbers from the report, not typed-in ones', () => {
    const html = renderToString(<Checks s={s} />)
    expect(html).toContain('0.00072°')
    expect(html).toContain(s.ephemeris_agreement!.verdict_checks.toLocaleString('en-US'))
    expect(html).toContain(siteName(s.horizon_method!.max_difference_deg.site))
    expect(html).toContain('WAC_POLE_ILL_TWI_SOUTH_100M')
  })

  it('draws one row per LROC-comparable site with model, pixel and neighbourhood', () => {
    const html = renderToString(<LrocChart data={s.illumination_observed!} />)
    const sites = Object.keys(s.illumination_observed!.site_pixel)
    for (const id of sites) expect(html).toContain(siteName(id))
    expect(html.match(/<title>/g)).toHaveLength(sites.length)
    expect(html).toContain('the site’s own 100 m pixel')
  })

  it('says n/a for a correlation that cannot exist (always dark), instead of failing', () => {
    const html = renderToString(<Checks s={s} />)
    expect(html).toContain('n/a (dark in both)')
  })

  it('leaves out a check the report does not contain', () => {
    const html = renderToString(<Checks s={{ run: s.run }} />)
    expect(html).not.toContain('independent ephemeris')
  })
})

// The viability engine's report: a real /api/viability/validation-summary response (24 site files, 11 cases).
const v = viability as unknown as ViabilityValidationSummary
const html = (state: ViabilityValidationState) => renderToString(<ViabilityChecks state={state} />).replace(/<!-- -->/g, '')

describe('viability-engine verification (software, not scientific validation)', () => {
  it('shows the report’s own totals, scope, invariants, versions, data currency and limitations', () => {
    expect(reportVerdict(v)).toBe('current_pass')
    const h = html({ status: 'loaded', summary: v })
    expect(h).toContain(`All ${v.totals.checks.toLocaleString('en-US')} recorded checks passed`)
    for (const c of v.cases) expect(h).toContain(c.category)
    for (const i of v.invariants) expect(h).toContain(i.name)
    expect(h).toContain(`${v.datasets.length} site files recorded with SHA-256`)
    expect(h).toContain(`engine ${v.versions.engine}`)
    expect(h).toContain(v.limitations[0])
    expect(h).toContain('synthetic fixture') // the one synthetic case is labelled as such
  })

  it('calls a passing report that no longer matches the code or data out of date, not current', () => {
    const stale: ViabilityValidationSummary = {
      ...v,
      currency: { ...v.currency, current: false, changed_datasets: ['malapert-massif'], note: 'A site file changed since the report.' },
    }
    expect(reportVerdict(stale)).toBe('stale_pass')
    const h = html({ status: 'loaded', summary: stale })
    expect(h).toContain('Out of date')
    expect(h).toContain('Site files changed since: malapert-massif')
    expect(h).toContain('python -m app.viability.validation') // the regenerate command (HTML-escaped as a whole)
    expect(h).not.toContain('recorded checks passed (')
  })

  it('reports recorded failures as failures', () => {
    const failed: ViabilityValidationSummary = {
      ...v,
      status: 'failed',
      totals: { ...v.totals, failed: 2 },
      cases: v.cases.map((c, i) => (i === 0 ? { ...c, passed: false, failed_checks: ['eligibility is pass'] } : c)),
    }
    expect(reportVerdict(failed)).toBe('failed')
    const h = html({ status: 'loaded', summary: failed })
    expect(h).toContain(`2 of ${v.totals.checks.toLocaleString('en-US')} checks failed`)
    expect(h).toContain('failed: eligibility is pass')
    expect(h).not.toContain('recorded checks passed')
  })

  it('never shows a result for a missing or unreachable report', () => {
    for (const state of [
      { status: 'missing', detail: 'Run: cd backend && python -m app.viability.validation' },
      { status: 'unavailable', detail: 'The backend could not be reached.' },
      { status: 'loading' },
    ] as ViabilityValidationState[]) {
      const h = html(state)
      expect(h).not.toMatch(/passed|Held:/)
    }
    expect(html({ status: 'missing', detail: 'Run: x' })).toContain('No viability-engine validation report has been generated')
  })
})

describe('methodology page', () => {
  it('opens on a credibility overview with the limitations visible, and offers three views', () => {
    const html = renderToString(<MethodologyView />).replace(/<!-- -->/g, '')
    expect(html).toContain('What was checked')
    for (const t of ['Scientific validation', 'Engine verification', 'Methods &amp; sources']) expect(html).toContain(t)
    expect(html).toContain('Material limitations')
    expect(html).toContain('not a physical certainty') // the limitations are on the first screen, not only in a tab
    expect(html).toContain('Independent scientific validation')
    // The overview never claims a result before a report has loaded.
    expect(html).toContain('Loading the stored report')
    expect(html).not.toContain('recorded checks passed')
  })

  it('marks the active view and keeps the others closed, with the tab semantics', () => {
    const html = renderToString(<MethodologyView />)
    expect(html.match(/role="tab"/g)).toHaveLength(3)
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"/)
    expect(html.match(/aria-selected="false"/g)).toHaveLength(2)
    expect(html).toMatch(/id="meth-panel-engine"[^>]*hidden/)
    expect(html).toMatch(/id="meth-panel-science"(?![^>]*hidden)/)
  })

  it('keeps the engine verification distinct from the scientific validation', () => {
    const html = renderToString(<MethodologyView initialTab="engine" />)
    expect(html).toContain('Software verification, not scientific validation')
    expect(html).toContain('Loading the stored viability-engine report')
  })

  it('has the pipeline, the limits, a reproducible mission and the sources in Methods & sources', () => {
    const html = renderToString(<MethodologyView initialTab="methods" />)
    for (const t of ['Where an answer comes from', 'What it can and cannot establish', 'A mission you can reproduce', 'Sources'])
      expect(html).toContain(t)
    expect(html).toContain('not a physical certainty')
    expect(html).toContain('https://ssd.jpl.nasa.gov/horizons/')
    // Collapsed blocks are still in the page (hidden), so nothing is lost: the reproducible mission is one.
    expect(html).toMatch(/id="meth-repro-body"[^>]*hidden/)
    expect(html).toContain('test_rescue_real_data.py')
  })

  it('is reachable at #app/method', () => {
    expect(parseRoute('#app/method')).toEqual({ page: 'app', view: 'method', section: null })
    expect(routeHash('method')).toBe('#app/method')
  })

  it('names sites readably', () => {
    expect(siteName('peak-near-shackleton')).toBe('Peak Near Shackleton')
    expect(siteName('im-1-odysseus')).toBe('IM 1 Odysseus')
  })
})
