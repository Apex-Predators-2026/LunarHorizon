// Plan Comparison methodology: a single button sits last on the comparison page, the subpage is a secondary
// route of the comparison built from its own pieces (the main navigation is unchanged), and its figures use the
// engine's rules.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { COMPARE_METHODOLOGY, parseRoute, routeHash } from '../../../appRoute'
import { ComparisonDashboard } from '../ComparisonDashboard'
import { METRICS } from '../analysis'
import { ComparisonMethodology, LimitsTab } from './ComparisonMethodology'
import { PipelineStepper, SunDiskExplorer, VerdictExplorer } from './MethodologyFigures'
import {
  curvatureDropM, decide, eligibility, horizonAngleDeg, METHODOLOGY_INTRO_ID, METHODOLOGY_TABS, PIPELINE, SUN_RADIUS_DEG,
  visibleSunFraction, type MethodologyTab,
} from './methodology'

describe('methodology route', () => {
  it('is a subpage of Scenario Comparison, not a main view', () => {
    expect(parseRoute('#app/compare/methodology')).toEqual({ page: 'app', view: 'compare', section: COMPARE_METHODOLOGY })
    expect(routeHash('compare', COMPARE_METHODOLOGY)).toBe('#app/compare/methodology')
    // Other unknown segments are still ignored, and the intro is an ordinary comparison section.
    expect(parseRoute('#app/compare/other')).toEqual({ page: 'app', view: 'compare', section: null })
    expect(parseRoute(`#app/compare/${METHODOLOGY_INTRO_ID}`)).toEqual({ page: 'app', view: 'compare', section: METHODOLOGY_INTRO_ID })
  })
})

describe('comparison page', () => {
  it('ends with a single Explore Methodology button and no other methodology content', () => {
    const html = renderToString(<ComparisonDashboard />)
    const start = html.indexOf(`id="${METHODOLOGY_INTRO_ID}"`)
    expect(start).toBeGreaterThan(html.indexOf('Select at least two plans')) // after every comparison block
    const bottom = html.slice(start, html.indexOf('</div>', start) + 6)
    expect(bottom).toContain('Explore Methodology')
    expect(bottom.match(/<button/g)).toHaveLength(1)
    expect(bottom).not.toMatch(/<(p|h2|h3|ul|li|section)[\s>]/)
    expect(html).not.toContain('How This Analysis Was Built')
    expect(html).not.toContain('Data sources and assumptions')
    expect(html).not.toContain('Back to Plan Comparison')
  })

  it('shows the subpage instead of the comparison on #app/compare/methodology', () => {
    const html = renderToString(<ComparisonDashboard section={COMPARE_METHODOLOGY} />)
    expect(html).toContain('Back to Plan Comparison')
    expect(html).toContain('data-testid="comparison-methodology"')
    expect(html).not.toContain('Comparison views') // the comparison's own tabs are not on the subpage
    expect(html).not.toContain('Explore Methodology')
  })
})

describe('subpage layout', () => {
  const html = renderToString(<ComparisonMethodology />)

  it('uses the comparison’s header, glass view bar and Section cards', () => {
    expect(html).toContain('How This Analysis Was Built')
    expect(html).toContain('aria-label="Methodology views"')
    for (const t of METHODOLOGY_TABS) expect(html).toContain(`>${t.label.replace('&', '&amp;')}</button>`)
    expect(html).toContain('cmp-section')
    expect(html).not.toMatch(/cmp-method-(hero|part|toc|intro|chip)|cmp-kicker/)
  })

  it('has a back button in the header and at the end, and leads on to the next view', () => {
    expect(html.match(/Back to Plan Comparison/g)?.length).toBe(2)
    expect(html.replace(/<!-- -->/g, '')).toContain(`Next: ${METHODOLOGY_TABS[1].label.replace('&', '&amp;')}`)
    const last = renderToString(<ComparisonMethodology initialTab="limits" />)
    expect(last).not.toContain('Next:')
  })
})

describe('subpage content', () => {
  const view = (tab: MethodologyTab) => renderToString(<ComparisonMethodology initialTab={tab} />)
  const all = METHODOLOGY_TABS.map((t) => view(t.id)).join('')

  it('covers models, data, calculations, assumptions, criteria and implementation', () => {
    for (const heading of ['Data sources', 'Models', 'Calculations', 'Evaluation criteria', 'Assumptions and limitations', 'Technical implementation'])
      expect(all).toContain(heading)
    for (const source of ['NASA JPL Horizons', 'LRO LOLA', 'LROC QuickMap', 'Gracy &amp; Lee'])
      expect(all).toContain(source)
  })

  it('names Gracy & Lee as the site coordinates source, not a validation of this model', () => {
    expect(all).toContain('Site coordinates source')
    expect(all).not.toContain('Published benchmark')
    expect(all).toMatch(/not a validation of this model/)
  })

  it('lists every metric the comparison table shows, from the same definitions', () => {
    const solar = METRICS.filter((m) => m.group === 'solar')
    for (const m of solar) expect(view('models')).toContain(m.label)
  })

  it('links to the main Validation & Methodology view without adding a navigation entry', () => {
    expect(view('overview')).toContain(`href="${routeHash('method')}"`)
  })

  it('shows the data notes of the current comparison, which used to sit at the bottom of the comparison', () => {
    const html = renderToString(<LimitsTab notes={['Earth visibility is geometric line of sight only.']} />)
    expect(html).toContain('For the plans you are comparing')
    expect(html).toContain('Earth visibility is geometric line of sight only.')
    expect(renderToString(<LimitsTab notes={[]} />)).not.toContain('For the plans you are comparing')
  })
})

describe('engine rules used by the figures', () => {
  it('curvature: d²/2R with R = 1737.4 km', () => {
    expect(curvatureDropM(100)).toBeCloseTo(2877.86, 1)
    // A 1 km ridge 100 km away looks raised on a flat map but sits below the horizon on the real Moon.
    expect(horizonAngleDeg(1000, 100, false)).toBeCloseTo(0.573, 2)
    expect(horizonAngleDeg(1000, 100, true)).toBeLessThan(0)
  })

  it('solar disk: half visible at the horizon, none below, all above', () => {
    expect(visibleSunFraction(0)).toBeCloseTo(0.5, 12)
    expect(visibleSunFraction(SUN_RADIUS_DEG)).toBe(1)
    expect(visibleSunFraction(-SUN_RADIUS_DEG)).toBe(0)
    expect(visibleSunFraction(0.1)).toBeGreaterThan(0.5)
  })

  it('verdicts: proven from bounds, Unknown when the range straddles the limit', () => {
    expect(decide('at_least', 41, 50, 40)).toBe('PASS')
    expect(decide('at_least', 40, 40, 40)).toBe('PASS') // equality meets the requirement
    expect(decide('at_least', 30, 39, 40)).toBe('FAIL')
    expect(decide('at_least', 33, 52, 40)).toBe('UNKNOWN')
    expect(decide('at_most', 30, 50, 50)).toBe('PASS')
    expect(decide('at_most', 51, 60, 50)).toBe('FAIL')
    expect(decide('at_most', 45, 55, 50)).toBe('UNKNOWN')
    expect(eligibility(['PASS', 'UNKNOWN', 'FAIL'])).toBe('FAIL')
    expect(eligibility(['PASS', 'UNKNOWN'])).toBe('UNKNOWN')
    expect(eligibility(['PASS', 'PASS'])).toBe('PASS')
  })

  it('figures render with their initial state explained', () => {
    expect(renderToString(<VerdictExplorer />)).toContain('cannot decide')
    expect(renderToString(<SunDiskExplorer />)).toContain('power-lit')
    const steps = renderToString(<PipelineStepper />)
    for (const s of PIPELINE) expect(steps).toContain(s.title.replace('&', '&amp;'))
  })
})
