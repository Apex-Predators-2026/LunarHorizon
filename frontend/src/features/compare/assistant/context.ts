// The structured context the Mission Assistant receives: the comparison exactly as the page shows it right now.
//
// Verdicts, ranks, groups and the recommendation come from buildExport(), which already enforces the comparison's
// integrity rules (UNKNOWN stays unknown, canonical ranks only for eligible PASS scenarios in their group,
// "recommended" only from the decision panel). Figures come from the same tables the page renders (At a glance,
// Key metrics, Requirements), as display text with units, so the assistant quotes what the user sees and a missing
// value reads "unavailable", never 0.
//
// v3: each scenario's mission window is the one the backend evaluated (mission_time, from missionTime.ts), with the
// request and the adjustment note beside it. v2 sent the requested landing_utc / duration_days, which read as the
// assessed window. Nothing evaluated yet: the evaluated fields are null and status says why.
import { formatMarginMetric } from '../../../lib/headroom'
import { METRICS, bestIds, fmtMetric, requirementMatrix, type Entry } from '../analysis'
import { buildExport, type ExportedScenario } from '../export'
import { HEADLINES, headlineRows } from '../glance'
import { changedChanged, rescueSteps, type RescueContext } from '../rescueFlow'
import { guideForAI } from './navigation'
import type { EvaluationStatus } from '../missionTime'
import { COMPARE_SECTIONS } from '../sections'
import type { PairEvidence, RankingGroup } from '../types'

export const ASSISTANT_CONTEXT_VERSION = 'comparison-assistant-context-v3'

/** empty: nothing selected · loading: results being computed · updating: ranking being recomputed · ready: all current */
export type ContextState = 'empty' | 'loading' | 'updating' | 'ready'

/** Display text per scenario letter. */
type ByScenario<T = string> = Record<string, T>

export interface AssistantScenario {
  label: string
  name: string
  origin: string // user | duplicate | preset | rescue | external
  site: ExportedScenario['site']
  mission_time: AssistantMissionTime
  spacecraft: ExportedScenario['spacecraft']
  result: 'not_requested' | 'loading' | 'done' | 'error'
  data_kind: string | null
  eligibility: ExportedScenario['eligibility']
  canonical_rank: number | null
  ranking_group: string | null
  recommended: boolean
  overall_risk: string | null
  failed_requirements: string[]
  undecided_requirements: string[]
  /** For a PASS: how comfortably it passes (e.g. "PASS, narrow margin on ..."), from the headroom panel. */
  headroom: { verdict: string; limited_by: string[] } | null
  /** Its part in a Mission Rescue import (null when not imported from Rescue). */
  rescue_role: string | null
  ranking_explanation: string | null
  message: string | null
}

/** The mission window the comparison describes: evaluated by the backend (null until it is), and the request. */
export interface AssistantMissionTime {
  status: EvaluationStatus
  evaluated_landing_utc: string | null
  evaluated_duration_hours: number | null
  evaluated_end_utc: string | null
  requested_landing_utc: string
  requested_duration_days: number
  adjusted: boolean | null // null = nothing evaluated yet
  note: string | null // the backend's explanation when it adjusted the request
}

export interface AssistantContext {
  format: typeof ASSISTANT_CONTEXT_VERSION
  page: 'scenario-comparison'
  state: ContextState
  /** Changes whenever the scenarios, their inputs or their results change. */
  revision: string
  selected: string[] // scenario letters, in page order
  ranking_method: string | null
  ranking_groups: ReturnType<typeof buildExport>['ranking_groups']
  decisions: ReturnType<typeof buildExport>['decisions']
  scenarios: AssistantScenario[]
  at_a_glance: { metric: string; better: 'higher' | 'lower'; values: ByScenario; requirement: ByScenario<string | null>; best: string[] }[]
  key_metrics: { metric: string; group: string; better: 'higher' | 'lower' | 'no preferred direction'; basis: string; values: ByScenario; best: string[] }[]
  requirements: { requirement: string; by_scenario: ByScenario<{ status: string; measured: string; threshold: string | null; margin: string; margin_class: string } | 'not assessed'> }[]
  /** Present when the compared plans came from Mission Rescue (and are still the imported set). */
  rescue: AssistantRescue | null
  notes: string[]
  sections: { id: string; label: string }[]
  /** How to use the page: the only description of controls the assistant may give. */
  interface_guide: ReturnType<typeof guideForAI>
}

export interface AssistantRescue {
  status: string
  summary: string // Mission Rescue's own summary
  change: string[] // what the user changed before running Rescue
  original: string | null // scenario letter
  changed: string | null
  changed_problems: { failed: string[]; undecided: string[] } | null
  alternatives: {
    label: string
    rescue_rank: number | null
    kind: string | null
    outcome_here: string // the re-assessment on this page (confirmed, passes_separately, undecided, still_fails, not_assessed)
    outcome_text: string
    fixes: string[] // requirements the changed plan fails that this alternative passes
    remaining: string[] // requirements it still fails or cannot decide
    rescue_verdict: string | null // what Mission Rescue itself reported
    disagrees_with_rescue: boolean
  }[]
}

/** Each imported plan's part in the Mission Rescue story, in words (by scenario id). */
function rescueRoles(ctx: RescueContext | null | undefined, entries: Entry[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!ctx || changedChanged(ctx, entries)) return out
  for (const [id, r] of Object.entries(ctx.roles)) {
    out.set(id, r.role === 'original' ? 'original plan (before the change)'
      : r.role === 'changed' ? 'changed plan (the plan after the change; the one Mission Rescue tried to fix)'
        : `Mission Rescue alternative #${r.rank ?? '?'}`)
  }
  return out
}

/** The Mission Rescue story, as the "Mission Rescue: from problem to decision" panel shows it. */
export function rescueForAssistant(ctx: RescueContext | null | undefined, entries: Entry[]): AssistantRescue | null {
  if (!ctx || changedChanged(ctx, entries)) return null
  const st = rescueSteps(ctx, entries)
  return {
    status: ctx.status,
    summary: ctx.summary,
    change: ctx.change,
    original: st.original?.scenario.label ?? null,
    changed: st.changed?.scenario.label ?? null,
    changed_problems: st.changedProblems,
    alternatives: st.alternatives.map((a) => ({
      label: a.entry.scenario.label,
      rescue_rank: a.info.rank ?? null,
      kind: a.info.kind ?? null,
      outcome_here: a.outcome,
      outcome_text: a.outcomeText,
      fixes: a.fixes,
      remaining: a.remaining,
      rescue_verdict: a.info.rescueVerdict ?? null,
      disagrees_with_rescue: a.disagreesWithRescue,
    })),
  }
}

export function contextState(entries: Entry[], ready: boolean): ContextState {
  if (!entries.length) return 'empty'
  if (entries.some((e) => !e.state || e.state.state === 'loading')) return 'loading'
  return ready ? 'ready' : 'updating'
}

/** Short stable hash (djb2) for the revision id. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const shown = (t: string | null | undefined) => (!t || t === '—' ? 'unavailable' : t)

export function buildAssistantContext(entries: Entry[], groups: RankingGroup[], pairs: PairEvidence[], notes: string[], ready: boolean,
  rescue: RescueContext | null = null): AssistantContext {
  const state = contextState(entries, ready)
  const x = buildExport(entries, ready ? groups : [], ready ? pairs : [], notes)
  const labelOf = new Map(entries.map((e) => [e.scenario.id, e.scenario.label]))
  const L = (id: string) => labelOf.get(id) ?? id

  const roleOf = rescueRoles(rescue, entries)
  const scenarios = x.scenarios.map((s, i): AssistantScenario => {
    const st = entries[i]?.state
    return {
      label: s.label,
      name: s.name,
      origin: s.origin,
      site: s.site,
      mission_time: {
        status: s.mission_time.evaluation_status,
        evaluated_landing_utc: s.mission_time.evaluated_landing_utc,
        evaluated_duration_hours: s.mission_time.evaluated_duration_hours,
        evaluated_end_utc: s.mission_time.evaluated_end_utc,
        requested_landing_utc: s.mission_time.requested_landing_utc,
        requested_duration_days: s.mission_time.requested_duration_days,
        adjusted: s.mission_time.time_adjusted,
        note: s.mission_time.time_note,
      },
      spacecraft: s.spacecraft,
      result: st ? st.state : 'not_requested',
      data_kind: s.data.kind,
      eligibility: s.eligibility,
      // A rank belongs to one selected set: while the set is being re-ranked, none is stated.
      canonical_rank: ready ? s.canonical_rank : null,
      ranking_group: ready ? s.ranking_group : null,
      recommended: s.recommended,
      overall_risk: s.overall_risk,
      failed_requirements: s.failed_requirements,
      undecided_requirements: s.undecided_requirements,
      rescue_role: roleOf.get(entries[i]?.scenario.id ?? '') ?? null,
      headroom: s.eligibility === 'pass' && s.headroom
        ? { verdict: s.headroom.qualified_verdict, limited_by: s.headroom.limited_constraints }
        : null,
      ranking_explanation: ready ? s.ranking_explanation : null,
      message: s.message,
    }
  })

  const at_a_glance = HEADLINES.map((h) => {
    const rows = headlineRows(h, entries)
    return {
      metric: h.label,
      better: h.better,
      values: Object.fromEntries(rows.map((r) => [r.entry.scenario.label, shown(r.text)])),
      requirement: Object.fromEntries(rows.map((r) => [r.entry.scenario.label, r.status])),
      best: rows.filter((r) => r.best).map((r) => r.entry.scenario.label),
    }
  })

  const key_metrics = METRICS.map((m) => {
    const values = Object.fromEntries(entries.map((e) => {
      if (!e.result) return [e.scenario.label, e.state?.state === 'loading' ? 'loading' : 'not assessed']
      return [e.scenario.label, shown(m.text?.(e.result, e.scenario) ?? fmtMetric(m.get(e.result, e.scenario), m.unit))]
    }))
    return {
      metric: m.label, group: m.group, better: m.better ?? ('no preferred direction' as const), basis: m.provenance,
      values, best: [...bestIds(entries, m)].map(L),
    }
  }).filter((row) => Object.values(row.values).some((v) => !['unavailable', 'not assessed', 'loading'].includes(v)))

  const requirements = requirementMatrix(entries).map((r) => ({
    requirement: r.name,
    by_scenario: Object.fromEntries(entries.map((e) => {
      const c = r.cells[e.scenario.id]
      return [e.scenario.label, c
        ? { status: c.status, measured: c.measured, threshold: c.threshold, margin: formatMarginMetric(c.margin), margin_class: c.marginClass }
        : 'not assessed' as const]
    })),
  }))

  const revision = hash(JSON.stringify([state, entries.map((e) => [e.scenario.label, e.scenario.site.id, e.scenario.landing_utc,
    e.scenario.duration_days, e.scenario.requirements, e.scenario.spacecraft, e.state?.state, e.result?.key ?? null]),
  // The evaluated window is part of the answer: a changed evaluation is a new revision even with the same inputs.
  scenarios.map((s) => [s.eligibility, s.canonical_rank, s.recommended, s.mission_time]), rescue?.importedAt ?? null]))

  return {
    format: ASSISTANT_CONTEXT_VERSION,
    page: 'scenario-comparison',
    state,
    revision,
    selected: entries.map((e) => e.scenario.label),
    ranking_method: x.ranking_method,
    ranking_groups: x.ranking_groups,
    decisions: x.decisions,
    scenarios,
    at_a_glance,
    key_metrics,
    requirements,
    rescue: rescueForAssistant(rescue, entries),
    notes: [...new Set(x.notes)].slice(0, 16),
    sections: COMPARE_SECTIONS.map(([id, label]) => ({ id, label })),
    interface_guide: guideForAI(),
  }
}

/** What the assistant's answers depend on. When it changes between two questions, the chat says so. */
export const contextSignature = (c: AssistantContext): string => c.revision

/** One line for the panel: what the assistant is reading right now. */
export function contextLine(c: AssistantContext): string {
  if (c.state === 'empty') return 'No scenarios selected'
  const names = c.scenarios.map((s) => `${s.label} (${s.site.name})`).join(', ')
  const when = c.state === 'ready' ? 'results up to date' : c.state === 'loading' ? 'results loading…' : 'ranking updating…'
  return `${names} · ${when}`
}

/** The page's own verdict per scenario, e.g. "B PASS #1", shown under each answer so it can be checked at a glance. */
export function verdictChips(c: AssistantContext): string[] {
  return c.scenarios.map((s) => {
    const v = s.eligibility ? s.eligibility.toUpperCase() : s.result === 'loading' ? 'loading' : 'not assessed'
    return `${s.label} ${v}${s.canonical_rank !== null ? ` #${s.canonical_rank}` : ''}${s.recommended ? ' (recommended)' : ''}`
  })
}
