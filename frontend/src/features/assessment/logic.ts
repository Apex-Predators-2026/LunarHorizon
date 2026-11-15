// Pure helpers for the Mission assessment panel: unit formatting, which evidence window explains a constraint,
// and plain-English wording. Nothing here decides a verdict; every status and number comes from the engine.
import type { EvidenceBody, EvidenceRequest } from '../../viz/evidence'
import { bodyForWindowKind } from '../../viz/evidence'
import type { Eligibility, Scenario } from '../../types'
import type { Assessment, ConstraintEvaluation, EngineWindow, Metric, Unit } from './types'

const HOUR = 3600

/** A value in the engine's unit as text: seconds as hours/days, percent and fraction as %. */
export function fmtValue(v: number, unit: Unit): string {
  if (unit === 's') {
    const h = v / HOUR
    if (Math.abs(h) >= 72) return `${Math.round(h)} h (${(h / 24).toFixed(1)} d)`
    return `${Math.round(h * 10) / 10} h`
  }
  if (unit === 'percent') return `${v.toFixed(1)}%`
  if (unit === 'fraction') return `${(v * 100).toFixed(1)}%`
  if (unit === 'deg') return `${v.toFixed(2)}°`
  return `${v}`
}

/** Measured value: exact, an interval when data is partly missing, or "no data". */
export function fmtMetric(m: Metric): string {
  if (m.status === 'known' && m.value !== null) return fmtValue(m.value, m.unit)
  if (m.status === 'bounded' && m.lower !== null && m.upper !== null) return `${fmtValue(m.lower, m.unit)} – ${fmtValue(m.upper, m.unit)}`
  return 'no data'
}

export function thresholdText(c: ConstraintEvaluation): string {
  if (c.threshold === null) return '—'
  const op = c.comparison === 'at_most' ? '≤' : c.comparison === 'at_least' ? '≥' : ''
  return `${op} ${fmtValue(c.threshold, c.unit)}`.trim()
}

const EARTH_CONSTRAINTS = new Set(['max_communication_blackout', 'min_earth_visibility_percent', 'min_initial_earth_visibility', 'min_earth_clearance'])

/** Which body a constraint is about: Earth for communications, the Sun for light and power. */
export const bodyForConstraint = (id: string): EvidenceBody => (EARTH_CONSTRAINTS.has(id) ? 'earth' : 'sun')

/** Plain-English statement of what a requirement protects, for non-specialists. */
export const PLAIN: Record<string, string> = {
  max_continuous_darkness: 'Solar landers run on batteries in the dark. If the longest darkness is longer than the battery lasts, the lander can freeze.',
  max_communication_blackout: 'Direct-to-Earth radio needs Earth above the local horizon. A long blackout means no contact with mission control.',
  min_initial_sunlight: 'After touchdown the lander needs sunlight right away to recharge and warm up.',
  min_initial_earth_visibility: 'After touchdown the team needs to talk to the lander to confirm a safe landing.',
  min_sunlight_percent: 'Share of the mission with any direct sunlight.',
  min_earth_visibility_percent: 'Share of the mission with Earth in line of sight for radio contact.',
  min_mean_solar_disk_fraction: 'How much of the Sun’s disk is visible on average. At the pole the Sun grazes the horizon, so terrain often hides part of it.',
  min_simultaneous_percent: 'Share of the mission with sunlight for power and Earth for contact at the same time.',
  min_sun_clearance: 'How high the Sun stays above the local terrain while it is visible.',
  min_earth_clearance: 'How high Earth stays above the local terrain while it is visible.',
}

/** What evidenceForConstraint needs: a site and the canonical windows (an Assessment, or the Comparison's copy). */
export type EvidenceSource = { site: { id: string }; windows: EngineWindow[] }
export type EvidenceConstraint = Pick<ConstraintEvaluation, 'constraint_id' | 'name' | 'status' | 'evidence_windows'> &
  Partial<Pick<ConstraintEvaluation, 'threshold' | 'unit' | 'comparison' | 'measured'>>

// Requirements that need the Sun and Earth together: the evidence shows one body, the viewer offers the other.
const BOTH_BODIES = new Set(['min_simultaneous_percent'])

export interface ConstraintEvidence {
  window: EngineWindow
  request: EvidenceRequest
  /** What the highlighted window is: the measured period behind the verdict, an illustration, or missing data. */
  role: 'measured' | 'illustrative' | 'missing_data'
  caption: string
}

const longest = (ws: EngineWindow[]) => [...ws].sort((a, b) => b.duration_s - a.duration_s)[0] as EngineWindow | undefined
const UNKNOWN_KIND = /_unknown$/

function edgeText(w: EngineWindow): string {
  const from = w.clipped_at_start ? 'from landing' : w.start_utc.replace('T', ' ').slice(0, 16) + ' UTC'
  const to = w.clipped_at_end ? 'until mission end' : w.end_utc.replace('T', ' ').slice(0, 16) + ' UTC'
  return `${from} → ${to}`
}

/**
 * The evidence window that explains a constraint, or null when the engine gave none (never invented).
 * 1. The constraint's own evidence windows (duration constraints): the measured period behind the verdict.
 * 2. Percentage constraints have none; the longest darkness/blackout in the mission is offered as an
 *    illustration of what lowers the share (labelled as such).
 * 3. UNKNOWN constraints: the missing-data window, labelled "data missing here".
 */
export function evidenceForConstraint(a: EvidenceSource, c: EvidenceConstraint): ConstraintEvidence | null {
  if (c.status === 'not_applicable') return null
  const body = bodyForConstraint(c.constraint_id)
  const requirement = c.threshold !== undefined && c.unit !== undefined && c.comparison !== undefined
    ? thresholdText({ threshold: c.threshold, unit: c.unit, comparison: c.comparison } as ConstraintEvaluation) : undefined
  const measured = c.measured ? fmtMetric(c.measured) : undefined
  const make = (w: EngineWindow, role: ConstraintEvidence['role'], caption: string): ConstraintEvidence | null => {
    const b = bodyForWindowKind(w.kind) ?? (role === 'missing_data' ? null : body)
    if (!b) return null
    return {
      window: w,
      role,
      caption,
      request: {
        siteId: a.site.id,
        startUtc: w.start_utc,
        endUtc: w.end_utc,
        body: b,
        title: c.name,
        detail: `${caption} · ${edgeText(w)}`,
        requirement,
        measured,
        dataMissing: role === 'missing_data',
        bodies: BOTH_BODIES.has(c.constraint_id) ? ['sun', 'earth'] : [b],
      },
    }
  }
  const own = c.evidence_windows
  if (own.length) {
    const w = own[0]
    if (UNKNOWN_KIND.test(w.kind)) return make(w, 'missing_data', 'No usable data in this period, so the requirement cannot be decided')
    if (c.status === 'unknown')
      return make(w, 'measured', `Confirmed ${kindLabel(w.kind).toLowerCase()} of at least ${fmtValue(w.duration_s, 's')}; missing data around it leaves the full length undecided`)
    return make(w, 'measured', `${kindLabel(w.kind)} of ${fmtValue(w.duration_s, 's')}`)
  }
  if (c.status === 'unknown') {
    const gap = longest(a.windows.filter((w) => UNKNOWN_KIND.test(w.kind) && bodyForWindowKind(w.kind) === body))
    return gap ? make(gap, 'missing_data', 'No usable data in this period, so the requirement cannot be decided') : null
  }
  const kinds = body === 'earth' ? ['communication_blackout'] : ['power_dark', 'darkness']
  for (const k of kinds) {
    const w = longest(a.windows.filter((x) => x.kind === k))
    if (w) return make(w, 'illustrative', `Longest ${kindLabel(k).toLowerCase()} in the mission (${fmtValue(w.duration_s, 's')}), which lowers this share`)
  }
  return null
}

export function kindLabel(kind: string): string {
  const L: Record<string, string> = {
    power_dark: 'Power-dark period (Sun below the panel threshold)',
    darkness: 'Darkness',
    communication_blackout: 'Earth blackout',
    sunlight: 'Sunlight',
    power_lit: 'Power-lit period',
    earth_visible: 'Earth in view',
    simultaneous_sun_earth: 'Sun and Earth together',
  }
  return L[kind] ?? kind.replace(/_/g, ' ')
}

/** Short status label for a constraint row. */
export const STATUS_LABEL: Record<ConstraintEvaluation['status'], string> = {
  pass: 'Met',
  fail: 'Violated',
  unknown: 'Undecided',
  not_applicable: 'Not applicable',
}

/** Which constraints to list: configured ones, failures first, then undecided, then met. */
export function orderedConstraints(a: Assessment): ConstraintEvaluation[] {
  const rank = { fail: 0, unknown: 1, pass: 2, not_applicable: 3 } as const
  return a.constraints.filter((c) => c.status !== 'not_applicable').sort((x, y) => rank[x.status] - rank[y.status])
}

/** The deciding requirement of a canonical assessment, for a one-line summary (e.g. the Planner's plan card). */
export interface PlanDecision {
  eligibility: Assessment['eligibility']
  /** fail: the failed requirement; unknown: the undecided one; pass: the requirement with the least relative margin */
  kind: 'fail' | 'unknown' | 'tightest' | 'none'
  constraint: ConstraintEvaluation | null
  text: string // e.g. "Earth blackout: 118 h vs ≤ 96 h (22 h over)"
  margin: string | null // operational margin where the engine gives one, e.g. "+28 h"
}

const marginOf = (a: Assessment, c: ConstraintEvaluation) => a.margins.find((m) => m.related_constraint === c.constraint_id)?.value ?? null

/**
 * The verdict and the one requirement that explains it, taken from the canonical assessment only (no verdict is
 * computed here). A requirement with a zero limit (switched off) is never the tightest margin.
 */
export function planDecision(a: Assessment): PlanDecision {
  const cs = orderedConstraints(a)
  const line = (c: ConstraintEvaluation) => `${c.name}: ${fmtMetric(c.measured)} vs ${thresholdText(c)}`
  const marginText = (c: ConstraintEvaluation) => {
    const m = marginOf(a, c)
    if (!m) return null
    if (m.status === 'known' && m.value !== null) return `${m.value >= 0 ? '+' : '−'}${fmtValue(Math.abs(m.value), m.unit)}`
    return fmtMetric(m)
  }
  const failed = cs.find((c) => c.status === 'fail')
  if (a.eligibility === 'fail' && failed) {
    const m = marginOf(a, failed)
    const over = m && m.status === 'known' && m.value !== null && m.value < 0 ? ` (${fmtValue(-m.value, m.unit)} beyond the limit)` : ''
    return { eligibility: 'fail', kind: 'fail', constraint: failed, text: `${line(failed)}${over}`, margin: marginText(failed) }
  }
  const undecided = cs.find((c) => c.status === 'unknown')
  if (a.eligibility === 'unknown' && undecided)
    return { eligibility: 'unknown', kind: 'unknown', constraint: undecided, margin: null,
      text: `${undecided.name} can't be decided: ${undecided.unknown_reason === 'no_data' ? 'no data for part of the mission' : 'data incomplete'} (measured ${fmtMetric(undecided.measured)} vs ${thresholdText(undecided)})` }
  let best: { c: ConstraintEvaluation; rel: number } | null = null
  for (const c of cs) {
    if (c.status !== 'pass' || !c.threshold) continue
    const m = marginOf(a, c)
    if (!m || m.status !== 'known' || m.value === null) continue
    const rel = m.value / Math.abs(c.threshold)
    if (!best || rel < best.rel) best = { c, rel }
  }
  if (best) return { eligibility: a.eligibility, kind: 'tightest', constraint: best.c, text: `Tightest: ${line(best.c)}`, margin: marginText(best.c) }
  return { eligibility: a.eligibility, kind: 'none', constraint: null, text: '', margin: null }
}

/** Plain-English verdict line for non-specialists (the verdict itself is the engine's). */
export const VERDICT_SENTENCE: Record<Eligibility, string> = {
  pass: 'Meets every operational requirement on the tested data.',
  fail: 'Breaks at least one operational requirement.',
  unknown: 'Cannot be decided: part of the mission has no usable data. This is not a failure.',
}

/** The change entered in the Rescue form (a launch delay, a new duration, requirement overrides). */
export interface PlanChangeLike {
  launch_delay_days?: number
  new_duration_days?: number | null
  requirement_overrides?: Record<string, number | null | undefined>
}

/**
 * The plan Rescue will build from the entered change, so "After change" can be assessed before Rescue has run.
 * null when the change changes nothing. The landing is shifted by exact days; the backend snaps it to its hourly grid.
 */
export function previewChangedPlan(original: Scenario, change: PlanChangeLike): Scenario | null {
  const delay = change.launch_delay_days ?? 0
  const duration = change.new_duration_days ?? null
  const overrides = Object.fromEntries(Object.entries(change.requirement_overrides ?? {}).filter(([, v]) => v !== undefined && v !== null))
  if (!delay && !duration && !Object.keys(overrides).length) return null
  return {
    site: original.site,
    landing_utc: new Date(new Date(original.landing_utc).getTime() + delay * 86_400_000).toISOString(),
    duration_days: duration ?? original.duration_days,
    requirements: { ...original.requirements, ...overrides },
  }
}
