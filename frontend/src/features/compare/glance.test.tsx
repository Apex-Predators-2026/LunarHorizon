// UI redesign (Phase 2 of the assistant work): the "At a glance" verdict and headline comparison.
// Fixture: A Peak Near Shackleton FAIL · B Malapert PASS #1 · C Connecting Ridge PASS #2 · D no data · E separate group.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import fixture from './__fixtures__/compare-response.json'
import { type Entry } from './analysis'
import { AtAGlance } from './AtAGlance'
import { HEADLINES, headlineRows } from './glance'
import { MetricsTable } from './MetricsTable'
import { OverviewCards } from './OverviewCards'
import { makeScenario } from './scenario'
import type { CompareResponse, CompareResult } from './types'

const res = fixture as unknown as CompareResponse
const byKey = Object.fromEntries(res.results.map((r) => [r.key, r])) as Record<string, CompareResult>
const SITE = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }

function entry(key: string): Entry {
  const r = byKey[key]
  const scenario = { ...makeScenario({ site: SITE, landing_utc: '2027-01-15T00:00:00Z' }, []), label: key, id: `s-${key}` }
  return { scenario, state: { state: 'done', result: r }, result: r.status === 'ok' ? r : null, offsetHours: 0, ranking: r.ranking }
}
const plain = (html: string) => html.replace(/<!-- -->/g, '')
const H = Object.fromEntries(HEADLINES.map((h) => [h.key, h]))

describe('headline comparison', () => {
  it('marks the meaningfully best scenario in the right direction', () => {
    const rows = headlineRows(H.longest_power_darkness_h, ['A', 'B', 'C'].map(entry))
    const best = rows.filter((r) => r.best).map((r) => r.entry.scenario.label)
    const values = rows.map((r) => r.value!)
    expect(best).toHaveLength(1)
    // Lower is better for darkness: the best is the smallest value.
    expect(rows.find((r) => r.best)!.value).toBe(Math.min(...values))
  })

  it('gives no "best" when all values are equal', () => {
    const rows = headlineRows(H.earth_visible_percent, ['A', 'B', 'C'].map(entry))
    if (new Set(rows.map((r) => r.value)).size === 1) expect(rows.some((r) => r.best)).toBe(false)
  })

  it('a scenario without data has no value and no bar, never 0', () => {
    const rows = headlineRows(H.mean_solar_disk_fraction, ['B', 'D'].map(entry))
    const d = rows.find((r) => r.entry.scenario.label === 'D')!
    expect(d.value).toBeNull()
    expect(d.text).toBe('not assessed')
    expect(rows.some((r) => r.best)).toBe(false) // only one value: nothing to compare
  })

  it('carries the verdict of the requirement each figure is checked against', () => {
    const rows = headlineRows(H.mean_solar_disk_fraction, ['A', 'B'].map(entry))
    expect(rows.find((r) => r.entry.scenario.label === 'A')!.status).toBe('fail')
    expect(rows.find((r) => r.entry.scenario.label === 'B')!.status).toBe('pass')
  })
})

describe('At a glance panel', () => {
  it('leads with the decision and each scenario status', () => {
    const e = ['A', 'B', 'C'].map(entry)
    const html = plain(renderToString(<AtAGlance entries={e} groups={res.ranking_groups.filter((g) => g.id === 'G1')} pairs={res.pairwise} ready onJump={() => {}} />))
    expect(html).toContain('Verdict under the selected requirements')
    expect(html).toContain('Plan B is preferred under the selected requirements')
    expect(html).toContain('requirements met')
    expect(html).toContain('lower is better')
    expect(html).toContain('Read the reasoning')
  })

  it('says it is updating instead of showing a stale verdict', () => {
    const html = renderToString(<AtAGlance entries={['A', 'B'].map(entry)} groups={[]} pairs={[]} ready={false} onJump={() => {}} />)
    expect(html).toContain('Updating the canonical ranking')
  })

  it('cards show the spacecraft and the requirement limits that were evaluated', () => {
    const html = plain(renderToString(<OverviewCards entries={['B'].map(entry)} />))
    expect(html).toContain('Spacecraft')
    expect(html).toContain('Vertical, tracks Sun azimuth')
    expect(html).toContain('darkness ≤ 50 h')
  })

  it('the requirements section names the scenario that meets the most requirements', () => {
    const html = plain(renderToString(<MetricsTable entries={['A', 'B'].map(entry)} />))
    expect(html).toContain('Requirements met')
    expect(html).toMatch(/Meets more requirements than every other compared plan/)
  })
})
