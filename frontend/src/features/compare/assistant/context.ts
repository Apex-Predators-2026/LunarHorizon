// The structured context the Mission Assistant receives: the comparison exactly as the page shows it right now.
//
// Built from buildExport(), which already enforces the comparison's integrity rules (missing stays null, UNKNOWN
// stays unknown, canonical ranks only for eligible PASS scenarios in their group, "recommended" only from the
// decision panel). This module only trims it to what the assistant needs and says how current it is.
import type { Entry } from '../analysis'
import { buildExport, type ExportedMetric, type ExportedScenario } from '../export'
import { COMPARE_SECTIONS } from '../sections'
import type { PairEvidence, RankingGroup } from '../types'

export const ASSISTANT_CONTEXT_VERSION = 'comparison-assistant-context-v1'

/** empty: nothing selected · loading: results being computed · updating: ranking being recomputed · ready: all current */
export type ContextState = 'empty' | 'loading' | 'updating' | 'ready'

type Compact<T> = { [K in keyof T]?: T[K] }

export interface AssistantScenario {
  label: string
  name: string
  origin: string
  site: ExportedScenario['site']
  landing_utc: string
  duration_days: number
  requirements: ExportedScenario['requirements']
  spacecraft: ExportedScenario['spacecraft']
  result: 'not_requested' | 'loading' | 'done' | 'error'
  data_kind: string | null
  eligibility: ExportedScenario['eligibility']
  canonical_rank: number | null
  ranking_group: string | null
  recommended: boolean
  score: ExportedScenario['score'] | null
  overall_risk: string | null
  failed_requirements: string[]
  undecided_requirements: string[]
  requirements_checked: { name: string; status: string; comparison: string | null; threshold: number | null; measured: Compact<ExportedMetric> }[]
  metrics: Record<string, Compact<ExportedMetric>>
  ranking_explanation: string | null
  message: string | null
}

export interface AssistantContext {
  format: typeof ASSISTANT_CONTEXT_VERSION
  page: 'scenario-comparison'
  state: ContextState
  selected: string[] // scenario letters, in page order
  ranking_method: string | null
  ranking_groups: ReturnType<typeof buildExport>['ranking_groups']
  decisions: ReturnType<typeof buildExport>['decisions']
  scenarios: AssistantScenario[]
  notes: string[]
  sections: { id: string; label: string }[]
}

/** A metric without its empty fields (null bounds etc.): smaller, and nothing missing is turned into a number. */
function compact(m: ExportedMetric): Compact<ExportedMetric> {
  const out: Compact<ExportedMetric> = { status: m.status }
  if (m.unit) out.unit = m.unit
  if (m.value !== null) out.value = m.value
  if (m.lower !== null) out.lower = m.lower
  if (m.upper !== null) out.upper = m.upper
  return out
}

export function contextState(entries: Entry[], ready: boolean): ContextState {
  if (!entries.length) return 'empty'
  if (entries.some((e) => !e.state || e.state.state === 'loading')) return 'loading'
  return ready ? 'ready' : 'updating'
}

export function buildAssistantContext(entries: Entry[], groups: RankingGroup[], pairs: PairEvidence[], notes: string[], ready: boolean): AssistantContext {
  const state = contextState(entries, ready)
  const x = buildExport(entries, ready ? groups : [], ready ? pairs : [], notes)
  const scenarios = x.scenarios.map((s, i): AssistantScenario => {
    const st = entries[i]?.state
    return {
      label: s.label,
      name: s.name,
      origin: s.origin,
      site: s.site,
      landing_utc: s.landing_utc,
      duration_days: s.duration_days,
      requirements: s.requirements,
      spacecraft: s.spacecraft,
      result: st ? st.state : 'not_requested',
      data_kind: s.data.kind,
      eligibility: s.eligibility,
      canonical_rank: s.canonical_rank,
      ranking_group: s.ranking_group,
      recommended: s.recommended,
      score: s.score.status ? s.score : null,
      overall_risk: s.overall_risk,
      failed_requirements: s.failed_requirements,
      undecided_requirements: s.undecided_requirements,
      requirements_checked: s.requirement_verdicts.filter((r) => r.status !== 'not_applicable')
        .map((r) => ({ name: r.name, status: r.status, comparison: r.comparison, threshold: r.threshold, measured: compact(r.measured) })),
      metrics: Object.fromEntries(Object.entries(s.metrics).map(([k, m]) => [k, compact(m)])),
      ranking_explanation: s.ranking_explanation,
      message: s.message,
    }
  })
  return {
    format: ASSISTANT_CONTEXT_VERSION,
    page: 'scenario-comparison',
    state,
    selected: entries.map((e) => e.scenario.label),
    ranking_method: x.ranking_method,
    ranking_groups: x.ranking_groups,
    decisions: x.decisions,
    scenarios,
    notes: [...new Set(x.notes)].slice(0, 16),
    sections: COMPARE_SECTIONS.map(([id, label]) => ({ id, label })),
  }
}

/**
 * What the assistant's answers depend on, as one comparable string: which scenarios, their inputs, their results
 * and how current those are. When it changes between two questions, the chat says the comparison has changed.
 */
export function contextSignature(c: AssistantContext): string {
  return JSON.stringify([c.state, c.scenarios.map((s) => [s.label, s.site.id, s.landing_utc, s.duration_days, s.requirements,
    s.spacecraft, s.result, s.eligibility, s.canonical_rank, s.recommended])])
}

/** One line for the panel: what the assistant is reading right now. */
export function contextLine(c: AssistantContext): string {
  if (c.state === 'empty') return 'No scenarios selected'
  const names = c.scenarios.map((s) => `${s.label} (${s.site.name})`).join(', ')
  const when = c.state === 'ready' ? 'results up to date' : c.state === 'loading' ? 'results loading…' : 'ranking updating…'
  return `${names} · ${when}`
}
