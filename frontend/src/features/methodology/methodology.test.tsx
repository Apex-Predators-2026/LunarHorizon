// Validation & Methodology: every number shown comes from the stored report's summary (a real
// /api/validation response captured in __fixtures__), and the view is reachable at #app/method.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { parseRoute, routeHash } from '../../appRoute'
import summary from './__fixtures__/validation-summary.json'
import { siteName, type ValidationSummary } from './api'
import { Checks, LrocChart, MethodologyView } from './MethodologyView'

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

describe('methodology page', () => {
  it('has the three layers, a reproducible mission and the sources', () => {
    const html = renderToString(<MethodologyView />)
    for (const t of ['Where an answer comes from', 'How it was checked', 'What it can and cannot establish', 'A mission you can reproduce', 'Sources'])
      expect(html).toContain(t)
    expect(html).toContain('not a physical certainty')
    expect(html).toContain('https://ssd.jpl.nasa.gov/horizons/')
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
