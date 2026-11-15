// "Show me why": any panel (Mission assessment, Scenario Comparison, the guided mission) can point the 3D view at
// the evidence for a result, i.e. a canonical evidence window from the viability engine. The 3D view selects the
// site, pauses, jumps to the moment, looks at the body concerned from the lander (the Sun for darkness/power, Earth
// for communications), and shades the window on the time strip. See docs/interfaces.md ("Show me why").
//
// Request lifecycle (each step is unit-tested in evidence.test.ts):
//   1. A producer calls showEvidence(request) (or openEvidence, which also switches to the planner). The request is
//      validated first; an invalid one is refused with a reason and never reaches the viewer.
//   2. Each accepted request gets a new id from a counter that clearing never resets, so ids never collide and a
//      repeated click on the same evidence is a new request.
//   3. The 3D view consumes requests through attachEvidenceViewer(): it subscribes and then takes any request still
//      pending, so a request submitted before the view mounted (e.g. from the Comparison page) is applied, one
//      submitted while it is mounted is applied, and nothing submitted in between is lost. Consumption is recorded in
//      the store (consumedId), not in the component, so a StrictMode re-run or a later remount never replays it.
//   4. Once the view has the site list it resolves the request (resolveEvidence); a newer request supersedes an
//      older one still waiting for data. The applied request becomes the `highlight`: what the strip shades and the
//      banner explains. It stays until it is cleared (Back, Exit, a new plan or mission playback), independently of
//      the consumed request.
import { create } from 'zustand'

import { goToView, type AppView } from '../appRoute'

export type EvidenceBody = 'sun' | 'earth'

/** Where the request came from, so the banner can offer the way back. */
export interface EvidenceOrigin {
  kind: 'assessment' | 'comparison' | 'guide'
  label: string // e.g. "Scenario B" or "Mission assessment"
  section?: string // Comparison section to return to (appRoute, e.g. 'cmp-performance')
  /** Restores the screen that asked (e.g. reopens a plan's assessment dialog). Called by Back; never serialised. */
  returnTo?: () => void
}

export interface EvidenceRequest {
  siteId: string
  startUtc: string // the moment to show (start of the canonical window); ISO 8601 with Z or an offset
  endUtc?: string | null // end of the window; null/absent = a single moment (no interval is invented)
  body: EvidenceBody
  // Explanation shown with the evidence, so it reads without the panel that asked:
  title?: string // the requirement, e.g. "Maximum continuous power-darkness"
  detail?: string // what the window is, e.g. "Power-dark period of 63 h · 2027-03-04 05:00 UTC → ..."
  requirement?: string // the threshold, e.g. "≤ 50 h"
  measured?: string // the measured value or bounds, e.g. "63 h" or "40 h – 70 h"
  dataMissing?: boolean // true = the window marks missing data, not a measured physical condition
  bodies?: EvidenceBody[] // every body the requirement depends on (both for Sun-and-Earth requirements)
  origin?: EvidenceOrigin
}

export interface ActiveEvidence extends EvidenceRequest {
  id: number
  startMs: number
  endMs: number | null
  note?: string | null // added by the viewer, e.g. the window runs past the end of the data
}

interface EvidenceState {
  request: ActiveEvidence | null // the latest accepted request (pending until a viewer consumes it)
  consumedId: number // highest request id a viewer has taken
  highlight: ActiveEvidence | null // what the 3D view shows now; persists until cleared
  problem: { id: number; message: string } | null // why the latest request could not be shown
}

export const useEvidence = create<EvidenceState>(() => ({ request: null, consumedId: 0, highlight: null, problem: null }))

let seq = 0 // request ids: monotonic for the life of the page, never reset by clearing

// ISO 8601 with an explicit zone. A string without one would be read in the browser's local time zone and change
// the mission's meaning, so it is refused rather than guessed.
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

function parseZoned(s: unknown): number | null {
  if (typeof s !== 'string' || !ISO_ZONED.test(s)) return null
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : null
}

/** Why a request cannot be shown, or null if it is valid. */
export function validateEvidence(r: EvidenceRequest): string | null {
  if (typeof r.siteId !== 'string' || !r.siteId.trim()) return 'No site was given for this evidence.'
  if (r.body !== 'sun' && r.body !== 'earth') return `Unsupported body "${String(r.body)}" (expected the Sun or Earth).`
  const start = parseZoned(r.startUtc)
  if (start === null) return `Invalid evidence time "${String(r.startUtc)}" (expected an ISO 8601 UTC time).`
  if (r.endUtc !== null && r.endUtc !== undefined) {
    const end = parseZoned(r.endUtc)
    if (end === null) return `Invalid evidence end time "${String(r.endUtc)}".`
    if (end < start) return 'The evidence window ends before it starts.'
  }
  return null
}

export type ShowResult = { ok: true; id: number } | { ok: false; reason: string }

/** Point the 3D view at a moment of evidence (see the module comment). Invalid requests are refused, not shown. */
export function showEvidence(request: EvidenceRequest): ShowResult {
  const reason = validateEvidence(request)
  if (reason) return { ok: false, reason }
  const startMs = parseZoned(request.startUtc)!
  const endMs = request.endUtc ? parseZoned(request.endUtc) : null
  const id = ++seq
  useEvidence.setState({
    request: {
      ...request,
      id,
      startMs,
      endMs,
      startUtc: new Date(startMs).toISOString(), // normalised to UTC: offsets never reach the viewer
      endUtc: endMs === null ? null : new Date(endMs).toISOString(),
    },
    problem: null,
  })
  return { ok: true, id }
}

// How "Show why" switches to the 3D view. The default is the app's hash router; tests (and any host without a
// window) install their own, so this module never touches `window` itself.
let navigate: (view: AppView) => void = (view) => {
  if (typeof window !== 'undefined') goToView(view)
}
export function setEvidenceNavigator(fn: ((view: AppView) => void) | null) {
  navigate = fn ?? ((view) => typeof window !== 'undefined' && goToView(view))
}

/** showEvidence, then open the Mission Planner (3D view). From another page this is the "Show why" button. */
export function openEvidence(request: EvidenceRequest): ShowResult {
  const res = showEvidence(request)
  if (res.ok) navigate('planner')
  return res
}

/** Take the pending request, if a viewer has not taken it yet (atomic in the single-threaded store). */
export function takeEvidence(): ActiveEvidence | null {
  const { request, consumedId } = useEvidence.getState()
  if (!request || request.id <= consumedId) return null
  useEvidence.setState({ consumedId: request.id })
  return request
}

/**
 * Connect a viewer: `onRequest` receives every request not yet consumed: one made before this call (the viewer was
 * not mounted) and each later one. Returns the disconnect function (React effect cleanup).
 */
export function attachEvidenceViewer(onRequest: (r: ActiveEvidence) => void): () => void {
  const consume = () => {
    const r = takeEvidence()
    if (r) onRequest(r)
  }
  const unsubscribe = useEvidence.subscribe(consume) // subscribe first, so nothing between the two steps is lost
  consume()
  return unsubscribe
}

/** The viewer applied this request: it is now the highlighted evidence. A stale (superseded) one is ignored. */
export function markEvidenceShown(r: ActiveEvidence) {
  if (useEvidence.getState().request?.id !== r.id) return
  useEvidence.setState({ highlight: r, problem: null })
}

/** The viewer could not show this request; the banner explains why. */
export function markEvidenceProblem(r: ActiveEvidence, message: string) {
  if (useEvidence.getState().request?.id !== r.id) return
  useEvidence.setState({ highlight: null, problem: { id: r.id, message } })
}

/** Leave the evidence view (the strip band and banner go away); the counter and consumption record are kept. */
export const clearEvidence = () => useEvidence.setState({ request: null, highlight: null, problem: null })

// --- resolving a request against the sites the 3D view knows -----------------------------------------------------

export interface EvidenceSite {
  id: string
  name?: string
  data_start_utc: string
  data_stop_utc: string
}

export type Resolution =
  | { status: 'wait' } // the site list is still loading
  | { status: 'error'; message: string }
  | { status: 'ok'; timeUtc: string; note: string | null }

/**
 * Can the 3D view show this request with the sites it has? Checks the site exists and the moment lies inside the
 * site's data. A window running past the data is shown up to the data's end, with a note (never extended).
 */
export function resolveEvidence(r: ActiveEvidence, sites: EvidenceSite[] | null, sitesError?: string | null): Resolution {
  if (!sites) return sitesError ? { status: 'error', message: `The site list could not be loaded: ${sitesError}` } : { status: 'wait' }
  const site = sites.find((s) => s.id === r.siteId)
  if (!site) return { status: 'error', message: `Site "${r.siteId}" has no data in the 3D view, so this evidence cannot be shown there.` }
  const lo = Date.parse(site.data_start_utc)
  const hi = Date.parse(site.data_stop_utc)
  if (!(r.startMs >= lo && r.startMs <= hi))
    return {
      status: 'error',
      message: `The evidence time ${r.startUtc.slice(0, 16).replace('T', ' ')} UTC is outside ${site.name ?? site.id}'s data (${site.data_start_utc.slice(0, 10)} to ${site.data_stop_utc.slice(0, 10)}).`,
    }
  const note = r.endMs !== null && r.endMs > hi ? `The window continues past the end of the data (${site.data_stop_utc.slice(0, 16).replace('T', ' ')} UTC); only the covered part is shaded.` : null
  return { status: 'ok', timeUtc: new Date(r.startMs).toISOString(), note }
}

/** The time-strip band for the highlighted evidence (null if none for this site). A point stays a point. */
export function evidenceBand(h: ActiveEvidence | null, siteId: string | null): { start: number; end: number; point: boolean; dataMissing: boolean } | null {
  if (!h || h.siteId !== siteId) return null
  return { start: h.startMs, end: h.endMs ?? h.startMs, point: h.endMs === null || h.endMs === h.startMs, dataMissing: !!h.dataMissing }
}

// --- which body explains a canonical window ----------------------------------------------------------------------

// The viability engine's window kinds (backend app/viability/enums.py WindowKind) -> what to look at.
const SUN_KINDS = new Set(['sunlight', 'darkness', 'full_sunlight', 'partial_sunlight', 'power_lit', 'power_dark', 'sun_unknown', 'power_unknown'])
const EARTH_KINDS = new Set(['earth_visible', 'communication_blackout', 'earth_unknown'])

/**
 * Which body explains a viability evidence window (`evidence_windows[].kind`): the Sun for sunlight and power,
 * Earth for communications. Windows needing both (simultaneous_*) default to the Sun (power is the usual limit);
 * callers mark such requests with `bodies: ['sun', 'earth']` so the viewer can offer the other one.
 * unknown_data (no data at all) has nothing to show, so null.
 */
export function bodyForWindowKind(kind: string): EvidenceBody | null {
  if (SUN_KINDS.has(kind) || kind.startsWith('simultaneous')) return 'sun'
  if (EARTH_KINDS.has(kind)) return 'earth'
  return null
}

/** Convenience for a viability evidence window: null if it has nothing to show (see bodyForWindowKind). */
export function evidenceFromWindow(
  siteId: string,
  w: { kind: string; start_utc: string; end_utc: string },
): EvidenceRequest | null {
  const body = bodyForWindowKind(w.kind)
  return body ? { siteId, startUtc: w.start_utc, endUtc: w.end_utc, body } : null
}
