// Mission Rescue frontend tests. Fixtures in __fixtures__ are real responses captured
// from the backend (see docs/rescue.md for how to regenerate them).
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '../../store'
import catalog from './__fixtures__/catalog-response.json'
import compromiseRes from './__fixtures__/compromise-response.json'
import noneRes from './__fixtures__/rescue-none-response.json'
import outsideRes from './__fixtures__/rescue-outside-data-response.json'
import sensUnknownRes from './__fixtures__/sensitivity-unknown-response.json'
import rescueRes from './__fixtures__/rescue-response.json'
import sensitivityRes from './__fixtures__/sensitivity-response.json'
import { ApiError, errorMessage, runRescue } from './api'
import { AlternativeCard, DataBadge } from './AlternativeCard'
import { CompromiseResults } from './CompromisePanel'
import { fmtDelta, fmtShift, fmtUtc, fmtValue, fromUtcInput, toUtcInput } from './format'
import { RescueResults } from './RescuePanel'
import { SensitivityView } from './SensitivityView'
import type { CompromiseResponse, RescueResponse, SensitivityResponse } from './types'
import { useRescueStore } from './useRescueStore'

const rescue = rescueRes as unknown as RescueResponse
const none = noneRes as unknown as RescueResponse
const sensitivity = sensitivityRes as unknown as SensitivityResponse
const outside = outsideRes as unknown as RescueResponse
const sensUnknown = sensUnknownRes as unknown as SensitivityResponse
const compromise = compromiseRes as unknown as CompromiseResponse

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const resetStores = () => {
  useRescueStore.setState({ original: null, change: { launch_delay_days: 0, requirement_overrides: {} } })
  useRescueStore.getState().reset()
  useAppStore.setState({ siteId: null, timeUtc: '2026-01-01T00:00:00.000Z' })
}



beforeEach(resetStores)
afterEach(() => vi.unstubAllGlobals())

describe('format helpers', () => {
  it('formats values, deltas and shifts', () => {
    expect(fmtValue(0.514, 'fraction')).toBe('51%')
    expect(fmtValue(82.4, 'h')).toBe('82 h')
    expect(fmtValue(null, 'h')).toBe('n/a')
    expect(fmtDelta({ delta: -82, unit: 'h' })).toBe('−82 h')
    expect(fmtDelta({ delta: 0.49, unit: 'fraction' })).toBe('+49 pts')
    expect(fmtDelta({ delta: 0, unit: 'h' })).toBe('no change')
    expect(fmtShift(132)).toBe('5.5 days later')
    expect(fmtShift(-12)).toBe('12 h earlier')
    expect(fmtShift(0.2)).toBe('same time')
    expect(fmtUtc('2027-01-07T00:00:00Z')).toBe('2027-01-07 00:00 UTC')
  })

  it('round-trips datetime-local values as UTC', () => {
    expect(toUtcInput('2027-01-07T05:30:00Z')).toBe('2027-01-07T05:30')
    expect(fromUtcInput('2027-01-07T05:30')).toBe('2027-01-07T05:30:00.000Z')
  })
})

describe('api', () => {
  it('posts to the rescue endpoint through the dev proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rescue))
    vi.stubGlobal('fetch', fetchMock)
    const res = await runRescue({ original: rescue.original.scenario })
    expect(res.status).toBe('rescued')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/rescue')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body).original.site.id).toBe('peak-near-shackleton')
  })

  it('turns FastAPI errors into readable messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: "Unknown site id 'x'" }, 422)))
    const err = await runRescue({ original: rescue.original.scenario }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(errorMessage(err)).toBe("422: Unknown site id 'x'")
    const validation = new ApiError(422, [{ loc: ['body', 'original', 'site'], msg: 'Field required' }])
    expect(errorMessage(validation)).toBe('422: original.site Field required')
  })
})

describe('rescue store', () => {
  it('finds alternatives, selects the best one and syncs the shared app store', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(rescue)))
    useRescueStore.getState().setOriginal(rescue.original.scenario)
    await useRescueStore.getState().findAlternatives()
    const s = useRescueStore.getState()
    expect(s.rescueStatus).toBe('done')
    expect(s.selected).toBe(s.rescue!.alternatives[0].scenario)
    expect(useAppStore.getState().timeUtc).toBe(rescue.alternatives[0].scenario.landing_utc)
    expect(useAppStore.getState().siteId).toBe(rescue.alternatives[0].scenario.site.id)
  })

  it('does not push custom points into the shared site id', () => {
    const custom = { ...rescue.original.scenario, site: { id: 'custom:-89.4,222.1', name: 'x', lat: -89.4, lon: 222.1 } }
    useAppStore.setState({ siteId: 'peak-near-shackleton' })
    useRescueStore.getState().select(custom)
    expect(useAppStore.getState().siteId).toBe('peak-near-shackleton')
    expect(useAppStore.getState().timeUtc).toBe(custom.landing_utc)
  })

  it('reports errors and refuses to search without a plan', async () => {
    await useRescueStore.getState().findAlternatives()
    expect(useRescueStore.getState().error).toMatch(/Pick a landing site/)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    useRescueStore.getState().setOriginal(rescue.original.scenario)
    await useRescueStore.getState().findAlternatives()
    expect(useRescueStore.getState().rescueStatus).toBe('error')
    expect(useRescueStore.getState().error).toBe('Failed to fetch')
  })

  it('clears old results when the plan changes', () => {
    useRescueStore.setState({ rescue, rescueStatus: 'done' })
    useRescueStore.getState().setOriginal(rescue.original.scenario)
    expect(useRescueStore.getState().rescue).toBeNull()
  })
})

describe('components render real backend responses', () => {
  it('RescuePanel shows status, alternatives, loosening and near misses', () => {
    const html = renderToString(
      <RescueResults res={rescue} selected={null} sensitivity={sensitivity} onSelect={() => {}} onCheckSensitivity={() => {}} />,
    )
    expect(html).toContain('Plan broke: alternatives found')
    expect(html).toContain('Recommended alternatives')
    expect(html).toContain(rescue.alternatives[0].scenario.site.name)
    expect(html).toContain('Or relax a requirement')
    expect(html).toContain('Real data: Sun/Earth positions from JPL Horizons')
    expect(html).toContain('synthetic-only candidates left out')
    expect(html).not.toContain('SYNTHETIC DATA')
    expect(html).toContain('Sensitivity of')
  })

  it('RescuePanel explains when nothing passes', () => {
    const html = renderToString(
      <RescueResults res={none} selected={null} sensitivity={null} onSelect={() => {}} onCheckSensitivity={() => {}} />,
    )
    expect(none.alternatives).toHaveLength(0)
    expect(html).toContain('No alternative passes')
    expect(html).toContain('Keep your plan:')
  })

  it('AlternativeCard shows the metric table and robustness', () => {
    const alt = rescue.alternatives[0]
    const html = renderToString(<AlternativeCard alt={alt} selected onSelect={() => {}} onCheckSensitivity={() => {}} />)
    expect(html).toContain('Selected')
    expect(html).toContain(alt.robustness!.verdict)
    expect(html).toContain('real data')
    for (const r of alt.reasons) expect(html).toContain(r.replace(/&/g, '&amp;').slice(0, 20))
  })

  it('a plan outside the real data is shown as unknown, never as a synthetic rescue', () => {
    expect(outside.changed.eligibility).toBe('unknown')
    expect(outside.changed.score).toBeNull()
    expect(outside.alternatives).toHaveLength(0)
    const html = renderToString(
      <RescueResults res={outside} selected={null} sensitivity={sensUnknown} onSelect={() => {}} onCheckSensitivity={() => {}} />,
    )
    expect(html).toContain('can&#x27;t be checked')
    expect(html).toContain('could not be checked (missing data)')
    expect(html).not.toContain('SYNTHETIC DATA')
    expect(html).toContain('unknown')
    expect(sensUnknown.points).toHaveLength(0)
  })

  it('DataBadge labels synthetic data', () => {
    expect(renderToString(<DataBadge source="synthetic-placeholder" />)).toContain('synthetic')
  })

  it('SensitivityView and CompromisePanel render', () => {
    const sens = renderToString(<SensitivityView data={sensitivity} />)
    expect(sens).toContain(sensitivity.verdict)
    expect(sensitivity.position_pass_rate).toBeNull()
    expect(sens).toContain('Not checked: no real terrain data')
    const html = renderToString(<CompromiseResults res={compromise} onSelect={() => {}} />)
    expect(html).toContain('Both teams can be satisfied')
    expect(html).toContain('Best for science')
  })

  it('catalog fixture has the sites the plan form offers', () => {
    expect(catalog.sites.map((s) => s.id)).toContain('peak-near-shackleton')
    expect(catalog.sites.filter((s) => s.has_real_data).map((s) => s.id).sort()).toEqual([
      'connecting-ridge',
      'malapert-massif',
      'peak-near-shackleton',
    ])
  })
})
