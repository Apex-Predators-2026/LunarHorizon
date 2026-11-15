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
import sensNeighboursRes from './__fixtures__/sensitivity-unknown-neighbours-response.json'
import rescueRes from './__fixtures__/rescue-response.json'
import sensitivityRes from './__fixtures__/sensitivity-response.json'
import { ApiError, errorMessage, runRescue } from './api'
import { AlternativeCard, DataBadge } from './AlternativeCard'
import { CompromiseResults } from './CompromisePanel'
import { evaluatedTimeNote, fmtDelta, fmtShift, fmtUtc, fmtValue, fromUtcInput, headroom, headroomSummary, planInfo, toUtcInput } from './format'
import { DEFAULT_REQUIREMENTS } from '../../types'
import { usePlansStore } from '../plans/usePlansStore'
import { RescueResults, RescuingLine, WhatChanged, whatChanged } from './RescuePanel'
import { buildWalkthrough, GLOSSARY } from './walkthrough'
import { RescueMapOverlay } from './RescueMapOverlay'
import { overlayMarkers, rescueMapMarkers, summaryText } from './rescueMapMarkers'
import { SensitivityView } from './SensitivityView'
import type { CompromiseResponse, RescueCatalog, RescueResponse, SensitivityResponse } from './types'
import { useRescueStore } from './useRescueStore'

const rescue = rescueRes as unknown as RescueResponse
const none = noneRes as unknown as RescueResponse
const sensitivity = sensitivityRes as unknown as SensitivityResponse
const outside = outsideRes as unknown as RescueResponse
const sensUnknown = sensUnknownRes as unknown as SensitivityResponse
const sensNeighbours = sensNeighboursRes as unknown as SensitivityResponse
const compromise = compromiseRes as unknown as CompromiseResponse

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const resetStores = () => {
  useRescueStore.setState({ original: null, change: { launch_delay_days: 0, requirement_overrides: {} } })
  useRescueStore.getState().reset()
  useAppStore.setState({ siteId: null, timeUtc: '2026-01-01T00:00:00.000Z' })
}



beforeEach(resetStores)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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
    // Every point is listed and none is decided: the slips are outside the data, the position checks unsupported.
    expect(sensUnknown.points.every((p) => p.status === 'unknown' || p.status === 'not_evaluated')).toBe(true)
    expect(sensUnknown.points.filter((p) => p.distance_km === 0).every((p) => p.reason === 'outside_coverage')).toBe(true)
    expect(sensUnknown.points.filter((p) => p.distance_km > 0).every((p) => p.reason === 'position_unsupported')).toBe(true)
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
    // Node has no working localStorage; give the persisted plans store an in-memory one when persist middleware attached.
    const mem = new Map<string, string>()
    usePlansStore.persist?.setOptions({
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

describe('rescueMapMarkers', () => {
  const cat = catalog as unknown as RescueCatalog

  it('puts one coral pin per alternative site, labelled with its best rank', () => {
    const alts = rescueMapMarkers(rescue, cat).filter((m) => m.kind === 'alternative')
    expect(alts.map((m) => [m.siteId, m.label])).toEqual(
      rescue.alternatives.map((a) => [a.scenario.site.id, `#${a.rank}`]),
    )
    expect(alts.every((m) => m.color === '#ff634a')).toBe(true)
    const peak = cat.sites.find((s) => s.id === 'peak-near-shackleton')!
    expect(alts[0]).toMatchObject({ lat: peak.lat, lon: peak.lon })
  })

  it('groups alternatives that share a site under the best rank', () => {
    const a0 = rescue.alternatives[0]
    const dup = { ...rescue, alternatives: [{ ...a0, rank: 3 }, { ...a0, rank: 2 }] }
    const alts = rescueMapMarkers(dup, cat).filter((m) => m.kind === 'alternative')
    expect(alts).toHaveLength(1)
    expect(alts[0].label).toBe('#2')
  })

  it('marks the failing plan in red with its main reasons', () => {
    const f = rescueMapMarkers(rescue, cat).filter((m) => m.kind === 'failing')
    expect(f).toHaveLength(1)
    expect(f[0].color).toBe('#f0605a')
    expect(f[0].siteId).toBe(rescue.changed.scenario.site.id)
    expect(f[0].label).toBe('Plan after delay fails: Earth contact, comms blackout +1 more')
  })

  it('draws no failing marker when the changed plan still works', () => {
    const ok = { ...rescue, changed: { ...rescue.changed, passes: true, eligibility: 'pass' as const, violations: [] } }
    expect(rescueMapMarkers(ok, cat).some((m) => m.kind === 'failing')).toBe(false)
  })

  it('shows near-miss sites at other places with the rule they break', () => {
    const miss = rescueMapMarkers(rescue, cat).filter((m) => m.kind === 'near_miss')
    const altSites = rescue.alternatives.map((a) => a.scenario.site.id)
    expect(miss.every((m) => !altSites.includes(m.siteId))).toBe(true)
    expect(miss.map((m) => m.siteId)).toContain('connecting-ridge')
    expect(miss.find((m) => m.siteId === 'connecting-ridge')!.label).toBe('Fails: power darkness')
  })

  it('flags the selected alternative and skips sites without coordinates', () => {
    const sel = rescueMapMarkers(rescue, cat, rescue.alternatives[1].scenario)
    expect(sel.filter((m) => m.selected).map((m) => m.siteId)).toEqual([rescue.alternatives[1].scenario.site.id])
    const bad = JSON.parse(JSON.stringify(rescue)) as RescueResponse
    bad.alternatives[0].scenario.site.lat = Number.NaN
    const noCat = { ...cat, sites: [] }
    expect(rescueMapMarkers(bad, noCat).some((m) => m.kind === 'alternative' && m.siteId === bad.alternatives[0].scenario.site.id)).toBe(false)
  })

  it('returns nothing without a result', () => {
    expect(rescueMapMarkers(null, cat)).toEqual([])
  })

  it('labels an unknown plan as unknown, never as failing', () => {
    const f = rescueMapMarkers(outside, cat).filter((m) => m.kind === 'failing')
    expect(f).toHaveLength(1)
    expect(f[0].label).toBe('Changed plan: unknown (no real data)')
    expect(f[0].color).toBe('#8691a9')
    expect(f[0].label.toLowerCase()).not.toContain('fails')
    expect(summaryText(outside)).not.toMatch(/fails/)
    expect(summaryText(outside)).toContain('plan unknown')
    expect(summaryText(outside)).toContain(`${outside.alternatives.length} options`)
  })

  it('says "Plan after delay" only when the landing date moved', () => {
    expect(rescueMapMarkers(rescue, cat).find((m) => m.kind === 'failing')!.label).toMatch(/^Plan after delay fails/)
    const same = JSON.parse(JSON.stringify(rescue)) as RescueResponse
    same.changed.scenario.landing_utc = same.original.scenario.landing_utc
    same.changed.scenario.requirements.min_earth_visibility_fraction = 0.9
    const label = rescueMapMarkers(same, cat).find((m) => m.kind === 'failing')!.label
    expect(label).toMatch(/^Changed plan fails/)
    expect(label).not.toContain('delay')
    expect(summaryText(rescue)).toContain('plan fails')
  })

  it('keeps both pins visible when the failing plan shares a site with #1', () => {
    const ms = rescueMapMarkers(rescue, cat)
    const fail = ms.find((m) => m.kind === 'failing')!
    const alt = ms.find((m) => m.kind === 'alternative' && m.label === '#1')!
    expect(fail.siteId).toBe(alt.siteId)
    expect(ms).toContain(fail)
    expect(fail.stemScale).toBeLessThan(1)
    // alternatives come after the failing marker, so the coral head is drawn on top
    expect(ms.indexOf(alt)).toBeGreaterThan(ms.indexOf(fail))
  })

  it('overlayMarkers is empty with no result or with the switch off', () => {
    const st = { rescue, showOnMap: true, selected: null, catalog: cat }
    expect(overlayMarkers(st).length).toBeGreaterThan(0)
    expect(overlayMarkers({ ...st, showOnMap: false })).toEqual([])
    expect(overlayMarkers({ ...st, rescue: null })).toEqual([])
  })
})

describe('RescueMapOverlay', () => {
  it('renders nothing with no result, or with the switch off', () => {
    expect(renderToString(<RescueMapOverlay frame={null as never} sites={[]} />)).toBe('')
    useRescueStore.setState({ rescue, showOnMap: false })
    expect(renderToString(<RescueMapOverlay frame={null as never} sites={[]} />)).toBe('')
    useRescueStore.setState({ rescue: null, showOnMap: true })
  })
})

describe('buildWalkthrough', () => {
  const text = (r: RescueResponse) => buildWalkthrough(r).map((st) => `${st.title}. ${st.text}`).join(' ')

  it('explains the rescue fixture in five steps using its real numbers', () => {
    const steps = buildWalkthrough(rescue)
    expect(steps).toHaveLength(5)
    expect(steps.every((st) => st.title && st.text)).toBe(true)
    // 1. launch delay 2027-10-15 -> 2027-10-25
    expect(steps[0].text).toContain('10 days')
    // 2. main broken rule: Earth visibility is 0% against a required 40%, the largest shortfall
    expect(steps[1].text).toContain('fails')
    expect(steps[1].text).toContain('0%')
    expect(steps[1].text).toContain('40%')
    // 3. 488 combinations, 8 locations, none undecided
    expect(steps[2].text).toContain('488')
    expect(steps[2].text).toContain('8 locations')
    expect(steps[2].text).toContain('2027-10-25')
    // 4. top alternative: Peak Near Shackleton, main gain 168 h
    expect(steps[3].text).toContain('Peak Near Shackleton')
    expect(steps[3].text).toContain('168 h')
    // 5. robust, 4 of 4
    expect(steps[4].text.toLowerCase()).toContain('robust')
    expect(steps[4].text).toContain('4 of 4')
  })

  it('says plainly when no alternative passes, without crashing', () => {
    const steps = buildWalkthrough(none)
    expect(steps).toHaveLength(5)
    expect(steps[0].text).toContain('500 h')
    expect(steps[3].text).toMatch(/no alternative/i)
    expect(steps[4].text).toMatch(/nothing to check|no alternative/i)
  })

  it('says plainly when the dates are outside the real data', () => {
    const t = text(outside)
    const steps = buildWalkthrough(outside)
    expect(steps).toHaveLength(5)
    expect(steps[1].text).toMatch(/unknown|could not be judged/i)
    expect(steps[1].text).toContain('48 h')
    expect(steps[1].text).toContain('168 h')
    expect(steps[2].text).toContain('88')
    expect(t).not.toContain('NaN')
    expect(t).not.toContain('undefined')
  })

  it('does not claim real data in simulation mode', () => {
    const sim = { ...rescue, data_source: 'synthetic:peak-near-shackleton, precomputed:x.json' }
    const t = buildWalkthrough(sim)[2].text
    expect(t).toContain('simulation mode')
    expect(t).toContain('synthetic placeholder data')
    expect(t).not.toContain('with real data')
    expect(buildWalkthrough(rescue)[2].text).toContain('with real data')
  })

  it('says no option could be judged when everything is undecided', () => {
    const steps = buildWalkthrough(outside)
    expect(steps[3].text).toMatch(/none of the options could be judged with real data/i)
    expect(steps[3].text).not.toMatch(/no alternative passes/i)
    expect(steps[4].text).toMatch(/none of the options could be judged with real data/i)
  })

  it('does not claim nothing could be judged when some options failed on real data', () => {
    const mixed = { ...outside, stats: { ...outside.stats, undecided: outside.stats.candidates_evaluated - 5, passing: 0 } } as RescueResponse
    const steps = buildWalkthrough(mixed)
    expect(steps[3].text).not.toMatch(/none of the options could be judged/i)
    expect(steps[3].text).toMatch(/no alternative passes/i)
  })

  it('defines the five terms briefly', () => {
    expect(GLOSSARY.map((g) => g.term.toLowerCase()).join('|')).toMatch(/sunlit fraction.*power gap.*earth contact.*robustness.*unknown/)
    for (const g of GLOSSARY) expect(g.definition.split('. ').length).toBeLessThanOrEqual(2)
  })

  it('uses the engine’s real meanings, not looser ones', () => {
    const def = (t: string) => GLOSSARY.find((g) => g.term.toLowerCase().startsWith(t))!.definition
    expect(def('sunlit')).toMatch(/disk/)
    expect(def('sunlit')).not.toMatch(/share of the mission time the Sun is above the horizon/)
    expect(def('longest power gap')).toMatch(/panel threshold/)
    expect(def('longest power gap')).toMatch(/no battery charge is simulated/)
    expect(def('earth contact')).toMatch(/line of sight/)
    expect(def('earth contact')).toMatch(/not modelled/)
    expect(def('unknown')).toMatch(/outside the dates.*incomplete/)
  })

  it('explains an unknown that is not about coverage hours in its own terms', () => {
    const res = structuredClone(rescue)
    res.changed.eligibility = 'unknown'
    res.changed.passes = false
    res.changed.violations = [{ ...res.changed.violations[0], constraint: 'min_sunlight_fraction', unit: 'fraction', is_unknown: true, actual: 0.3, required: 0.5 }]
    const t = buildWalkthrough(res)[1].text
    expect(t).toMatch(/incomplete for sunlit fraction/)
    expect(t).toMatch(/unknown \(not a fail\)/)
    expect(t).not.toMatch(/ h /)
  })

  it('formats a fraction-type broken rule in %, not hours', () => {
    const res = structuredClone(rescue)
    res.changed.eligibility = 'fail'
    res.changed.passes = false
    res.changed.violations = [{ ...res.changed.violations[0], constraint: 'min_earth_visibility_fraction', unit: 'fraction', is_unknown: false, actual: 0.12, required: 0.4, relative_shortfall: 0.7 }]
    const t = buildWalkthrough(res)[1].text
    expect(t).toMatch(/12%.*at least 40%/)
  })
})

describe('Explain switch', () => {
  // renderToString only sees zustand's initial state, so the panel's results renderer is tested directly.
  const render = (explain: boolean) =>
    renderToString(<RescueResults res={rescue} explain={explain} selected={null} sensitivity={null} onSelect={() => {}} onCheckSensitivity={() => {}} />)

  it('shows the walkthrough only when the switch is on', () => {
    expect(render(false)).not.toContain('What rescue did')
    const on = render(true)
    expect(on).toContain('What rescue did')
    expect(on).toContain('Sunlit fraction')
    expect(on.indexOf('What rescue did')).toBeLessThan(on.indexOf('Recommended alternatives'))
  })

  it('is off by default and toggles in the store', () => {
    expect(useRescueStore.getState().explain).toBe(false)
    useRescueStore.getState().setExplain(true)
    expect(useRescueStore.getState().explain).toBe(true)
    useRescueStore.setState({ explain: false })
  })
})

describe('SensitivityView statuses and counts', () => {
  it('shows every point with its status, the counts and the tested-window wording', () => {
    const html = renderToString(<SensitivityView data={sensitivity} />)
    expect(sensitivity.points.length).toBe(sensitivity.counts?.requested)
    expect(sensitivity.points.some((p) => p.status === 'not_evaluated')).toBe(true)
    expect(html).toContain('8 points requested: 4 evaluated (4 pass, 0 fail, 0 unknown), 4 not evaluated')
    expect(html).toContain('not evaluated')
    expect(html).toContain('tested slip from')
    expect(html).toContain('not a guarantee')
    expect(html).toContain('does not show robustness to landing-position error')
  })

  it('says "not assessed" and never "robust" when nothing could be evaluated', () => {
    const none = {
      ...sensitivity,
      verdict: 'not_assessed',
      counts: { requested: 2, evaluated: 0, skipped: 2, passed: 0, failed: 0, unknown: 0 },
      points: sensitivity.points.slice(0, 2).map((p) => ({ ...p, passes: false, score: null, status: 'unknown' as const })),
    } as unknown as SensitivityResponse
    const html = renderToString(<SensitivityView data={none} />)
    expect(html).toContain('not assessed')
    expect(html).not.toContain('>robust<')
  })
})

describe('operational headroom and evaluated time', () => {
  const req = { ...DEFAULT_REQUIREMENTS }
  const base = rescue.alternatives[0].viability.metrics

  it('computes darkness and blackout headroom from the metrics and requirements', () => {
    const items = headroom(base, rescue.alternatives[0].scenario.requirements)
    const r = rescue.alternatives[0].scenario.requirements
    const dark = items.find((h) => h.key === 'battery_hours')!
    expect(dark.amount).toBeCloseTo(r.battery_hours - base.longest_dark_gap_hours)
    const comms = items.find((h) => h.key === 'max_comms_gap_hours')!
    expect(comms.amount).toBeCloseTo(r.max_comms_gap_hours - base.longest_comms_gap_hours)
  })

  it('calls headroom limited under 6 h or under 10% of the limit, and names the closest requirement', () => {
    const tight = { ...base, longest_dark_gap_hours: 49, longest_comms_gap_hours: 10 }
    const s = headroomSummary(headroom(tight, req))
    expect(s.headline).toMatch(/limited darkness headroom \(1 h, limit 50 h\)/)
    expect(s.closest).toMatch(/^Closest to its limit: darkness/)
    const roomy = headroomSummary(headroom({ ...base, longest_dark_gap_hours: 15, longest_comms_gap_hours: 48 }, req))
    expect(roomy.headline).toBe('Passes with 35 h darkness and 48 h comms blackout headroom')
  })

  it('skips requirements that do not bind (a minimum of zero)', () => {
    const items = headroom(base, { ...req, min_initial_sun_hours: 0 })
    expect(items.some((h) => h.key === 'min_initial_sun_hours')).toBe(false)
  })

  it('notes the evaluated time only when it differs from the time entered', () => {
    expect(evaluatedTimeNote('2027-04-17T00:30:00Z', '2027-04-17T01:00:00Z')).toMatch(/^Evaluated at .*hourly data grid/)
    expect(evaluatedTimeNote('2027-04-17T01:00:00.000Z', '2027-04-17T01:00:00Z')).toBeNull()
    expect(evaluatedTimeNote(undefined, '2027-04-17T01:00:00Z')).toBeNull()
  })
})

describe('operational headroom in rescue UI', () => {
  const basePassViability = rescue.alternatives[0].viability
  const makePass = (darkGapHours: number) => ({
    ...basePassViability,
    passes: true,
    eligibility: 'pass' as const,
    violations: [],
    headroom: undefined,
    metrics: {
      ...basePassViability.metrics,
      longest_dark_gap_hours: darkGapHours,
      longest_comms_gap_hours: 12,
      initial_sun_hours: 24,
      initial_comms_hours: 18,
      hours_to_first_sunset: 24,
      hours_to_first_earthset: 18,
    },
    scenario: {
      ...basePassViability.scenario,
      requirements: {
        ...DEFAULT_REQUIREMENTS,
        battery_hours: 48,
        max_comms_gap_hours: 72,
        min_initial_sun_hours: 6,
        min_initial_comms_hours: 6,
      },
    },
  })

  it('qualifies RescueResults status="still_viable" with headroom and tested date-slip pills', () => {
    const limitedPass: RescueResponse = {
      ...rescue,
      status: 'still_viable',
      summary: 'Changed plan remains within declared model thresholds.',
      changed: makePass(47),
      changed_robustness: {
        checked_points: 4,
        passing_points: 4,
        pass_rate: 1,
        worst_score: 0.72,
        verdict: 'robust',
        note: '4 of 4 nearby positions pass',
        date_checked: 2,
        date_passing: 2,
        date_note: 'Tested -24 h / +24 h slips pass (limited at -24 h)',
        date_checks: [
          {
            date_offset_hours: -24,
            status: 'pass',
            passes: true,
            darkness_headroom_h: 1,
            comms_headroom_h: 60,
            closest_label: 'Darkness gap',
            closest_headroom_text: '+1 h',
            headroom_status: 'limited',
            failing_constraints: [],
          },
          {
            date_offset_hours: 24,
            status: 'pass',
            passes: true,
            darkness_headroom_h: 35,
            comms_headroom_h: 60,
            closest_label: 'Sunlight',
            closest_headroom_text: '+12 pts',
            headroom_status: 'comfortable',
            failing_constraints: [],
          },
        ],
      },
      alternatives: [],
    }
    const html = renderToString(
      <RescueResults
        res={limitedPass}
        selected={null}
        sensitivity={null}
        onSelect={() => {}}
        onCheckSensitivity={() => {}}
      />,
    )
    expect(html).toContain('Plan passes model screening')
    expect(html).not.toContain('Still passes')
    expect(html).toContain('Pass · limited darkness')
    expect(html).toContain('Closest requirement to limit')
    expect(html).toContain('Tested date-slip checks')
    expect(html).toContain('-24 h<!-- -->: <!-- -->pass · limited (+1 h)')
    expect(html).toContain('bg-amber-950')
    expect(html).toContain('not a guarantee of spacecraft survival')
  })

  it('qualifies buildWalkthrough still_viable copy instead of bare PASS', () => {
    const stillViable: RescueResponse = {
      ...rescue,
      status: 'still_viable',
      changed: makePass(47),
      alternatives: [],
    }
    const steps = buildWalkthrough(stillViable)
    expect(steps[1].text).toContain('passes with limited darkness margin')
    expect(steps[1].text).toContain('Model screening result only')
    expect(steps[3].text).toContain('not a guarantee of spacecraft survival')

    const withDateNotes: RescueResponse = {
      ...rescue,
      alternatives: [
        {
          ...rescue.alternatives[0],
          viability: makePass(47),
          robustness: {
            ...rescue.alternatives[0].robustness!,
            verdict: 'robust',
            date_note: 'Tested ±12 h slips pass with narrow darkness headroom.',
          },
        },
      ],
    }
    const rescuedSteps = buildWalkthrough(withDateNotes)
    expect(rescuedSteps[3].text).toContain('Passes with limited darkness margin')
    expect(rescuedSteps[4].text).toContain('±12 h slips pass')
    expect(rescuedSteps[4].text).toContain('Covers tested offsets only')
  })

  it('shows comfortable vs limited PassHeadroom, initial windows, and date-slip vs position separation on AlternativeCard', () => {
    const limitedAlt = {
      ...rescue.alternatives[0],
      viability: makePass(47),
      robustness: {
        checked_points: 4,
        passing_points: 4,
        pass_rate: 1,
        worst_score: 0.71,
        verdict: 'robust' as const,
        note: '4 of 4 nearby positions pass',
        date_checked: 2,
        date_passing: 1,
        date_note: 'Tested -24 h passes narrowly; +24 h fails darkness',
        date_checks: [
          {
            date_offset_hours: -24,
            status: 'pass' as const,
            passes: true,
            darkness_headroom_h: 1,
            comms_headroom_h: 60,
            closest_headroom_text: '+1 h',
            headroom_status: 'limited',
            failing_constraints: [],
          },
          {
            date_offset_hours: 24,
            status: 'fail' as const,
            passes: false,
            darkness_headroom_h: -2,
            comms_headroom_h: 58,
            closest_headroom_text: '-2 h',
            headroom_status: 'failed',
            failing_constraints: ['battery_hours' as const],
          },
        ],
      },
    }
    const comfortableAlt = { ...rescue.alternatives[0], viability: makePass(13) }

    const limitedHtml = renderToString(
      <AlternativeCard alt={limitedAlt} selected={false} onSelect={() => {}} onCheckSensitivity={() => {}} />,
    )
    expect(limitedHtml).toContain('Pass · limited darkness')
    expect(limitedHtml).toContain('first sunset T+24 h')
    expect(limitedHtml).toContain('first Earthset T+18 h')
    expect(limitedHtml).toContain('data-testid="date-slip-checks"')
    expect(limitedHtml).toContain('-24 h<!-- -->: <!-- -->pass · limited (+1 h)')
    expect(limitedHtml).toContain('+24 h<!-- -->: <!-- -->fail')
    expect(limitedHtml).toContain('data-testid="position-checks-note"')
    expect(limitedHtml).toContain('4 of 4 nearby positions pass')
    expect(limitedHtml).toContain('Model screening result based on solar illumination')

    const comfortableHtml = renderToString(
      <AlternativeCard alt={comfortableAlt} selected={false} onSelect={() => {}} onCheckSensitivity={() => {}} />,
    )
    expect(comfortableHtml).toContain('Pass · comfortable')
  })

  it('highlights limited date-slip offsets, tightest headroom, and screening note in SensitivityView', () => {
    const sens: SensitivityResponse = {
      ...sensitivity,
      base: makePass(47),
      tightest_passing_headroom: '+1 h darkness headroom at +12h slip',
      date_limited_offsets_hours: [12],
      screening_note: 'Model screening across discrete tested offsets only - narrow margins or gaps remain sensitive and are not a guarantee of mission success.',
      points: sensitivity.points.map((p) =>
        p.distance_km === 0 && p.date_offset_hours === 12
          ? { ...p, status: 'pass', passes: true, darkness_headroom_h: 1, closest_headroom_text: '+1 h', headroom_status: 'limited' }
          : p,
      ),
    }
    const html = renderToString(<SensitivityView data={sens} />)
    expect(html).toContain('data-testid="tightest-headroom-banner"')
    expect(html).toContain('+1 h darkness headroom at +12h slip')
    expect(html).toContain('data-testid="limited-offsets-note"')
    expect(html).toContain('bg-amber-950')
    expect(html).toContain('data-testid="sensitivity-screening-note"')
    expect(html).toContain('not a guarantee of mission success')
  })

  it('distinguishes comfortable vs limited PASS headroom on CompromiseResults best option and Pareto rows', () => {
    const compWithHeadroom: CompromiseResponse = {
      ...compromise,
      status: 'both_met',
      best: { ...compromise.pareto_front[0], viability: makePass(47), meets_engineering: true, meets_science: true },
      pareto_front: [
        { ...compromise.pareto_front[0], viability: makePass(47) },
        { ...(compromise.pareto_front[1] ?? compromise.pareto_front[0]), viability: makePass(13) },
      ],
    }
    const html = renderToString(<CompromiseResults res={compWithHeadroom} onSelect={() => {}} />)
    expect(html).toContain('Pass · limited darkness')
    expect(html).toContain('Pass · comfortable')
    expect(html).toContain('Closest:')
    expect(html).toContain('data-testid="compromise-screening-note"')
    expect(html).toContain('not a guarantee of spacecraft survival')
  })
})


describe('sensitivity of an UNKNOWN plan (real backend response)', () => {
  it('keeps each neighbouring date as its own mission, with the reason for every undecided point', () => {
    expect(verdictOfBase(sensNeighbours)).toBe('unknown')
    const by = Object.fromEntries(sensNeighbours.points.filter((p) => p.distance_km === 0).map((p) => [p.date_offset_hours, p]))
    expect(by[48].status).toBe('pass')
    expect(by[72].status).toBe('fail')
    expect(by[-24].status).toBe('unknown')
    expect(by[-24].reason).toBe('outside_coverage')
    const html = flat(renderToString(<SensitivityView data={sensNeighbours} />))
    expect(html).toContain('data-testid="sensitivity-base-unknown"')
    expect(html).toContain('Each slip below is a separate mission')
    expect(html).toContain('-24 h · unknown · no data')
    expect(html).toContain('data-reason="outside_coverage"')
    expect(html).toContain('Without an answer: 1 outside the data range, 2 position check unsupported')
    expect(html).toContain('says nothing about whether the planned date passes')
    expect(html).not.toContain('>robust<')
    expect(html).not.toContain('-24 h · fail')
  })

  it('labels missing-sample points differently from points outside the data, and older responses still render', () => {
    const gap = {
      ...sensNeighbours,
      points: sensNeighbours.points.map((p) =>
        p.date_offset_hours === -24 ? { ...p, reason: 'incomplete_data' as const, undecided_constraints: ['battery_hours'] } : p),
      counts: { ...sensNeighbours.counts!, by_reason: { incomplete_data: 1, position_unsupported: 2 } },
    }
    const html = flat(renderToString(<SensitivityView data={gap} />))
    expect(html).toContain('-24 h · unknown · gap')
    expect(html).toContain('unknown: real data has missing samples here (can&#x27;t decide: battery_hours)')
    expect(html).toContain('1 missing samples')
    const legacy = {
      ...sensNeighbours,
      points: sensNeighbours.points.map(({ reason: _r, undecided_constraints: _u, ...p }) => p),
      counts: { ...sensNeighbours.counts!, by_reason: undefined },
    } as unknown as SensitivityResponse
    const old = flat(renderToString(<SensitivityView data={legacy} />))
    expect(old).toContain('-24 h · unknown')
    expect(old).not.toContain('Without an answer')
  })
})

describe('What changed', () => {
  it('shows both canonical verdicts and the requirements the change broke', () => {
    const d = whatChanged(rescue)
    expect(d.from).toBe(verdictOfBase({ base: rescue.original } as unknown as SensitivityResponse))
    const html = flat(renderToString(<WhatChanged res={rescue} />))
    expect(html).toContain('data-testid="rescue-what-changed"')
    expect(html).toContain('Original plan')
    expect(html).toContain('After the change')
    expect(d.newlyBroken.length).toBeGreaterThan(0)
    for (const v of d.newlyBroken) expect(html).toContain(escapeHtml(v.message))
    expect(d.newlyBroken.every((v) => !v.is_unknown)).toBe(true)
  })

  it('calls undecided requirements undecided, never broken', () => {
    const d = whatChanged(outside)
    expect(d.to).toBe('unknown')
    expect(d.newlyBroken).toHaveLength(0)
    expect(d.undecided.length).toBeGreaterThan(0)
    const html = flat(renderToString(<WhatChanged res={outside} />))
    expect(html).toContain('UNKNOWN')
    expect(html).toContain('Undecided, not a failure')
    expect(html).not.toContain('Newly broken')
  })
})

function verdictOfBase(s: SensitivityResponse): 'pass' | 'fail' | 'unknown' {
  const b = s.base
  return b.eligibility ?? (b.passes ? 'pass' : 'fail')
}

/** Server-rendered HTML without React's text-node separators, so adjacent text reads as written. */
function flat(html: string): string {
  return html.replace(/<!-- -->/g, '')
}

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;')
}
