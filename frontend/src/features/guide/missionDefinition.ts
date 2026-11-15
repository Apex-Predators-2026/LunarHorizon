// The versioned mission definition behind "Try a mission" (missions/*.json, schema mission-story-v1) and the pure
// checks the guide runs against the LIVE results. The definition says what was verified; the guide only narrates a
// stage when the current engine / Rescue / comparison response still says the same thing (stable assertions).
// Otherwise it shows the actual result as an outdated example. backend/app/mission_story.py runs the same checks.
import type { Scenario } from '../../types'
import type { Assessment, ConstraintEvaluation } from '../assessment/types'
import type { Alternative, RescueResponse, SearchOptions } from '../rescue/types'
import definition from './missions/pns-launch-delay.json'

export interface MissionDefinition {
  schema: 'mission-story-v1'
  id: string
  version: number
  title: string
  objective: string
  audience_summary: string
  original: { name: string; scenario: Scenario; requirements_plain: string[] }
  disruption: { kind: 'launch_delay'; launch_delay_days: number; reason: string; description: string }
  search: SearchOptions
  data_mode: { allow_demo_data: boolean; include_synthetic: boolean; note: string }
  expected: {
    original: { eligibility: 'pass'; margin_constraints: string[] }
    disrupted: { eligibility: 'fail'; failing: string[]; min_exceedance: { constraint: string; hours: number }[] }
    evidence: { constraint: string; kind: string; start_utc: string; end_utc: string; clipped_at_end: boolean }
    recovery: {
      criteria: { eligibility: 'pass'; same_duration: boolean; same_requirements: boolean; real_data: boolean }
      selection: string
      expected_first?: { site_id: string; landing_utc: string; kind: string }
    }
    comparison: { ranked_first: 'recovery'; groups: number }
  }
  assertions: { stable: string[]; incidental: string[] }
  provenance: {
    verified_utc: string | null
    datasets: { site_file: string; sha256: string; dataset_id: string; generator: string | null }[]
    methods: Record<string, string> | null
  }
  reproduce: string[]
}

export const MISSION = definition as unknown as MissionDefinition

const H = 3_600_000

export const originalScenario = (d: MissionDefinition = MISSION): Scenario => ({ ...d.original.scenario })

/** The plan after the disruption, exactly as Mission Rescue builds it (backend app/rescue/search.py changed_scenario). */
export function disruptedScenario(d: MissionDefinition = MISSION): Scenario {
  const o = originalScenario(d)
  return { ...o, landing_utc: new Date(new Date(o.landing_utc).getTime() + d.disruption.launch_delay_days * 24 * H).toISOString() }
}

export const sameInstant = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime()

// ---------------------------------------------------------------- display helpers (values are never recomputed)

/** "14 Oct 2027, 00:00 UTC" */
export function utcText(iso: string, withTime = true): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return withTime ? `${date}, ${d.toISOString().slice(11, 16)} UTC` : date
}

const hoursOf = (v: number, unit: string) => (unit === 's' ? v / 3600 : v)

/** A canonical measured value in plain units: "118 h", "93.5%", "between 60.0% and 70.0%", "unavailable". */
export function measuredText(c: ConstraintEvaluation): string {
  const m = c.measured
  const f = (v: number) => {
    if (m.unit === 's') return `${Math.round(hoursOf(v, 's') * 10) / 10} h`
    if (m.unit === 'percent') return `${v.toFixed(1)}%`
    if (m.unit === 'fraction') return `${(v * 100).toFixed(1)}%`
    return `${v}`
  }
  if (m.status === 'known' && m.value !== null) return f(m.value)
  if (m.status === 'bounded' && m.lower !== null && m.upper !== null) return `between ${f(m.lower)} and ${f(m.upper)}`
  return 'unavailable'
}

export function limitText(c: ConstraintEvaluation): string {
  if (c.threshold === null) return 'no limit'
  const op = c.comparison === 'at_most' ? '≤' : '≥'
  const v = c.unit === 's' ? `${Math.round(c.threshold / 360) / 10} h` : c.unit === 'percent' ? `${c.threshold}%` : c.unit === 'fraction' ? `${c.threshold * 100}%` : `${c.threshold}`
  return `${op} ${v}`
}

/** Headroom against the limit in the measured unit (positive = inside the limit), only for exact values. */
export function headroom(c: ConstraintEvaluation): { value: number; text: string } | null {
  const m = c.measured
  if (c.threshold === null || m.status !== 'known' || m.value === null) return null
  const raw = c.comparison === 'at_most' ? c.threshold - m.value : m.value - c.threshold
  if (c.unit === 's') {
    const h = Math.round((raw / 3600) * 10) / 10
    return { value: h, text: `${Math.abs(h)} h ${h >= 0 ? 'to spare' : c.comparison === 'at_most' ? 'over the limit' : 'short of the limit'}` }
  }
  if (c.unit === 'percent' || c.unit === 'fraction') {
    const pp = Math.round((c.unit === 'fraction' ? raw * 100 : raw) * 10) / 10
    return { value: pp, text: `${Math.abs(pp)} percentage points ${pp >= 0 ? 'above' : 'below'} the limit` }
  }
  return null
}

export const constraintById = (a: Assessment, id: string) => a.constraints.find((c) => c.constraint_id === id) ?? null

export interface StatusChange {
  id: string
  name: string
  from: ConstraintEvaluation['status']
  to: ConstraintEvaluation['status']
  before: ConstraintEvaluation
  after: ConstraintEvaluation
}

/** Requirements whose canonical status differs between two assessments. */
export function statusChanges(before: Assessment, after: Assessment): StatusChange[] {
  const out: StatusChange[] = []
  for (const b of before.constraints) {
    const a = constraintById(after, b.constraint_id)
    if (a && a.status !== b.status) out.push({ id: b.constraint_id, name: b.name, from: b.status, to: a.status, before: b, after: a })
  }
  return out
}

// ---------------------------------------------------------------- stable assertions against live results

export type Check = { ok: true } | { ok: false; reason: string }
const ok: Check = { ok: true }
const no = (reason: string): Check => ({ ok: false, reason })

export function checkOriginal(a: Assessment, d: MissionDefinition = MISSION): Check {
  return a.eligibility === d.expected.original.eligibility
    ? ok
    : no(`The original plan now assesses as ${a.eligibility.toUpperCase()}; the example was verified with ${d.expected.original.eligibility.toUpperCase()}.`)
}

export function checkDisrupted(a: Assessment, d: MissionDefinition = MISSION): Check {
  if (a.eligibility !== d.expected.disrupted.eligibility)
    return no(`After the delay the plan now assesses as ${a.eligibility.toUpperCase()}; the example was verified with ${d.expected.disrupted.eligibility.toUpperCase()}.`)
  const failing = a.constraints.filter((c) => c.status === 'fail').map((c) => c.constraint_id).sort()
  const want = [...d.expected.disrupted.failing].sort()
  if (failing.join() !== want.join())
    return no(`After the delay the failing requirements are now ${failing.join(', ') || 'none'}; the example was verified with ${want.join(', ')}.`)
  for (const x of d.expected.disrupted.min_exceedance) {
    const c = constraintById(a, x.constraint)
    const h = c ? headroom(c) : null
    if (!h || -h.value < x.hours) return no(`${c?.name ?? x.constraint} no longer exceeds its limit by at least ${x.hours} h.`)
  }
  return ok
}

/** The evidence window the story points at: the engine's own window for the failing requirement. */
export function evidenceWindow(a: Assessment, d: MissionDefinition = MISSION) {
  const c = constraintById(a, d.expected.evidence.constraint)
  const w = c?.evidence_windows[0]
  if (!c || !w) return { check: no('The engine reported no evidence window for the failing requirement.'), constraint: c, window: null }
  const e = d.expected.evidence
  const same = w.kind === e.kind && sameInstant(w.start_utc, e.start_utc) && sameInstant(w.end_utc, e.end_utc) && w.clipped_at_end === e.clipped_at_end
  return { check: same ? ok : no(`The evidence window is now ${w.kind} ${w.start_utc} → ${w.end_utc}; the example was verified with ${e.start_utc} → ${e.end_utc}.`), constraint: c, window: w }
}

const isReal = (alt: Alternative) => !/synthetic/i.test(alt.viability.data_source)
const verdictOf = (v: { eligibility: string | null; passes: boolean }) => v.eligibility ?? (v.passes ? 'pass' : 'fail')

/** Rescue alternatives that satisfy the declared recovery criteria, in Rescue's own order. */
export function recoveryCandidates(res: RescueResponse, d: MissionDefinition = MISSION): Alternative[] {
  const c = d.expected.recovery.criteria
  const req = JSON.stringify(res.changed.scenario.requirements)
  return res.alternatives.filter((a) =>
    verdictOf(a.viability) === 'pass' &&
    (!c.same_duration || a.scenario.duration_days === res.changed.scenario.duration_days) &&
    (!c.same_requirements || JSON.stringify(a.scenario.requirements) === req) &&
    (!c.real_data || isReal(a)),
  )
}

/** Did Rescue re-plan exactly the disrupted mission the story assessed? */
export function rescueMatches(res: RescueResponse, d: MissionDefinition = MISSION): Check {
  const want = disruptedScenario(d)
  const got = res.changed.scenario
  return got.site.id === want.site.id && sameInstant(got.landing_utc, want.landing_utc) && got.duration_days === want.duration_days
    ? ok
    : no(`Mission Rescue re-planned ${got.site.name} landing ${got.landing_utc}, not the delayed plan the story assessed.`)
}
