// The mission window the backend actually evaluated, next to the one the user asked for.
//
// The backend evaluates every mission on its hourly data grid (backend/app/timegrid.py) and says what it evaluated
// on each result: evaluated_landing_utc, evaluated_duration_days and, when that differs from the request, a plain
// time_note. Everything in the comparison that describes an assessed mission (time axes, mission extents, cards,
// exports, the assistant's context, the 3D-view cursor) reads the window from this snapshot, so it never
// re-derives the grid rounding itself (JavaScript's Math.round and Python's round disagree at ties: 24.5 h is
// 24 h in the backend, 25 h with Math.round).
//
// Rules:
//   - The backend result is the only source of an evaluated window. Pending, failed, not requested, unassessed
//     (no data), results without the fields (older backends) and results for other inputs: evaluated = null.
//   - The request is always kept, under "requested", exactly as entered.
//   - axisPlacement() may estimate a provisional placement for a scenario with no evaluation, only so it has a
//     place on the shared axis while it loads; that estimate is never shown or exported as evaluated.
import type { ComparisonScenario, ResultState } from './types'

const HOUR = 3_600_000

/**
 * evaluated: the backend evaluated this window · pending: request in flight · error: request failed ·
 * not_requested: not sent yet · not_assessed: the backend could not assess it (e.g. no data for these dates) ·
 * not_reported: the result does not carry the evaluated fields · stale: the result belongs to other inputs.
 */
export type EvaluationStatus = 'evaluated' | 'pending' | 'error' | 'not_requested' | 'not_assessed' | 'not_reported' | 'stale'

export interface MissionWindow {
  landing_utc: string // ISO 8601, UTC
  duration_days: number
  duration_hours: number
  end_utc: string // landing + duration
}

export interface MissionTimeSnapshot {
  /** What the user entered, unchanged. */
  requested: MissionWindow
  /** What the backend evaluated; null unless status is 'evaluated'. */
  evaluated: MissionWindow | null
  status: EvaluationStatus
  available: boolean // status === 'evaluated'
  /** Whether the evaluation moved the landing or changed the length; null when nothing was evaluated. */
  adjusted: boolean | null
  /** The backend's own explanation when it adjusted the request; null otherwise. */
  time_note: string | null
}

/** Float cleanup only (e.g. 25/24*24 = 25.000000000000004): never a grid rounding. */
const clean = (v: number) => Math.round(v * 1e9) / 1e9

function windowOf(landingMs: number, days: number): MissionWindow {
  return {
    landing_utc: new Date(landingMs).toISOString(),
    duration_days: days,
    duration_hours: clean(days * 24),
    end_utc: new Date(landingMs + days * 24 * HOUR).toISOString(),
  }
}

export interface SnapshotOptions {
  /** The result key this scenario's inputs produce (resultKey()); a result with another key is stale. */
  expectedKey?: string
}

export function missionTimeOf(scenario: Pick<ComparisonScenario, 'landing_utc' | 'duration_days'>,
  state: ResultState | undefined, opts: SnapshotOptions = {}): MissionTimeSnapshot {
  const reqMs = new Date(scenario.landing_utc).getTime()
  const requested = Number.isFinite(reqMs)
    ? windowOf(reqMs, scenario.duration_days)
    : { landing_utc: scenario.landing_utc, duration_days: scenario.duration_days, duration_hours: clean(scenario.duration_days * 24), end_utc: '' }
  const none = (status: EvaluationStatus): MissionTimeSnapshot =>
    ({ requested, evaluated: null, status, available: false, adjusted: null, time_note: null })

  if (!state) return none('not_requested')
  if (state.state === 'loading') return none('pending')
  if (state.state === 'error') return none('error')
  const r = state.result
  if (opts.expectedKey !== undefined && r.key !== opts.expectedKey) return none('stale')
  if (r.status !== 'ok') return none('not_assessed')
  const evMs = r.evaluated_landing_utc ? new Date(r.evaluated_landing_utc).getTime() : NaN
  const evDays = r.evaluated_duration_days
  if (!Number.isFinite(evMs) || typeof evDays !== 'number' || !Number.isFinite(evDays) || evDays <= 0) return none('not_reported')
  const evaluated = windowOf(evMs, evDays)
  // Same comparison as the backend's time_note (exact landing; length within 1e-9 days).
  const adjusted = evMs !== reqMs || Math.abs(evDays - scenario.duration_days) > 1e-9
  return { requested, evaluated, status: 'evaluated', available: true, adjusted, time_note: r.time_note ?? null }
}

/** The snapshot of a comparison entry. */
export const missionTime = (e: { scenario: Pick<ComparisonScenario, 'landing_utc' | 'duration_days'>; state: ResultState | undefined }) =>
  missionTimeOf(e.scenario, e.state)

// ---------------------------------------------------------------- placement on the shared axis

/** Python's round(): halves go to the even neighbour (backend snap_duration_days uses it). */
const roundHalfEven = (v: number) => {
  const f = Math.floor(v)
  const d = v - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

export interface AxisPlacement {
  landingMs: number
  hours: number
  /** true = no evaluation yet: an estimate of the backend's grid, used only to place the scenario on the axis. */
  provisional: boolean
}

export function axisPlacement(t: MissionTimeSnapshot): AxisPlacement {
  if (t.evaluated) return { landingMs: new Date(t.evaluated.landing_utc).getTime(), hours: t.evaluated.duration_hours, provisional: false }
  // Provisional: the backend's documented policy (landing to the nearest hour, half up; length to whole hours,
  // ties to even, at least one). Never shown or exported as evaluated.
  const req = new Date(t.requested.landing_utc).getTime()
  return {
    landingMs: Math.floor((req + HOUR / 2) / HOUR) * HOUR,
    hours: Math.max(1, roundHalfEven(t.requested.duration_days * 24)),
    provisional: true,
  }
}

// ---------------------------------------------------------------- readable text

/** "2027-02-08 00:15 UTC" */
export const fmtWhen = (iso: string) => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'invalid date')

/** Evaluated lengths are whole hours: "24 h", "48 h (2 d)", "60 h (2.5 d)". */
export const fmtEvaluatedLength = (hours: number) =>
  hours >= 48 ? `${hours} h (${clean(hours / 24)} d)` : `${hours} h`

/** Requested lengths read as entered (days). */
export const fmtRequestedLength = (days: number) => `${days} d`

export const ADJUSTED_REASON = 'Reason: adjusted to the hourly scientific evaluation grid.'

const STATUS_TEXT: Record<Exclude<EvaluationStatus, 'evaluated'>, string> = {
  pending: 'pending',
  error: 'unavailable (request failed)',
  not_requested: 'not requested yet',
  not_assessed: 'not assessed (no data for this window)',
  not_reported: 'not reported by the backend',
  stale: 'pending (inputs changed)',
}

export const evaluationStatusText = (t: MissionTimeSnapshot) => (t.status === 'evaluated' ? 'evaluated' : STATUS_TEXT[t.status])

/** Short evaluated window, e.g. "2027-02-08 00:00 UTC, 24 h"; null when nothing was evaluated. */
export const evaluatedWindowText = (t: MissionTimeSnapshot) =>
  t.evaluated ? `${fmtWhen(t.evaluated.landing_utc)}, ${fmtEvaluatedLength(t.evaluated.duration_hours)}` : null

export const requestedWindowText = (t: MissionTimeSnapshot) =>
  `${fmtWhen(t.requested.landing_utc)}, ${fmtRequestedLength(t.requested.duration_days)}`

/**
 * Lines for cards and reports:
 *   Evaluated: 2027-02-08 00:00 UTC, 24 h
 *   Requested: 2027-02-08 00:15 UTC, 1.01 d
 *   Reason: adjusted to the hourly scientific evaluation grid.
 */
export function missionTimeLines(t: MissionTimeSnapshot): { evaluated: string; requested: string; reason: string | null } {
  return {
    evaluated: `Evaluated: ${evaluatedWindowText(t) ?? evaluationStatusText(t)}`,
    requested: `Requested: ${requestedWindowText(t)}`,
    reason: t.adjusted ? ADJUSTED_REASON : null,
  }
}

/** The window to describe a scenario by: the evaluated one when it exists, else the request (named as such). */
export const describedWindowText = (t: MissionTimeSnapshot) =>
  t.evaluated ? `evaluated ${evaluatedWindowText(t)}` : `requested ${requestedWindowText(t)}, evaluation ${evaluationStatusText(t)}`
