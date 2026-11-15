// The Atlas map -> Planner path. A transferred mission must come entirely from one evaluated snapshot; editing the
// search, a pending search and a late older response can never change what a map cell stands for.
// Fixture: atlas-malapert.json, a real /api/atlas response (Malapert Massif, daily landings from 2027-01-01,
// 7 and 28-day missions, default requirements).
import { describe, expect, it } from 'vitest'

import { DEFAULT_REQUIREMENTS } from '../../types'
import malapertJson from './__fixtures__/atlas-malapert.json'
import type { AtlasRequest, AtlasResponse } from './atlas'
import { createAtlasSession, exactInstant, normalizeRequest, requestDiffs, transferFor, type AtlasSnapshot } from './session'

const malapert = malapertJson as unknown as AtlasResponse
const MALAPERT = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }
const RIDGE = { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767 }

const reqFor = (site_id: string, extra: Partial<AtlasRequest> = {}): AtlasRequest => ({
  site_id, start_utc: '2027-01-01T00:00:00Z', step_hours: 24, count: 16, durations_days: [7, 28],
  requirements: { ...DEFAULT_REQUIREMENTS }, ...extra,
})
const snap = (over: Partial<AtlasSnapshot> = {}): AtlasSnapshot => ({ seq: 1, request: reqFor('malapert-massif'), response: malapert, site: MALAPERT, ...over })

/** A fetcher whose responses the test releases by hand, in any order. */
function manualFetcher() {
  const calls: { req: AtlasRequest; resolve: (r: AtlasResponse) => void; reject: (e: Error) => void; signal: AbortSignal }[] = []
  const fetcher = (req: AtlasRequest, signal: AbortSignal) =>
    new Promise<AtlasResponse>((resolve, reject) => calls.push({ req, resolve, reject, signal }))
  return { fetcher, calls }
}
const ridgeResponse = (): AtlasResponse => ({
  ...malapert, site_id: 'connecting-ridge', site_name: 'Connecting Ridge',
  cells: malapert.cells.map((row) => row.map((c) => ({ ...c, status: 'fail' as const }))),
})
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('Atlas transfer comes from one evaluated snapshot', () => {
  it('sends the selected cell with the map’s own site, coordinates, exact landing, duration and requirements', () => {
    const t = transferFor(snap(), 0, 4, false)
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect(t.scenario).toEqual({
      site: MALAPERT,
      landing_utc: '2027-01-05T00:00:00Z', // the fixture's "2027-01-05T00:00Z", same instant, canonical form
      duration_days: 7,
      requirements: malapert.requirements_input,
    })
    expect(Date.parse(t.scenario.landing_utc)).toBe(Date.parse(malapert.cells[0][4].landing_utc))
    expect(t.name).toContain('Malapert Massif')
  })

  it('site changed in the form without rerunning: the transfer is still Malapert (the map shown), never Connecting Ridge', async () => {
    const { fetcher, calls } = manualFetcher()
    const s = createAtlasSession(fetcher)
    const done = s.getState().submit(reqFor('malapert-massif'), MALAPERT)
    calls[0].resolve(malapert)
    await done
    // The user picks Connecting Ridge in the dropdown but does not press "Map these missions".
    const edited = normalizeRequest(reqFor('connecting-ridge'), [28, 7])
    expect(requestDiffs(edited, s.getState().snapshot!.request)).toEqual(['site'])
    s.getState().select(0, 4)
    const t = s.getState().transfer()
    expect(t.ok && t.scenario.site).toEqual(MALAPERT)
    expect(t.ok && t.scenario.site.id).not.toBe(RIDGE.id)
  })

  it('requirements changed without rerunning: the transfer keeps the requirements the map was evaluated with', async () => {
    const { fetcher, calls } = manualFetcher()
    const s = createAtlasSession(fetcher)
    const done = s.getState().submit(reqFor('malapert-massif'), MALAPERT)
    calls[0].resolve(malapert)
    await done
    const edited = normalizeRequest(reqFor('malapert-massif', { requirements: { ...DEFAULT_REQUIREMENTS, battery_hours: 5 } }), [7, 28])
    expect(requestDiffs(edited, s.getState().snapshot!.request)).toEqual(['requirements'])
    s.getState().select(1, 2)
    const t = s.getState().transfer()
    expect(t.ok && t.scenario.requirements).toEqual(malapert.requirements_input)
    expect(t.ok && t.scenario.requirements.battery_hours).toBe(50)
    expect(t.ok && t.scenario.duration_days).toBe(28)
  })

  it('a submitted search that is still pending blocks transfer from the map it will replace', async () => {
    const { fetcher, calls } = manualFetcher()
    const s = createAtlasSession(fetcher)
    const first = s.getState().submit(reqFor('malapert-massif'), MALAPERT)
    calls[0].resolve(malapert)
    await first
    void s.getState().submit(reqFor('connecting-ridge'), RIDGE)
    expect(s.getState().pending?.request.site_id).toBe('connecting-ridge')
    const t = s.getState().transfer()
    expect(t.ok).toBe(false)
    expect(!t.ok && t.reason).toMatch(/new map is being evaluated/)
    // The map shown is still Malapert's, and it is not relabelled as Connecting Ridge.
    expect(s.getState().snapshot?.response.site_id).toBe('malapert-massif')
    calls[1].resolve(ridgeResponse())
    await tick()
    const after = s.getState().transfer()
    expect(after.ok && after.scenario.site).toEqual(RIDGE)
  })

  it('an older response arriving after a newer one cannot replace the current map', async () => {
    const { fetcher, calls } = manualFetcher()
    const s = createAtlasSession(fetcher)
    void s.getState().submit(reqFor('malapert-massif'), MALAPERT) // older
    void s.getState().submit(reqFor('connecting-ridge'), RIDGE) // newer
    expect(calls[0].signal.aborted).toBe(true)
    calls[1].resolve(ridgeResponse())
    await tick()
    calls[0].resolve(malapert) // the slow, superseded response
    await tick()
    expect(s.getState().snapshot?.response.site_id).toBe('connecting-ridge')
    expect(s.getState().snapshot?.site).toEqual(RIDGE)
    expect(s.getState().pending).toBeNull()
  })

  it('a failed newer search keeps the previous map (still labelled as the previous search) and reports the error', async () => {
    const { fetcher, calls } = manualFetcher()
    const s = createAtlasSession(fetcher)
    const first = s.getState().submit(reqFor('malapert-massif'), MALAPERT)
    calls[0].resolve(malapert)
    await first
    const second = s.getState().submit(reqFor('connecting-ridge'), RIDGE)
    calls[1].reject(new Error('Request failed (500)'))
    await second
    expect(s.getState().error).toBe('Request failed (500)')
    expect(s.getState().snapshot?.request.site_id).toBe('malapert-massif')
    expect(s.getState().transfer().ok).toBe(true)
  })

  it('refuses a response for a different site than requested, and a snapshot whose site does not match', async () => {
    const { fetcher, calls } = manualFetcher()
    const s = createAtlasSession(fetcher)
    const done = s.getState().submit(reqFor('connecting-ridge'), RIDGE)
    calls[0].resolve(malapert) // backend answered for Malapert
    await done
    expect(s.getState().snapshot).toBeNull()
    expect(s.getState().error).toMatch(/malapert-massif, not connecting-ridge/)
    const t = transferFor(snap({ site: RIDGE }), 0, 0, false)
    expect(!t.ok && t.reason).toMatch(/does not match its site/)
  })

  it('site metadata missing at submission: no transfer, with the reason', () => {
    const t = transferFor(snap({ site: null }), 0, 0, false)
    expect(t.ok).toBe(false)
    expect(!t.ok && t.reason).toMatch(/coordinates were not loaded/)
  })

  it('a not-evaluated landing cannot be sent', () => {
    const r: AtlasResponse = { ...malapert, cells: malapert.cells.map((row) => row.map((c) => ({ ...c, status: 'not_evaluated' as const }))) }
    expect(transferFor(snap({ response: r }), 0, 0, false).ok).toBe(false)
  })

  it('keeps between-hour landings with seconds exactly, and 1.01-day durations', () => {
    const t0 = '2027-01-01T00:30:15Z'
    const r: AtlasResponse = {
      ...malapert, landing_utc: [t0], durations_days: [1.01],
      cells: [[{ ...malapert.cells[0][0], landing_utc: t0, duration_days: 1.01 }]],
    }
    const t = transferFor(snap({ response: r }), 0, 0, false)
    expect(t.ok && t.scenario.landing_utc).toBe(t0)
    expect(t.ok && t.scenario.duration_days).toBe(1.01)
    expect(exactInstant('2027-01-05T00:00Z')).toBe('2027-01-05T00:00:00Z')
    expect(exactInstant('2027-01-05T00:00:00.123456Z')).toBe('2027-01-05T00:00:00.123456Z')
    expect(exactInstant('not a date')).toBeNull()
  })

  it('the selected cell drives the transfer (button and Enter both call session.transfer)', async () => {
    const { fetcher, calls } = manualFetcher()
    const s = createAtlasSession(fetcher)
    const done = s.getState().submit(reqFor('malapert-massif'), MALAPERT)
    calls[0].resolve(malapert)
    await done
    expect(s.getState().sel).toEqual([0, 0]) // first passing cell
    s.getState().select(1, 15)
    const t = s.getState().transfer()
    expect(t.ok && t.scenario.landing_utc).toBe('2027-01-16T00:00:00Z')
    expect(t.ok && t.scenario.duration_days).toBe(28)
  })
})
