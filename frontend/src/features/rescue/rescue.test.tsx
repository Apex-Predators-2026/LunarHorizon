// Mission Rescue frontend tests. Fixtures in __fixtures__ are real responses captured
// from the backend (see docs/rescue.md for how to regenerate them).
import { renderToString } from 'react-dom/server'
import { createJSONStorage } from 'zustand/middleware'
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
import { fmtDelta, fmtShift, fmtUtc, fmtValue, fromUtcInput, planInfo, toUtcInput } from './format'
import { usePlansStore } from '../plans/usePlansStore'
import { RescueResults, RescuingLine } from './RescuePanel'
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
    expect(useRescueStore.getState().rescueError).toMatch(/Pick a landing site/)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    useRescueStore.getState().setOriginal(rescue.original.scenario)
    await useRescueStore.getState().findAlternatives()
    expect(useRescueStore.getState().rescueStatus).toBe('error')
    expect(useRescueStore.getState().rescueError).toBe('Failed to fetch')
  })

  it('applies only the latest rescue request when an older one finishes last', async () => {
    const pending: ((r: Response) => void)[] = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))))
    useRescueStore.getState().setOriginal(rescue.original.scenario)
    const first = useRescueStore.getState().findAlternatives()
    const second = useRescueStore.getState().findAlternatives()
    pending[1](jsonResponse(none))
    await second
    pending[0](jsonResponse(rescue))
    await first
    const s = useRescueStore.getState()
    expect(s.rescue!.status).toBe('no_viable_alternative')
    expect(s.rescueStatus).toBe('done')
    expect(s.selected).toBeNull()
    expect(useAppStore.getState().siteId).toBeNull()
  })

  it('ignores an old request that fails after a newer one succeeded', async () => {
    const pending: [(r: Response) => void, (e: Error) => void][] = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve, reject) => pending.push([resolve, reject]))))
    useRescueStore.getState().setOriginal(rescue.original.scenario)
    const first = useRescueStore.getState().findAlternatives()
    const second = useRescueStore.getState().findAlternatives()
    pending[1][0](jsonResponse(rescue))
    await second
    pending[0][1](new TypeError('Failed to fetch'))
    await first
    const s = useRescueStore.getState()
    expect(s.rescueStatus).toBe('done')
    expect(s.rescueError).toBeNull()
    expect(s.rescue).not.toBeNull()
  })

  it('drops a response that arrives after the plan was replaced', async () => {
    let resolve!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolve = r })))
    useRescueStore.getState().setOriginal(rescue.original.scenario)
    const run = useRescueStore.getState().findAlternatives()
    useRescueStore.getState().setOriginal({ ...rescue.original.scenario, duration_days: 3 })
    resolve(jsonResponse(rescue))
    await run
    const s = useRescueStore.getState()
    expect(s.rescue).toBeNull()
    expect(s.rescueStatus).toBe('idle')
    expect(s.selected).toBeNull()
  })

  it('keeps each request kind error in its own tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: 'compromise broke' }, 500)))
    useRescueStore.getState().setOriginal(rescue.original.scenario)
    await useRescueStore.getState().findCompromise()
    let s = useRescueStore.getState()
    expect(s.compromiseError).toBe('500: compromise broke')
    expect(s.rescueError).toBeNull()
    expect(s.sensitivityError).toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: 'rescue broke' }, 500)))
    await useRescueStore.getState().findAlternatives()
    s = useRescueStore.getState()
    expect(s.rescueError).toBe('500: rescue broke')
    expect(s.compromiseError).toBe('500: compromise broke')
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
    expect(html).toContain(`${rescue.stats.synthetic_candidates_excluded} more options skipped: no real data there (simulation mode can estimate them)`)
    expect(html).not.toContain('synthetic-only')
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

  it('RescuingLine names the plan, site, landing date and length', () => {
    const sc = rescue.original.scenario
    const html = renderToString(<RescuingLine scenario={sc} name="Baseline" changed={false} />)
    expect(html).toContain(`Rescuing: Baseline, ${sc.site.name}, ${fmtUtc(sc.landing_utc)}, ${sc.duration_days} days`)
    expect(html).not.toContain('changed since')
    const noName = renderToString(<RescuingLine scenario={sc} name={null} changed={false} />)
    expect(noName).toContain(`Rescuing: ${sc.site.name}, ${fmtUtc(sc.landing_utc)}`)
    const stale = renderToString(<RescuingLine scenario={sc} name="Baseline" changed />)
    expect(stale).toContain('This plan changed since; press Run to update.')
  })

  it('names a plan only when the rescue scenario came from it, and flags edits', () => {
    const sc = rescue.original.scenario
    const fresh = { ...sc, duration_days: 5 }
    // Node has no working localStorage; give the persisted plans store an in-memory one.
    const mem = new Map<string, string>()
    usePlansStore.persist.setOptions({
      storage: createJSONStorage(() => ({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) })),
    })
    usePlansStore.setState({ plans: [{ id: 'p1', name: 'Baseline', scenario: sc }], activeId: 'p1', compareIds: [] })
    try {
      // Captured from the saved plan (Run passes the plan's own scenario).
      useRescueStore.getState().setOriginal(sc)
      expect(useRescueStore.getState().originalPlanId).toBe('p1')
      expect(planInfo(sc, 'p1', usePlansStore.getState().plans)).toEqual({ name: 'Baseline', changed: false })
      // A freshly built scenario (PlanForm, default seed) is not a plan, even with a plan active.
      useRescueStore.getState().setOriginal(fresh)
      expect(useRescueStore.getState().originalPlanId).toBeNull()
      expect(planInfo(fresh, null, usePlansStore.getState().plans)).toEqual({ name: null, changed: false })
      // Plan edited after capture: changed. Same content in another key order: not changed.
      useRescueStore.getState().setOriginal(sc)
      const edited = { ...sc, duration_days: 9 }
      usePlansStore.getState().update('p1', 'Baseline', edited)
      expect(planInfo(sc, 'p1', usePlansStore.getState().plans)).toEqual({ name: 'Baseline', changed: true })
      const reordered = Object.fromEntries(Object.entries(sc).reverse()) as typeof sc
      usePlansStore.getState().update('p1', 'Baseline', reordered)
      expect(planInfo(sc, 'p1', usePlansStore.getState().plans).changed).toBe(false)
      // Plan deleted: no name, no notice.
      expect(planInfo(sc, 'gone', usePlansStore.getState().plans)).toEqual({ name: null, changed: false })
    } finally {
      usePlansStore.setState({ plans: [], activeId: null, compareIds: [] })
    }
  })

  it('AlternativeCard shows an unchecked robustness as plain "Not checked"', () => {
    const base = rescue.alternatives[0]
    const alt = {
      ...base,
      robustness: {
        ...base.robustness!, verdict: 'unchecked' as const, pass_rate: null, passing_points: 0, checked_points: 0,
        note: 'Robustness not checked: no real data around this date or site.',
      },
    }
    const html = renderToString(<AlternativeCard alt={alt} selected={false} onSelect={() => {}} onCheckSensitivity={() => {}} />)
    expect(html).toContain('Not checked')
    expect(html).toContain('Robustness not checked: no real data around this date or site.')
    expect(html).not.toContain('0/0')
    expect(html).not.toContain('unchecked')
  })

  it('CompromiseResults credits the real data like the Rescue tab', () => {
    const html = renderToString(<CompromiseResults res={compromise} onSelect={() => {}} />)
    expect(html).toContain('Real data: Sun/Earth positions from JPL Horizons and terrain horizons from Moon Trek LOLA')
    expect(html).not.toContain('SYNTHETIC')
    const synth = { ...compromise, assumptions: ['SYNTHETIC DATA: placeholder values, not real.', ...compromise.assumptions.slice(1)] }
    expect(renderToString(<CompromiseResults res={synth} onSelect={() => {}} />)).toContain('SYNTHETIC DATA: placeholder values')
  })

  it('CompromiseResults does not repeat the best-for options in the trade-off list', () => {
    const named = (o: typeof compromise.best_for_engineering, id: string, name: string) => ({
      ...o!, scenario: { ...o!.scenario, site: { ...o!.scenario.site, id, name } },
    })
    const eng = named(compromise.best_for_engineering, 'eng', 'Engi Zeta')
    const sci = named(compromise.best_for_science, 'sci', 'Sci Omega')
    const mid = named(compromise.best_for_engineering, 'mid', 'Mid Kappa')
    const res = { ...compromise, summary: 'x', suggestions: [], best: null, best_for_engineering: eng, best_for_science: sci, pareto_front: [eng, mid, sci] }
    const html = renderToString(<CompromiseResults res={res} onSelect={() => {}} />)
    expect(html.split('Engi Zeta').length - 1).toBe(1)
    expect(html.split('Sci Omega').length - 1).toBe(1)
    expect(html.split('Mid Kappa').length - 1).toBe(1)
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
    const real = catalog.sites.filter((s) => s.has_real_data)
    expect(real.map((s) => s.id)).toEqual(
      expect.arrayContaining(['connecting-ridge', 'malapert-massif', 'peak-near-shackleton']),
    )
    // Every real-data site says which period its data covers; the plan form shows that range.
    for (const s of real) {
      expect(s.data_start_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      expect(s.data_end_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      expect(s.data_start_utc! < s.data_end_utc!).toBe(true)
    }
    for (const s of catalog.sites.filter((x) => !x.has_real_data)) {
      expect(s.data_start_utc).toBeNull()
    }
  })
})
