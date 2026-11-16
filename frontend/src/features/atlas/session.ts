// The Atlas's evaluated maps and the one safe path from a map cell to a Planner mission.
//
// A map is an immutable snapshot: the request exactly as submitted, the response, and the site metadata captured
// at submission. Everything a transferred mission contains (site id, coordinates, landing instant, duration,
// requirements) comes from that one snapshot, never from the search form, which the user may have edited since.
// Requests are numbered; only the newest may replace the map, so a slow older response is discarded.
import { createStore } from 'zustand/vanilla'

import type { MissionRequirements, Scenario, SiteInfo } from '../../types'
import { fetchAtlas } from './api'
import { fmtDays, fmtUtc, type AtlasRequest, type AtlasResponse } from './atlas'

export type SiteRef = Pick<SiteInfo, 'id' | 'name' | 'lat' | 'lon'>

export interface AtlasSnapshot {
  seq: number
  request: AtlasRequest // as submitted
  response: AtlasResponse
  site: SiteRef | null // the submitted site's metadata; null if it was not available
}

export type Transfer =
  | { ok: true; name: string; scenario: Scenario; from: string }
  | { ok: false; reason: string }

/** The request a form describes, normalised the way it is submitted (sorted, unique durations). */
export function normalizeRequest(form: AtlasRequest, durations: number[]): AtlasRequest {
  return { ...form, durations_days: [...new Set(durations)].sort((a, b) => a - b), requirements: { ...form.requirements } }
}

const sameReqs = (a: MissionRequirements, b: MissionRequirements) =>
  (Object.keys({ ...a, ...b }) as (keyof MissionRequirements)[]).every((k) => a[k] === b[k])

/** What differs between an edited search and the map shown, in words ([] = the map shows this search). */
export function requestDiffs(edited: AtlasRequest, shown: AtlasRequest): string[] {
  const d: string[] = []
  if (edited.site_id !== shown.site_id) d.push('site')
  if (edited.start_utc !== shown.start_utc) d.push('first landing date')
  if (edited.step_hours !== shown.step_hours) d.push('sampling interval')
  if (edited.count !== shown.count) d.push('number of dates')
  if (edited.durations_days.join(',') !== shown.durations_days.join(',')) d.push('mission lengths')
  if (!sameReqs(edited.requirements, shown.requirements)) d.push('requirements')
  return d
}

/**
 * The mission behind one cell of a snapshot, or why it cannot be sent. Used by both the button and Enter.
 * `pending`: a newer search is being evaluated; the map shown is about to be replaced, so nothing is sent.
 */
export function transferFor(snap: AtlasSnapshot | null, row: number, col: number, pending: boolean): Transfer {
  if (!snap) return { ok: false, reason: 'No map yet.' }
  if (pending) return { ok: false, reason: 'A new map is being evaluated: wait for it before opening a mission.' }
  const r = snap.response
  const cell = r.cells[row]?.[col]
  if (!cell) return { ok: false, reason: 'No mission is selected.' }
  if (cell.status === 'not_evaluated') return { ok: false, reason: "This landing is outside the site's data: no mission was evaluated here." }
  if (!snap.site) return { ok: false, reason: "The site's coordinates were not loaded, so this mission cannot be placed in the Planner. Reload the page and map again." }
  if (r.site_id !== snap.request.site_id || snap.site.id !== r.site_id)
    return { ok: false, reason: `This map does not match its site (${r.site_id} vs ${snap.site.id}): map the missions again.` }
  const landing = exactInstant(cell.landing_utc)
  if (cell.landing_utc !== r.landing_utc[col] || cell.duration_days !== r.durations_days[row] || landing === null)
    return { ok: false, reason: 'This cell does not match the map’s tested dates: map the missions again.' }
  const scenario: Scenario = {
    site: { id: snap.site.id, name: snap.site.name, lat: snap.site.lat, lon: snap.site.lon },
    landing_utc: landing, // the exact evaluated instant
    duration_days: cell.duration_days,
    requirements: { ...r.requirements_input }, // the requirements this map was evaluated with
  }
  const when = `${fmtUtc(cell.landing_utc)}, ${fmtDays(cell.duration_days)}`
  return { ok: true, scenario, name: `Atlas: ${snap.site.name} ${when}`, from: `${r.site_name}, landing ${when}, requirements as mapped` }
}

/**
 * The evaluated instant in the app's canonical form (YYYY-MM-DDTHH:MM:SSZ, milliseconds only when present). Older
 * responses wrote minutes only ("…T00:00Z"); the instant is the same. Sub-millisecond digits are kept verbatim.
 */
export function exactInstant(iso: string): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  if (/\.\d{4,}/.test(iso)) return iso
  return new Date(t).toISOString().replace('.000Z', 'Z')
}

/** First passing cell (else the first cell), so the explanation has something to say. */
export function firstCell(r: AtlasResponse): [number, number] {
  for (let i = 0; i < r.cells.length; i++) for (let j = 0; j < r.cells[i].length; j++) if (r.cells[i][j].status === 'pass') return [i, j]
  return [0, 0]
}

export type Fetcher = (req: AtlasRequest, signal: AbortSignal) => Promise<AtlasResponse>

export interface AtlasSession {
  seq: number // the newest request number
  snapshot: AtlasSnapshot | null // the map shown
  pending: { seq: number; request: AtlasRequest } | null // a newer search being evaluated
  error: string | null
  /** The search that failed (with `error`), so Retry sends exactly that request again. */
  failed: { request: AtlasRequest; site: SiteRef | null } | null
  sel: [number, number]
  submit: (request: AtlasRequest, site: SiteRef | null) => Promise<void>
  retry: () => Promise<void>
  select: (row: number, col: number) => void
  transfer: () => Transfer // the selected cell of the map shown
}

export function createAtlasSession(fetcher: Fetcher) {
  let ctl: AbortController | null = null
  return createStore<AtlasSession>()((set, get) => ({
    seq: 0,
    snapshot: null,
    pending: null,
    error: null,
    failed: null,
    sel: [0, 0],
    submit: async (request, site) => {
      const seq = get().seq + 1
      ctl?.abort()
      const mine = new AbortController()
      ctl = mine
      set({ seq, pending: { seq, request }, error: null, failed: null })
      try {
        const response = await fetcher(request, mine.signal)
        if (get().seq !== seq) return // superseded: a newer search owns the map
        if (response.site_id !== request.site_id) throw new Error(`The backend answered for ${response.site_id}, not ${request.site_id}`)
        set({ snapshot: { seq, request, response, site: site && site.id === request.site_id ? site : null }, pending: null, sel: firstCell(response) })
      } catch (e) {
        if (get().seq !== seq || (e as Error).name === 'AbortError') return
        set({ pending: null, error: e instanceof Error ? e.message : String(e), failed: { request, site } }) // the previous map stays, still labelled
      }
    },
    retry: async () => {
      const { failed, submit } = get()
      if (failed) await submit(failed.request, failed.site)
    },
    select: (row, col) => set({ sel: [row, col] }),
    transfer: () => {
      const { snapshot, sel, pending } = get()
      return transferFor(snapshot, sel[0], sel[1], pending !== null)
    },
  }))
}

/** The app's session: the last map survives switching tabs, and only the newest request may replace it. */
export const atlasSession = createAtlasSession((req, signal) => fetchAtlas(req, signal))
