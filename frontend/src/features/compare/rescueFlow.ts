// Mission Rescue -> comparison (Phase 6). Pure functions. Rescue (Member 5) finds the alternatives; the comparison
// re-assesses every imported plan with the same canonical engine and reports the result, so a "potentially better"
// alternative is never shown as a confirmed fix unless it actually passes here.
import type { Eligibility, Scenario } from '../../types'
import type { AltKind, PlanChange, RescueResponse, RescueStatus } from '../rescue/types'
import { eligibilityOf, requirementSummary, type Entry } from './analysis'
import { MAX_COMPARED } from './palette'

export type RescueRole = 'original' | 'changed' | 'alternative'

export interface RescueRoleInfo {
  role: RescueRole
  rank?: number // Mission Rescue's own rank for an alternative
  kind?: AltKind
  headline?: string // Mission Rescue's own wording for the alternative
  rescueVerdict?: Eligibility | null // what Mission Rescue reported
}

/** Kept with the comparison workspace so the story survives switching tabs. */
export interface RescueContext {
  importedAt: string
  status: RescueStatus
  summary: string
  change: string[] // human-readable description of what changed
  roles: Record<string, RescueRoleInfo> // by comparison scenario id
}

const KIND_TEXT: Record<AltKind, string> = {
  unchanged: 'same plan', date_shift: 'new date', site_change: 'new site', site_and_date: 'new site and date',
}

const samePlan = (a: Scenario, b: Scenario) =>
  a.site.id === b.site.id && new Date(a.landing_utc).getTime() === new Date(b.landing_utc).getTime() &&
  a.duration_days === b.duration_days && JSON.stringify(a.requirements) === JSON.stringify(b.requirements)

const verdict = (v: { eligibility: Eligibility | null; passes: boolean }): Eligibility => v.eligibility ?? (v.passes ? 'pass' : 'fail')

/** Plain-language description of a PlanChange (what the user changed before running Rescue). */
export function describeChange(change: PlanChange): string[] {
  const out: string[] = []
  if (change.launch_delay_days) out.push(`Launch delayed by ${change.launch_delay_days} day${change.launch_delay_days === 1 ? '' : 's'}`)
  if (change.new_duration_days) out.push(`Mission length changed to ${change.new_duration_days} days`)
  const overrides = Object.entries(change.requirement_overrides ?? {}).filter(([, v]) => v !== undefined && v !== null)
  if (overrides.length) out.push(`Requirements changed: ${overrides.map(([k, v]) => `${k.replace(/_/g, ' ')} = ${v}`).join(', ')}`)
  if (change.reason) out.push(`Reason: ${change.reason}`)
  return out.length ? out : ['No change entered: Rescue checked the current plan as it is']
}

export interface RescueImportPlan {
  scenarios: Scenario[]
  names: string[]
  notes: string[]
  roles: RescueRoleInfo[] // same order as scenarios
  includesOriginal: boolean
}

/**
 * What to send to the comparison: the original plan (when the change produced a different plan), the changed plan,
 * and Rescue's top alternatives, up to the comparison's limit of four.
 */
export function rescueImportPlan(res: RescueResponse): RescueImportPlan {
  const orig = res.original.scenario, chg = res.changed.scenario
  const includesOriginal = !samePlan(orig, chg)
  const scenarios: Scenario[] = [], names: string[] = [], notes: string[] = [], roles: RescueRoleInfo[] = []
  if (includesOriginal) {
    scenarios.push(orig); names.push(`Original plan · ${orig.site.name}`); notes.push('The plan before the change')
    roles.push({ role: 'original', rescueVerdict: verdict(res.original) })
  }
  scenarios.push(chg); names.push(`After the change · ${chg.site.name}`); notes.push('The plan after the change, as Mission Rescue evaluated it')
  roles.push({ role: 'changed', rescueVerdict: verdict(res.changed) })
  for (const a of res.alternatives.slice(0, MAX_COMPARED - scenarios.length)) {
    scenarios.push(a.scenario)
    names.push(`Rescue #${a.rank} · ${a.scenario.site.name} (${KIND_TEXT[a.kind]})`)
    notes.push(a.headline)
    roles.push({ role: 'alternative', rank: a.rank, kind: a.kind, headline: a.headline, rescueVerdict: verdict(a.viability) })
  }
  return { scenarios, names, notes, roles, includesOriginal }
}

// ---------------------------------------------------------------- the story shown in the comparison

export type AltOutcome =
  | 'confirmed' // passes here and is ranked against the changed plan's group
  | 'passes_separately' // passes here, but in a different comparable group (different requirements or duration)
  | 'undecided' // cannot be decided here: a potential option, not a confirmed fix
  | 'still_fails' // fails here: not a fix
  | 'not_assessed' // no data / not assessed here

export interface AltStep {
  entry: Entry
  info: RescueRoleInfo
  outcome: AltOutcome
  fixes: string[] // requirements the changed plan fails that this alternative passes
  remaining: string[] // requirements this alternative still fails or cannot decide
  disagreesWithRescue: boolean // Rescue's verdict differs from the re-assessment here
}

export interface RescueSteps {
  original: Entry | null
  changed: Entry | null
  changedProblems: { failed: string[]; undecided: string[] } | null
  alternatives: AltStep[]
}

const names = (xs: { name: string }[]) => xs.map((x) => x.name)

export function rescueSteps(ctx: RescueContext, entries: Entry[]): RescueSteps {
  const byId = new Map(entries.map((e) => [e.scenario.id, e]))
  const find = (role: RescueRole) => Object.entries(ctx.roles).filter(([, r]) => r.role === role).map(([id, r]) => ({ e: byId.get(id), r }))
  const original = find('original')[0]?.e ?? null
  const changed = find('changed')[0]?.e ?? null
  const cs = changed ? requirementSummary(changed) : null
  const alternatives: AltStep[] = []
  for (const { e, r } of find('alternative').sort((a, b) => (a.r.rank ?? 0) - (b.r.rank ?? 0))) {
    if (!e) continue
    const el = eligibilityOf(e)
    const s = requirementSummary(e)
    let outcome: AltOutcome
    if (!el || !e.result) outcome = 'not_assessed'
    else if (el === 'pass') outcome = changed?.ranking?.group && e.ranking?.group && changed.ranking.group !== e.ranking.group ? 'passes_separately' : 'confirmed'
    else if (el === 'unknown') outcome = 'undecided'
    else outcome = 'still_fails'
    const passedIds = new Set(e.result?.assessment?.constraints.filter((c) => c.status === 'pass').map((c) => c.id) ?? [])
    const fixes = (cs?.failed ?? []).filter((f) => passedIds.has(f.id)).map((f) => f.name)
    const remaining = s ? [...names(s.failed), ...names(s.undecided)] : []
    alternatives.push({
      entry: e, info: r, outcome, fixes, remaining,
      disagreesWithRescue: !!el && !!r.rescueVerdict && r.rescueVerdict !== el,
    })
  }
  return {
    original, changed,
    changedProblems: cs ? { failed: names(cs.failed), undecided: names(cs.undecided) } : null,
    alternatives,
  }
}

export const OUTCOME_TEXT: Record<AltOutcome, string> = {
  confirmed: 'Passes every requirement here: a confirmed fix',
  passes_separately: 'Passes, but under different requirements or mission length, so it is not directly comparable with the changed plan',
  undecided: 'Cannot be decided from the data: a potential option, not a confirmed fix',
  still_fails: 'Still fails a requirement here: not a fix',
  not_assessed: 'Not assessed here (no data): not a confirmed fix',
}

/** Has any imported plan been changed or deselected since the import? (The story then describes a stale set.) */
export const changedChanged = (ctx: RescueContext, entries: Entry[]) =>
  Object.keys(ctx.roles).some((id) => !entries.some((e) => e.scenario.id === id))
