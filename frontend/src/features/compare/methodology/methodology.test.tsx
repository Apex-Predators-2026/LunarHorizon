// Scenario Comparison methodology: the compact intro sits last on the comparison page, the subpage is a
// secondary route of the comparison (the main navigation is unchanged), and its figures use the engine's rules.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { COMPARE_METHODOLOGY, parseRoute, routeHash } from '../../../appRoute'
import { ComparisonDashboard } from '../ComparisonDashboard'
import { METRICS } from '../analysis'
import { ComparisonMethodology } from './ComparisonMethodology'
import { PipelineStepper, SunDiskExplorer, VerdictExplorer } from './MethodologyFigures'
import {
  curvatureDropM, decide, eligibility, horizonAngleDeg, METHODOLOGY_INTRO_ID, PIPELINE, SUN_RADIUS_DEG, visibleSunFraction,
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
  it('ends with the compact "How This Analysis Was Built" section', () => {
    const html = renderToString(<ComparisonDashboard />)
    const intro = html.indexOf('How This Analysis Was Built')
    expect(intro).toBeGreaterThan(-1)
    expect(html).toContain('Explore Methodology')
    // After every comparison block (here the empty state) and before nothing else of the page's content.
    expect(intro).toBeGreaterThan(html.indexOf('Select at least two plans'))
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

describe('subpage content', () => {
  const html = renderToString(<ComparisonMethodology />)

  it('covers models, data, calculations, assumptions, criteria and implementation', () => {
    for (const heading of ['Data sources', 'Models', 'Calculations', 'Evaluation criteria', 'Assumptions and limitations', 'Technical implementation'])
      expect(html).toContain(heading)
    for (const source of ['NASA JPL Horizons', 'LRO LOLA', 'LROC QuickMap', 'Gracy &amp; Lee'])
      expect(html).toContain(source)
  })

  it('lists every metric the comparison table shows, from the same definitions', () => {
    const solar = METRICS.filter((m) => m.group === 'solar')
    for (const m of solar) expect(html).toContain(m.label)
  })

  it('links to the main Validation & Methodology view without adding a navigation entry', () => {
    expect(html).toContain(`href="${routeHash('method')}"`)
  })

  it('has a back button at the top and at the end', () => {
    expect(html.match(/Back to Plan Comparison/g)?.length).toBe(2)
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
