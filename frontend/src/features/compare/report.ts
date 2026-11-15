// Summary report: an immutable, detached snapshot of exactly the evaluated comparison at generation time. The report
// preview renders only from this snapshot, and its JSON download is this snapshot, so the human-readable report and
// the machine-readable export always describe the same scenarios, revisions and results. Changing the live
// comparison afterwards never changes an open report; it is flagged as out of date and can be regenerated.
import { create } from 'zustand'

import { eligibilityOf, groupCountOf, type Entry } from './analysis'
import { buildDecision, findPair, tradeoffSentence, withLabels } from './decision'
import {
  comparability,
  coverageOf,
  decisiveCell,
  DECISIVE_ROWS,
  DECISION_LABEL,
  keyConstraint,
  preferenceStrength,
  rankLine,
  rolesOf,
  type DecisiveCell,
} from './decisionView'
import { comparisonView } from './entries'
import { buildExport, exportMissionTime, type ComparisonExport, type ExportContext, type ExportedMissionTime } from './export'
import { resultKey } from './scenario'
import type { CompareState } from './useCompareStore'
import { useCompareStore } from './useCompareStore'

export const REPORT_FORMAT = 'summary-report-v1'

export interface ReportMission {
  kind: 'guided' | 'rescue' | 'manual'
  title: string | null
  objective: string | null
  mission_id: string | null
  mission_version: number | null
  change: string[]
}

export interface ReportGroup {
  id: string
  primary: boolean
  separate_reason: string | null
  label: string // "Recommended", "Several pass: preference not established", ...
  kind: string
  recommended: string | null // scenario label, only when supported
  headline: string
  requirements: string[]
  evidence: string[]
  engine_text: string | null
  tradeoffs: string[]
  uncertainty: string[]
  pairs: { a: string; b: string; deciding: string | null; tie_break: boolean; score_difference: string; components: { label: string; favours: string }[]; statement: string }[]
}

export interface ReportScenarioRow {
  label: string
  role: string | null
  name: string
  site: string
  landing_utc: string // REQUESTED landing (the evaluated window is mission_time)
  duration_days: number // REQUESTED duration
  mission_time: ExportedMissionTime // evaluated window (null fields when nothing was evaluated) beside the request
  verdict: 'pass' | 'fail' | 'unknown' | null
  status_text: string // "Assessed", "Not assessed: …", "Error: …"
  rank: string
  key: string | null // the failing / undecided requirement or the tightest margin, in words
  coverage: number | null
}

export interface ReportSnapshot {
  report_format: typeof REPORT_FORMAT
  snapshot_id: string
  generated_at: string
  selection: { key: string; labels: string[]; scenario_ids: string[]; revisions: string[] }
  mission: ReportMission
  scenarios: ReportScenarioRow[]
  same_requirements: boolean
  comparability_note: string | null
  decisions: ReportGroup[]
  decisive: { label: string; hint: string; cells: Record<string, DecisiveCell> }[]
  baseline: string | null
  unassessed: { label: string; reason: string }[]
  main_uncertainty: string
  limitations: string[]
  export: ComparisonExport
}

/** Everything that identifies the evaluated selection: scenario revisions (inputs), data mode and the ranking set. */
export function selectionKeyOf(s: Pick<CompareState, 'scenarios' | 'selectedIds' | 'allowDemo' | 'rankingSetKey' | 'results'>): string {
  const sel = s.selectedIds.map((id) => s.scenarios.find((x) => x.id === id)).filter((x) => !!x)
  const parts = sel.map((x) => {
    const k = resultKey(x!, s.allowDemo)
    const st = s.results[k]?.state ?? 'none'
    return `${x!.id}=${k}#${st}`
  })
  return JSON.stringify([parts, s.allowDemo, s.rankingSetKey])
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v)
  }
  return o
}

const L = (e: Entry) => e.scenario.label

/** Build the detached snapshot. Callers must only pass a settled view (no loading plans, ranking current). */
export function buildSnapshot(input: {
  entries: Entry[]
  groups: CompareState['rankingGroups']
  pairs: CompareState['rankingPairs']
  notes: string[]
  selectionKey: string
  mission: ReportMission
  roles: Record<string, string>
  ctx: Omit<ExportContext, 'selectionKey' | 'snapshotId' | 'roles' | 'story'>
  baselineId: string | null
  now?: Date
}): ReportSnapshot {
  const { entries, groups, pairs, notes, mission, roles } = input
  const now = input.now ?? new Date()
  const snapshotId = `rpt-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${hash(input.selectionKey)}`
  const decision = buildDecision(entries, groups, pairs)
  const base = entries.find((e) => e.scenario.id === input.baselineId && e.result) ?? null
  const comp = comparability(entries)
  const groupCount = groupCountOf(entries)
  const roleOf = (e: Entry) => roles[e.scenario.id] ?? null
  const labelled = (t: string) => withLabels(t, entries, pairs)

  const decisions: ReportGroup[] = decision.groups.map((d) => {
    const strength = preferenceStrength(d, pairs)
    const kind = d.kind === 'recommended' && strength !== 'established' ? 'unresolved' : d.kind
    const members = d.requirements.map((r) => r.entry)
    const pairRows: ReportGroup['pairs'] = []
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const p = findPair(pairs, members[i], members[j])
        if (!p) continue
        const sel = entries.find((e) => e.result?.key === p.selected), comp2 = entries.find((e) => e.result?.key === p.competitor)
        if (!sel || !comp2) continue
        const sd = p.score_difference
        const range = sd.lower !== null && sd.upper !== null ? ` [${sd.lower.toFixed(2)}, ${sd.upper.toFixed(2)}] points` : ''
        pairRows.push({
          a: L(sel), b: L(comp2), deciding: p.deciding_criterion, tie_break: p.policy_tie_break,
          score_difference: `${sd.status.replace(/_/g, ' ')}${range}`,
          components: p.components.filter((c) => c.advantage === 'selected' || c.advantage === 'competitor')
            .map((c) => ({ label: c.label, favours: c.advantage === 'selected' ? L(sel) : L(comp2) })),
          statement: labelled(p.explanation),
        })
      }
    }
    return {
      id: d.group.id, primary: d.group.primary, separate_reason: d.group.separate_reason,
      label: DECISION_LABEL[kind], kind,
      recommended: (d.kind === 'recommended' || d.kind === 'single_pass') && d.recommended ? L(d.recommended) : null,
      headline: d.headline, requirements: d.requirements.map((r) => r.text), evidence: d.evidence,
      engine_text: d.engineText, tradeoffs: d.tradeoffs.map(tradeoffSentence), uncertainty: d.uncertainty, pairs: pairRows,
    }
  })

  const scenarios: ReportScenarioRow[] = entries.map((e) => {
    const st = e.state
    const status_text = !st ? 'Not assessed' : st.state === 'error' ? `Error: ${st.message}` : st.state === 'loading' ? 'Not assessed (still loading)'
      : e.result ? (e.result.assessment ? 'Assessed by the canonical engine' : 'Evaluated without a canonical assessment')
        : `Not assessed: ${st.result.message ?? 'no data for this site and date range'}`
    return {
      label: L(e), role: roleOf(e), name: e.scenario.name, site: e.scenario.site.name,
      landing_utc: e.scenario.landing_utc, duration_days: e.scenario.duration_days, mission_time: exportMissionTime(e),
      verdict: e.result?.assessment ? eligibilityOf(e) : null, status_text, rank: rankLine(e, groupCount),
      key: keyConstraint(e)?.text ?? null, coverage: coverageOf(e),
    }
  })

  const decisive = DECISIVE_ROWS.map((row) => ({
    label: row.label, hint: row.hint,
    cells: Object.fromEntries(entries.filter((e) => e.result).map((e) => [L(e), decisiveCell(row, e, base)])),
  }))

  const unassessed = scenarios.filter((s) => s.verdict === null).map((s) => ({ label: s.label, reason: s.status_text }))
  // The main uncertainty is about the evidence itself (coverage, undecided plans, bounds), not the generic score caveat.
  const minCov = Math.min(...scenarios.map((s) => s.coverage ?? 100))
  const specific = decisions.flatMap((d) => d.uncertainty).find((u) => !/^The score is a relative/.test(u))
  const main_uncertainty = minCov < 100
    ? `Real data covers as little as ${minCov.toFixed(1)}% of a mission; values over the gaps are bounds, not measurements.`
    : specific ?? 'Every verdict rests on hourly geometric samples of real ephemeris and terrain data: events shorter than an hour can be missed, and geometric visibility is neither a power budget nor a radio-link budget. Close margins deserve a finer check before commitment.'
  const limitations = [...new Set(entries.flatMap((e) => e.result?.assessment?.limitations ?? []))]

  const exp = buildExport(entries, groups, pairs, notes, now, {
    ...input.ctx, selectionKey: input.selectionKey, snapshotId, roles,
    story: { kind: mission.kind, mission_id: mission.mission_id, mission_version: mission.mission_version, title: mission.title, change: mission.change },
    baselineLabel: base ? L(base) : null,
  })

  const snap: ReportSnapshot = {
    report_format: REPORT_FORMAT,
    snapshot_id: snapshotId,
    generated_at: now.toISOString(),
    selection: { key: input.selectionKey, labels: entries.map(L), scenario_ids: entries.map((e) => e.scenario.id), revisions: entries.map((e) => resultKey(e.scenario, input.ctx.allowDemo ?? false)) },
    mission,
    scenarios,
    same_requirements: comp.sameRequirements,
    comparability_note: comp.note,
    decisions,
    decisive,
    baseline: base ? L(base) : null,
    unassessed,
    main_uncertainty,
    limitations,
    export: exp,
  }
  // Detached (no shared references with the live stores) and immutable.
  return deepFreeze(structuredClone(snap))
}

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------- store

/** Lets the guided mission describe its own selection (title, objective, definition id) in the report. */
export const reportHooks: { mission?: (scenarioIds: string[]) => ReportMission | null } = {}

export type GenerateResult = { ok: true } | { ok: false; reason: string }

interface ReportState {
  snapshot: ReportSnapshot | null
  open: boolean
  generate: () => GenerateResult
  close: () => void
  reopen: () => void
}

/** Why a report cannot be generated from the live comparison right now, or null. */
export function cannotGenerate(s: CompareState = useCompareStore.getState()): string | null {
  const v = comparisonView(s)
  if (!v.selected.length) return 'Select at least one scenario to report on.'
  if (v.loading) return 'Wait until every selected scenario has been assessed.'
  if (!v.rankingCurrent && v.entries.some((e) => e.state?.state === 'done')) return 'The canonical ranking is being updated for this selection.'
  return null
}

export const useReportStore = create<ReportState>((set) => ({
  snapshot: null,
  open: false,
  generate: () => {
    const s = useCompareStore.getState()
    const why = cannotGenerate(s)
    if (why) return { ok: false, reason: why }
    const v = comparisonView(s)
    const roleInfo = rolesOf(s.rescueContext, v.entries)
    const roles = Object.fromEntries(Object.entries(roleInfo).map(([id, r]) => [id, r.label]))
    const ids = v.selected.map((x) => x.id)
    const guided = reportHooks.mission?.(ids) ?? null
    const mission: ReportMission = guided ?? (Object.keys(roleInfo).length && s.rescueContext
      ? { kind: 'rescue', title: 'Mission Rescue decision', objective: null, mission_id: null, mission_version: null, change: s.rescueContext.change }
      : { kind: 'manual', title: null, objective: null, mission_id: null, mission_version: null, change: [] })
    const snapshot = buildSnapshot({
      entries: v.entries, groups: v.groups, pairs: v.pairs, notes: s.notes, selectionKey: selectionKeyOf(s), mission, roles,
      ctx: {
        allowDemo: s.allowDemo, timePolicy: s.timePolicy,
        preferences: { weights: { ...s.weights }, traverse_km: s.traverseKm },
        revisions: Object.fromEntries(v.selected.map((x) => [x.id, resultKey(x, s.allowDemo)])),
      },
      baselineId: s.baselineId,
    })
    set({ snapshot, open: true })
    return { ok: true }
  },
  close: () => set({ open: false }),
  reopen: () => set((st) => ({ open: !!st.snapshot })),
}))
