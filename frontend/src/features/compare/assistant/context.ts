// The structured context the Mission Assistant receives: the comparison exactly as the page shows it right now.
//
// Verdicts, ranks, groups and the recommendation come from buildExport(), which already enforces the comparison's
// integrity rules (UNKNOWN stays unknown, canonical ranks only for eligible PASS scenarios in their group,
// "recommended" only from the decision panel). Figures come from the same tables the page renders (At a glance,
// Key metrics, Requirements), as display text with units, so the assistant quotes what the user sees and a missing
// value reads "unavailable", never 0.
import { formatMarginMetric } from '../../../lib/headroom'
import { METRICS, bestIds, fmtMetric, requirementMatrix, type Entry } from '../analysis'
import { buildExport, type ExportedScenario } from '../export'
import { HEADLINES, headlineRows } from '../glance'
import { COMPARE_SECTIONS } from '../sections'
import type { PairEvidence, RankingGroup } from '../types'

export const ASSISTANT_CONTEXT_VERSION = 'comparison-assistant-context-v2'

/** empty: nothing selected · loading: results being computed · updating: ranking being recomputed · ready: all current */
export type ContextState = 'empty' | 'loading' | 'updating' | 'ready'

/** Display text per scenario letter. */
type ByScenario<T = string> = Record<string, T>

export interface AssistantScenario {
  label: string
  name: string
  origin: string // user | duplicate | preset | rescue | external
  site: ExportedScenario['site']
  landing_utc: string
  duration_days: number
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
  ranking_explanation: string | null
  message: string | null
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
  notes: string[]
  sections: { id: string; label: string }[]
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

export function buildAssistantContext(entries: Entry[], groups: RankingGroup[], pairs: PairEvidence[], notes: string[], ready: boolean): AssistantContext {
  const state = contextState(entries, ready)
  const x = buildExport(entries, ready ? groups : [], ready ? pairs : [], notes)
  const labelOf = new Map(entries.map((e) => [e.scenario.id, e.scenario.label]))
  const L = (id: string) => labelOf.get(id) ?? id

  const scenarios = x.scenarios.map((s, i): AssistantScenario => {
    const st = entries[i]?.state
    return {
      label: s.label,
      name: s.name,
      origin: s.origin,
      site: s.site,
      landing_utc: s.landing_utc,
      duration_days: s.duration_days,
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
  scenarios.map((s) => [s.eligibility, s.canonical_rank, s.recommended])]))

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
    notes: [...new Set(x.notes)].slice(0, 16),
    sections: COMPARE_SECTIONS.map(([id, label]) => ({ id, label })),
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
