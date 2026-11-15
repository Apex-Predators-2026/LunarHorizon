// "Try a mission": a guided decision workflow over the real tools. A small orchestration store: it owns only the stage,
// a request token, and the ids of what it created (the saved plan and the comparison scenarios). Every scientific
// result stays in its own store (assessment, Mission Rescue, comparison) and is read from there; nothing is copied.
//
//   Your mission -> The original plan -> A launch delay -> What changed -> Inspect the evidence -> Find a recovery
//   -> Make the decision (Comparison) -> Export the decision
//
// The mission comes from a versioned definition (missions/*.json). A stage only narrates what the live result says:
// when the current engine no longer reproduces the verified baseline the stage reports an outdated example.
import { create } from 'zustand'

import { goTo, useNav, type View } from './nav'
import type { Scenario } from '../../types'
import { clearEvidence, showEvidence, useEvidence } from '../../viz/evidence'
import { evidenceForConstraint } from '../assessment/logic'
import type { Assessment, AssessResponse, ConstraintEvaluation } from '../assessment/types'
import { scenarioKey, useAssessmentStore, type AssessState } from '../assessment/useAssessmentStore'
import { buildDecision } from '../compare/decision'
import { reportHooks, useReportStore } from '../compare/report'
import { comparisonView, type ComparisonView } from '../compare/entries'
import { eligibilityOf } from '../compare/analysis'
import { describeChange, type RescueContext } from '../compare/rescueFlow'
import { resultKey } from '../compare/scenario'
import { sendToComparison, useCompareStore } from '../compare/useCompareStore'
import { openScenarioInPlanner } from './openPlan'
import type { RescueResponse } from '../rescue/types'
import { useRescueStore } from '../rescue/useRescueStore'
import {
  checkDisrupted,
  checkOriginal,
  disruptedScenario,
  evidenceWindow,
  headroom,
  limitText,
  measuredText,
  MISSION,
  originalScenario,
  recoveryCandidates,
  rescueMatches,
  statusChanges,
  utcText,
} from './missionDefinition'

export type StageId = 'mission' | 'original' | 'delay' | 'changed' | 'evidence' | 'rescue' | 'compare' | 'report'

export interface StageDef {
  id: StageId
  title: string
  short: string // progress label
  view: View // where the stage happens
}

export const STAGES: StageDef[] = [
  { id: 'mission', title: 'Your mission', short: 'Mission', view: 'planner' },
  { id: 'original', title: 'The original plan', short: 'Plan', view: 'planner' },
  { id: 'delay', title: 'A launch delay', short: 'Delay', view: 'planner' },
  { id: 'changed', title: 'What changed', short: 'Change', view: 'planner' },
  { id: 'evidence', title: 'Inspect the evidence', short: 'Evidence', view: 'planner' },
  { id: 'rescue', title: 'Find a recovery', short: 'Rescue', view: 'planner' },
  { id: 'compare', title: 'Make the decision', short: 'Decide', view: 'compare' },
  { id: 'report', title: 'Export the decision', short: 'Report', view: 'compare' },
]

export const stageIndex = (id: StageId) => STAGES.findIndex((s) => s.id === id)

export const EVIDENCE_ORIGIN = 'Try a mission'

interface GuideState {
  active: boolean
  stage: number
  /** Bumped on every stage entry, restart and exit: an older async step never writes over a newer one. */
  run: number
  /** A failed orchestration action of the current stage (request failures are read from their stores). */
  error: string | null
  planId: string | null
  /** Comparison scenarios this story created (removed again on restart; never anything else). */
  compareIds: string[]
  /** resultKey of each created comparison scenario at import: a different key = the user edited it. */
  compareKeys: Record<string, string>
  recovery: Scenario | null
  evidenceShown: boolean
  /** Set when the report / export stage has been reached for the imported selection. */
  reportOpened: boolean
  /** Activate the story (fresh state, new run) without entering a stage or navigating: the guided tour drives `go`. */
  begin: () => void
  /** begin() then go(0). */
  start: () => void
  /** Enter stage `i`; resolves once the stage's entry has settled (failures are already caught into `error`). */
  go: (i: number) => Promise<void>
  next: () => void
  back: () => void
  /** Re-run the current stage's failed request; resolves like go(). */
  retry: () => Promise<void>
  /** Stop the stage that is entering (it no longer writes or navigates) but stay active. */
  pause: () => void
  exit: () => void
  restart: () => void
}

const initial = {
  active: false, stage: 0, run: 0, error: null, planId: null, compareIds: [] as string[], compareKeys: {} as Record<string, string>,
  recovery: null, evidenceShown: false, reportOpened: false,
}

/** The report stage opens the summary report for the evaluated comparison (compare/report.ts). */
export const stageHooks: { openReport?: () => boolean } = {
  openReport: () => {
    const st = useReportStore.getState()
    const r = st.generate()
    return r.ok
  },
}

// A report generated for the story's own three plans names the mission definition it came from.
reportHooks.mission = (ids) => {
  const g = useGuide.getState()
  if (!g.compareIds.length || ids.length !== g.compareIds.length || !g.compareIds.every((id) => ids.includes(id))) return null
  return {
    kind: 'guided', title: MISSION.title, objective: MISSION.objective, mission_id: MISSION.id, mission_version: MISSION.version,
    change: [MISSION.disruption.description],
  }
}

// ---------------------------------------------------------------- helpers over the shared stores

const assessed = (s: Scenario | null): AssessState | undefined => (s ? useAssessmentStore.getState().results[scenarioKey(s)] : undefined)
const done = (st: AssessState | undefined): AssessResponse | null => (st?.status === 'done' ? st.response : null)

/** Resolve once the canonical assessment of `s` has settled (done or error), starting it if needed. No timeout:
 * the stage stays "working" until the result is really there; the card offers retry / exit if it takes long. */
export function waitForAssessment(s: Scenario): Promise<void> {
  const key = scenarioKey(s)
  const pending = () => {
    const st = useAssessmentStore.getState().results[key]
    return !st || st.status === 'loading'
  }
  void useAssessmentStore.getState().assess(s)
  if (!pending()) return Promise.resolve()
  return new Promise((resolve) => {
    const unsub = useAssessmentStore.subscribe(() => {
      if (pending()) return
      unsub()
      resolve()
    })
  })
}

const rescueOf = (): RescueResponse | null => useRescueStore.getState().rescue

/** Is the Rescue result in the store the one for this story's original plan and delay? */
function rescueIsCurrent(): boolean {
  const s = useRescueStore.getState()
  if (!s.rescue || s.rescueStatus !== 'done') return false
  return scenarioKey(s.rescue.original.scenario) === scenarioKey(originalScenario()) && rescueMatches(s.rescue).ok
}

function showStoryEvidence(): boolean {
  const a = done(assessed(disruptedScenario()))?.assessment
  if (!a) return false
  const { constraint } = evidenceWindow(a)
  const ev = constraint ? evidenceForConstraint(a, constraint) : null
  if (!constraint || !ev) return false
  useAssessmentStore.getState().setTarget('changed')
  useAssessmentStore.getState().setShowing(`${scenarioKey(disruptedScenario())}|${constraint.constraint_id}`)
  const r = showEvidence({ ...ev.request, origin: { kind: 'guide', label: EVIDENCE_ORIGIN } })
  return r.ok
}

export function showStoryEvidenceAgain() {
  goTo('planner')
  const ok = showStoryEvidence()
  useGuide.setState({ evidenceShown: ok, error: ok ? null : 'The evidence could not be opened in the 3D view.' })
}

function resetChange() {
  useRescueStore.getState().setChange({ launch_delay_days: 0, new_duration_days: null, requirement_overrides: {}, reason: null })
}

function applyDelay() {
  const d = MISSION.disruption
  useRescueStore.getState().setChange({ launch_delay_days: d.launch_delay_days, new_duration_days: null, requirement_overrides: {}, reason: d.reason })
}

/** Remove only what the story created in the comparison (and its Rescue context). */
function removeOwnedComparison(ids: string[]) {
  const cs = useCompareStore.getState()
  for (const id of ids) if (cs.scenarios.some((s) => s.id === id)) useCompareStore.getState().removeScenario(id)
  const ctx = useCompareStore.getState().rescueContext
  if (ctx && Object.keys(ctx.roles).some((id) => ids.includes(id))) useCompareStore.getState().setRescueContext(null)
}

function importIntoComparison(res: RescueResponse, recovery: Scenario) {
  const g = useGuide.getState()
  removeOwnedComparison(g.compareIds)
  const cs = useCompareStore.getState()
  if (cs.allowDemo) cs.setAllowDemo(false) // the story is real data only (mission definition data_mode)
  const pick = res.alternatives.find((a) => scenarioKey(a.scenario) === scenarioKey(recovery))
  const original = originalScenario()
  const changed = res.changed.scenario
  const ids = sendToComparison([original, changed, recovery], {
    origin: 'rescue',
    names: [`Original plan · ${original.site.name}`, `After the delay · ${changed.site.name}`, `Recovery · ${recovery.site.name}`],
    notes: [
      `${MISSION.title}: the plan before the delay (definition ${MISSION.id} v${MISSION.version}).`,
      MISSION.disruption.description,
      pick?.headline ?? 'Mission Rescue recovery',
    ],
    baselineIndex: 0,
    replaceSelection: true,
  })
  const v = (x: { eligibility: 'pass' | 'fail' | 'unknown' | null; passes: boolean }) => x.eligibility ?? (x.passes ? 'pass' : 'fail')
  const ctx: RescueContext = {
    importedAt: new Date().toISOString(),
    status: res.status,
    summary: res.summary,
    change: describeChange(useRescueStore.getState().change),
    roles: {
      [ids[0]]: { role: 'original', rescueVerdict: v(res.original) },
      [ids[1]]: { role: 'changed', rescueVerdict: v(res.changed) },
      [ids[2]]: { role: 'alternative', rank: pick?.rank, kind: pick?.kind, headline: pick?.headline, rescueVerdict: pick ? v(pick.viability) : null },
    },
  }
  useCompareStore.getState().setRescueContext(ctx)
  const after = useCompareStore.getState()
  const keys = Object.fromEntries(ids.map((id) => [id, resultKey(after.scenarios.find((s) => s.id === id)!, after.allowDemo)]))
  useGuide.setState({ compareIds: ids, compareKeys: keys })
}

// ---------------------------------------------------------------- stage entry (side effects only, results stay in their stores)

type Enter = (token: number) => void | Promise<void>
const live = (token: number) => useGuide.getState().active && useGuide.getState().run === token

const ENTER: Record<StageId, Enter> = {
  mission: () => {
    clearEvidence()
    const st = useRescueStore.getState()
    const cur = st.original ? scenarioKey(st.original) : null
    if (cur !== scenarioKey(originalScenario())) {
      const id = openScenarioInPlanner(originalScenario(), MISSION.original.name)
      useGuide.setState({ planId: id })
    } else goTo('planner')
    useRescueStore.getState().setSearch(MISSION.search)
    void useAssessmentStore.getState().assess(originalScenario()) // starts early; the next stage waits for it
  },
  original: async (token) => {
    goTo('planner')
    clearEvidence()
    resetChange()
    useAssessmentStore.getState().setTarget('original')
    await waitForAssessment(originalScenario())
    if (live(token)) useAssessmentStore.getState().setTarget('original')
  },
  delay: async (token) => {
    goTo('planner')
    clearEvidence()
    // Through the normal mission-change control: Mission Rescue's "Plan change" form shows the same delay.
    if (!rescueIsCurrent()) useRescueStore.setState({ rescue: null, rescueStatus: 'idle', selected: null })
    applyDelay()
    useAssessmentStore.getState().setTarget('changed')
    await waitForAssessment(disruptedScenario())
    if (live(token)) useAssessmentStore.getState().setTarget('changed')
  },
  changed: async (token) => {
    goTo('planner')
    clearEvidence()
    applyDelay()
    useRescueStore.setState({ selected: null })
    useAssessmentStore.getState().setTarget('changed')
    await waitForAssessment(disruptedScenario())
    if (live(token)) useAssessmentStore.getState().setTarget('changed')
  },
  evidence: async (token) => {
    useGuide.setState({ evidenceShown: false })
    goTo('planner')
    applyDelay()
    useRescueStore.setState({ selected: null })
    await waitForAssessment(disruptedScenario())
    if (!live(token)) return
    const ok = showStoryEvidence()
    useGuide.setState({ evidenceShown: ok, error: ok ? null : 'The evidence could not be opened: the engine reported no window for the failing requirement.' })
  },
  rescue: async (token) => {
    goTo('planner')
    clearEvidence()
    useAssessmentStore.getState().clearShowing()
    applyDelay()
    const rs = useRescueStore.getState()
    rs.setSearch(MISSION.search)
    if (!rescueIsCurrent()) {
      await rs.findAlternatives()
      if (!live(token)) return
    }
    const res = rescueOf()
    if (!res || useRescueStore.getState().rescueStatus !== 'done' || !rescueMatches(res).ok) return // the card shows why
    const pick = recoveryCandidates(res)[0]?.scenario ?? null
    useGuide.setState({ recovery: pick })
    if (!pick) return
    useRescueStore.getState().select(pick)
    useAssessmentStore.getState().setTarget('selected')
    await waitForAssessment(pick)
  },
  compare: (token) => {
    clearEvidence()
    const g = useGuide.getState()
    const res = rescueOf()
    if (!res || !g.recovery) {
      useGuide.setState({ error: 'Run the recovery search first: go back one step.' })
      return
    }
    // Re-import only when the story's comparison set is gone or was edited (Back / Forward keeps one set).
    if (comparisonIntegrity(g) !== null || !g.compareIds.length) importIntoComparison(res, g.recovery)
    if (live(token)) goTo('compare')
  },
  report: () => {
    goTo('compare')
    const opened = stageHooks.openReport?.() ?? false
    useGuide.setState({ reportOpened: opened })
  },
}

// ---------------------------------------------------------------- the store

export const useGuide = create<GuideState>((set, get) => ({
  ...initial,
  begin: () => {
    // A fresh run: the comparison plans an earlier run imported are removed first, so they are never duplicated.
    removeOwnedComparison(get().compareIds)
    set({ ...initial, active: true, run: get().run + 1 })
  },
  start: () => {
    get().begin()
    void get().go(0)
  },
  go: (i) => {
    const stage = Math.max(0, Math.min(STAGES.length - 1, i))
    const run = get().run + 1
    set({ stage, run, error: null })
    const id = STAGES[stage].id
    return Promise.resolve(ENTER[id](run)).catch((e: unknown) => {
      if (live(run)) set({ error: e instanceof Error ? e.message : String(e) })
    })
  },
  next: () => void get().go(get().stage + 1),
  back: () => void get().go(get().stage - 1),
  retry: () => {
    const id = STAGES[get().stage].id
    // Re-run the failed request of this stage, then the stage itself.
    if (id === 'original') useAssessmentStore.setState((s) => ({ results: dropKey(s.results, scenarioKey(originalScenario())) }))
    if (id === 'delay' || id === 'changed' || id === 'evidence') useAssessmentStore.setState((s) => ({ results: dropKey(s.results, scenarioKey(disruptedScenario())) }))
    if (id === 'rescue') {
      useRescueStore.setState({ rescue: null, rescueStatus: 'idle', rescueError: null })
      const r = get().recovery
      if (r) useAssessmentStore.setState((s) => ({ results: dropKey(s.results, scenarioKey(r)) }))
    }
    if (id === 'compare') void useCompareStore.getState().refresh()
    return get().go(get().stage)
  },
  pause: () => set({ run: get().run + 1 }),
  exit: () => {
    // Stop orchestrating; everything the user can see stays as it is for normal exploration.
    if (useEvidence.getState().request?.origin?.label === EVIDENCE_ORIGIN) clearEvidence()
    set({ active: false, run: get().run + 1, error: null })
  },
  restart: () => {
    const g = get()
    set({ run: g.run + 1 })
    // Reset only what the story owns: its comparison scenarios, its Rescue run, its delay, its evidence.
    removeOwnedComparison(g.compareIds)
    if (useEvidence.getState().request?.origin?.label === EVIDENCE_ORIGIN) clearEvidence()
    useAssessmentStore.getState().clearShowing()
    const rs = useRescueStore.getState()
    if (rs.original && scenarioKey(rs.original) === scenarioKey(originalScenario())) {
      rs.reset()
      resetChange()
    }
    get().start()
  },
}))

function dropKey<T>(o: Record<string, T>, k: string): Record<string, T> {
  const { [k]: _, ...rest } = o
  void _
  return rest
}

// ---------------------------------------------------------------- what the card shows (pure; read from the stores)

export type StageStatus = 'working' | 'ready' | 'error' | 'outdated' | 'modified' | 'elsewhere'

export interface Fact {
  label: string
  value: string
  tone?: 'pass' | 'fail' | 'unknown' | 'neutral'
}

export interface ChangeRow {
  name: string
  before: string
  after: string
  limit: string
  from: 'pass' | 'fail' | 'unknown' | 'not_applicable'
  to: 'pass' | 'fail' | 'unknown' | 'not_applicable'
}

export interface StageModel {
  status: StageStatus
  lead: string
  facts: Fact[]
  rows: ChangeRow[]
  note: string | null
  primary: { label: string; action: 'next' | 'retry' | 'view' | 'finish' | 'restart'; disabled?: boolean }
  secondary: { label: string; action: 'evidence' | 'report' | 'section' }[]
}

export interface Snapshot {
  guide: Pick<GuideState, 'stage' | 'error' | 'recovery' | 'evidenceShown' | 'reportOpened' | 'compareIds' | 'compareKeys'>
  view: View
  results: Record<string, AssessState>
  rescue: { original: Scenario | null; change: { launch_delay_days?: number; new_duration_days?: number | null; requirement_overrides?: object }; status: string; error: string | null; response: RescueResponse | null }
  comparison: ComparisonView & { allowDemo: boolean; scenarioKeys: Record<string, string> }
  evidenceProblem: string | null
  /** The 3D view is showing this story's evidence right now. */
  evidenceVisible: boolean
}

export function snapshot(): Snapshot {
  const g = useGuide.getState()
  const r = useRescueStore.getState()
  const c = useCompareStore.getState()
  return {
    guide: g,
    view: useNav.getState().view,
    results: useAssessmentStore.getState().results,
    rescue: { original: r.original, change: r.change, status: r.rescueStatus, error: r.rescueError, response: r.rescue },
    comparison: {
      ...comparisonView(c), allowDemo: c.allowDemo,
      scenarioKeys: Object.fromEntries(c.scenarios.filter((s) => g.compareIds.includes(s.id)).map((s) => [s.id, resultKey(s, c.allowDemo)])),
    },
    evidenceProblem: useEvidence.getState().problem?.message ?? null,
    evidenceVisible: useEvidence.getState().highlight?.origin?.label === EVIDENCE_ORIGIN,
  }
}

/** null when the story's comparison set is intact; otherwise what was changed. */
function comparisonIntegrity(g: Pick<GuideState, 'compareIds' | 'compareKeys'>, snap?: Snapshot): string | null {
  if (!g.compareIds.length) return null
  const c = snap?.comparison ?? { ...comparisonView(useCompareStore.getState()), allowDemo: useCompareStore.getState().allowDemo,
    scenarioKeys: Object.fromEntries(useCompareStore.getState().scenarios.map((s) => [s.id, resultKey(s, useCompareStore.getState().allowDemo)])) }
  for (const id of g.compareIds) {
    if (!(id in c.scenarioKeys)) return 'One of the imported plans was removed from the comparison.'
    if (c.scenarioKeys[id] !== g.compareKeys[id]) return 'One of the imported plans was edited in the comparison.'
  }
  const sel = c.selected.map((s) => s.id)
  if (sel.length !== g.compareIds.length || !g.compareIds.every((id) => sel.includes(id))) return 'The comparison selection changed: it no longer holds exactly the three plans of the story.'
  return null
}

const word = (e: string | null | undefined) => (e === 'pass' ? 'PASSES' : e === 'fail' ? 'FAILS' : e === 'unknown' ? 'CANNOT BE DECIDED' : 'is not assessed')
const tone = (e: string | null | undefined): Fact['tone'] => (e === 'pass' ? 'pass' : e === 'fail' ? 'fail' : e === 'unknown' ? 'unknown' : 'neutral')

function base(status: StageStatus, lead: string, extra: Partial<StageModel> = {}): StageModel {
  return { status, lead, facts: [], rows: [], note: null, primary: { label: 'Next', action: 'next' }, secondary: [], ...extra }
}

const VIEW_LABEL: Record<View, string> = { planner: 'Mission Planner', compare: 'Plan Comparison', atlas: 'Atlas', method: 'Validation' }

/** The card's content for the current stage, from the live stores only. */
export function stageModel(s: Snapshot): StageModel {
  const stage = STAGES[s.guide.stage]
  const o = originalScenario(), d = disruptedScenario()
  const oa = done(s.results[scenarioKey(o)])?.assessment ?? null
  const da = done(s.results[scenarioKey(d)])?.assessment ?? null
  const working = (lead: string) => base('working', lead, { primary: { label: 'Working…', action: 'next', disabled: true } })
  const failed = (msg: string) => base('error', msg, { primary: { label: 'Retry', action: 'retry' } })
  const outdated = (why: string) =>
    base('outdated', `The results have changed since this example was checked. ${why}`, {
      note: 'Explore on your own to see the current results.',
      primary: { label: 'Explore on your own', action: 'finish' },
    })

  // Inputs edited by the user: never narrate the original script over changed inputs.
  if (s.guide.stage <= stageIndex('rescue')) {
    const cur = s.rescue.original ? scenarioKey(s.rescue.original) : null
    if (cur !== scenarioKey(o) && s.guide.stage > 0)
      return base('modified', 'You changed the active plan. Restart to load the tour’s plan again, or exit to keep exploring yours.', {
        primary: { label: 'Restart the example', action: 'restart' },
      })
    const ch = s.rescue.change
    const overrides = Object.values(ch.requirement_overrides ?? {}).some((v) => v !== undefined && v !== null)
    if (s.guide.stage >= stageIndex('delay') && ((ch.launch_delay_days ?? 0) !== MISSION.disruption.launch_delay_days || ch.new_duration_days || overrides))
      return base('modified', `You changed the Mission Rescue settings. Restart to restore the example’s ${MISSION.disruption.launch_delay_days}-day delay.`, {
        primary: { label: 'Restart the example', action: 'restart' },
      })
  } else {
    const why = comparisonIntegrity(s.guide, s)
    if (why) return base('modified', why, { primary: { label: 'Restart the example', action: 'restart' } })
  }
  if (s.view !== stage.view)
    return base('elsewhere', `This step happens in ${VIEW_LABEL[stage.view]}.`, { primary: { label: `Go to ${VIEW_LABEL[stage.view]}`, action: 'view' } })
  if (s.guide.error) return failed(s.guide.error)

  switch (stage.id) {
    case 'mission':
      return base('ready', 'Keep the lander powered and able to communicate with Earth during its mission.', {
        facts: [
          { label: 'Site', value: `${o.site.name} (${Math.abs(o.site.lat).toFixed(2)}° S)` },
          { label: 'Landing', value: utc(o.landing_utc) },
          { label: 'Duration', value: `${o.duration_days} days` },
          ...MISSION.original.requirements_plain.map((r, i) => ({ label: i === 0 ? 'Requirements' : '', value: r })),
        ],
        note: 'The app checks this plan using NASA’s JPL Horizons positions and LOLA terrain data.',
        primary: { label: 'Assess the original plan', action: 'next' },
      })
    case 'original': {
      const st = s.results[scenarioKey(o)]
      if (st?.status === 'error') return failed(`The assessment failed: ${st.message}`)
      if (!oa) return working('Checking the original plan…')
      const chk = checkOriginal(oa)
      if (!chk.ok) return outdated(chk.reason)
      return base('ready', `The original plan ${word(oa.eligibility)} every requirement.`, {
        facts: [{ label: 'Verdict', value: oa.eligibility.toUpperCase(), tone: 'pass' }, ...marginFacts(oa, MISSION.expected.original.margin_constraints)],
        note: 'Each margin shows how much room the plan has before it reaches a limit.',
        primary: { label: `Apply the ${MISSION.disruption.launch_delay_days}-day launch delay`, action: 'next' },
      })
    }
    case 'delay': {
      const st = s.results[scenarioKey(d)]
      const facts: Fact[] = [
        { label: 'Landing', value: `${utc(o.landing_utc)} → ${utc(d.landing_utc)}` },
        { label: 'Duration', value: `${d.duration_days} days (unchanged)` },
        { label: 'Requirements', value: 'unchanged' },
      ]
      if (st?.status === 'error') return failed(`The assessment of the delayed plan failed: ${st.message}`)
      if (!da) return base('working', MISSION.disruption.description, { facts, note: 'Re-assessing the delayed plan…', primary: { label: 'Working…', action: 'next', disabled: true } })
      return base('ready', MISSION.disruption.description, {
        facts,
        primary: { label: 'See what changed', action: 'next' },
      })
    }
    case 'changed': {
      if (!oa || !da) return working('Waiting for both assessments…')
      const chk = checkDisrupted(da)
      if (!chk.ok) return outdated(chk.reason)
      const rows = changeRows(oa, da)
      const failing = da.constraints.filter((c) => c.status === 'fail')
      return base('ready', `The ${MISSION.disruption.launch_delay_days}-day delay pushes ${failing.length === 1 ? 'one requirement' : `${failing.length} requirements`} past the limit.`, {
        rows,
        facts: failing.map((c) => ({ label: 'Over the limit', value: headroomText(c), tone: 'fail' as const })),
        primary: { label: 'Show me why', action: 'next' },
      })
    }
    case 'evidence': {
      if (!da) return working('Waiting for the delayed plan’s assessment…')
      const { check, window: w, constraint } = evidenceWindow(da)
      if (!check.ok) return outdated(check.reason)
      if (s.evidenceProblem) return failed(`The 3D view could not show the evidence: ${s.evidenceProblem}`)
      if (!s.guide.evidenceShown || !s.evidenceVisible) return working('Opening the evidence in the 3D view…')
      const hrs = Math.round(w!.duration_s / 360) / 10
      return base('ready',
        `Earth drops out of view at ${utc(w!.start_utc)}. The blackout exceeds the mission’s limit.`, {
          note: w!.clipped_at_end ? 'Earth is still out of view when the mission ends.' : `Earth comes back into view at ${utc(w!.end_utc)}.`,
          facts: [{ label: 'Blackout', value: `${withDays(`${hrs} h`)}, limit ${withDays(`${limitHours(constraint!)} h`)}`, tone: 'fail' }],
          secondary: [{ label: 'Show the evidence again', action: 'evidence' }],
          primary: { label: 'Search for a recovery', action: 'next' },
        })
    }
    case 'rescue': {
      if (s.rescue.status === 'error') return failed(`Mission Rescue failed: ${s.rescue.error}`)
      const res = s.rescue.response
      if (!res || s.rescue.status === 'loading' || s.rescue.status === 'idle')
        return working('Mission Rescue is checking other sites and dates…')
      const m = rescueMatches(res)
      if (!m.ok) return failed(m.reason)
      const cands = recoveryCandidates(res)
      if (!cands.length) return outdated(`Mission Rescue found no alternative that passes with the same ${d.duration_days}-day duration and requirements (status: ${res.status}).`)
      const pick = s.guide.recovery
      if (!pick) return working('Selecting the recovery…')
      const ra = done(s.results[scenarioKey(pick)])?.assessment
      const rst = s.results[scenarioKey(pick)]
      if (rst?.status === 'error') return failed(`The canonical check of the recovery failed: ${rst.message}`)
      if (!ra) return working('Checking the suggested recovery against the mission limits…')
      if (ra.eligibility !== 'pass') return outdated(`The canonical engine assesses Rescue’s recovery as ${ra.eligibility.toUpperCase()}.`)
      const moved = res.alternatives.find((a) => scenarioKey(a.scenario) === scenarioKey(pick))?.distance_km
      const sameDate = new Date(pick.landing_utc).getTime() === new Date(d.landing_utc).getTime()
      return base('ready',
        `The recovery ${word(ra.eligibility)} every requirement for the same ${pick.duration_days}-day mission.${sameDate ? ' It keeps the delayed landing date and moves to another site.' : ''}`, {
          facts: [
            { label: 'Recovery', value: `${pick.site.name} · ${utc(pick.landing_utc)}`, tone: 'pass' },
            ...(moved === undefined ? [] : [{ label: 'Moved', value: Math.round(moved) > 0 ? `${Math.round(moved)} km from the original site` : 'stays at the original site' }]),
            ...marginFacts(ra, MISSION.expected.original.margin_constraints),
          ],
          note: `Mission Rescue found ${res.stats.passing} passing options out of ${res.stats.candidates_evaluated} checked.`,
          primary: { label: 'Compare the three plans', action: 'next' },
        })
    }
    case 'compare':
    case 'report': {
      const c = s.comparison
      const errs = c.entries.filter((e) => e.state?.state === 'error')
      if (errs.length) return failed(`The comparison could not assess ${errs.map((e) => e.scenario.name).join(', ')}: ${errs[0].state?.state === 'error' ? errs[0].state.message : ''}`)
      if (!c.settled) return working('Plan Comparison is re-assessing the three plans together…')
      const roles = ['Original', 'After the delay', 'Recovery']
      const byId = (id: string) => c.entries.find((e) => e.scenario.id === id)
      const ents = s.guide.compareIds.map(byId)
      if (ents.some((e) => !e)) return failed('The imported plans are not in the comparison.')
      const els = ents.map((e) => eligibilityOf(e!))
      if (els[0] !== 'pass' || els[1] !== 'fail' || els[2] !== 'pass')
        return outdated(`The comparison re-assessment reads ${els.map((e, i) => `${roles[i]} ${e?.toUpperCase() ?? 'not assessed'}`).join(', ')}.`)
      const decision = buildDecision(c.entries, c.groups, c.pairs).groups.find((x) => x.group.primary)
      if (!decision || decision.recommended?.scenario.id !== s.guide.compareIds[2])
        return outdated('The comparison no longer recommends the recovery.')
      const facts: Fact[] = ents.map((e, i) => ({
        label: `${e!.scenario.label} · ${roles[i]}`,
        value: `${e!.scenario.site.name}, ${utc(e!.scenario.landing_utc)} · ${word(els[i]).toLowerCase()}${e!.ranking?.rank ? ` · rank ${e!.ranking.rank} of ${c.groups.find((g) => g.id === e!.ranking?.group)?.ranked_keys.length ?? '?'} passing` : ''}`,
        tone: tone(els[i]),
      }))
      if (stage.id === 'compare')
        return base('ready', 'The recovery ranks first among the passing plans. Use the original plan as your reference when comparing what changed.', {
          facts,
          note: decision.evidence[0] ?? null,
          primary: { label: 'Generate the summary report', action: 'next' },
        })
      return base('ready', s.guide.reportOpened
        ? 'Save the report as a PDF to share the results and recommendation.'
        : 'Export the comparison as JSON or CSV to keep a copy of these results.', {
        facts,
        secondary: [{ label: s.guide.reportOpened ? 'Open the report again' : 'Show the summary', action: s.guide.reportOpened ? 'report' : 'section' }],
        primary: { label: 'Finish', action: 'finish' },
      })
    }
  }
}

// ---------------------------------------------------------------- small formatting helpers

const utc = (iso: string) => utcText(iso)
const limitHours = (c: ConstraintEvaluation) => (c.threshold === null ? '?' : Math.round(c.threshold / 360) / 10)

// Plain labels for the live cards (a presentation layer only: the engine's names, ids and numbers are unchanged).
const PLAIN_NAMES: Record<string, string> = {
  max_continuous_darkness: 'Longest dark spell (battery only)',
  max_communication_blackout: 'Longest time Earth is out of sight',
  min_earth_visibility_percent: 'Time with Earth in sight',
  min_mean_solar_disk_fraction: 'Average share of the Sun’s disk visible',
  min_initial_sunlight: 'Sunlight right after landing',
  min_initial_earth_visibility: 'Earth in sight right after landing',
}

/** The plain label of a requirement; requirements without one keep the engine's name. */
export function plainName(c: ConstraintEvaluation): string {
  return PLAIN_NAMES[c.constraint_id] ?? c.name
}

/** "118 h" -> "118 h (4.9 days)": every hour value of 48 h or more also shows days; anything else is unchanged. */
export function withDays(text: string): string {
  return text.replace(/(\d+(?:\.\d+)?) h\b(?! \()/g, (m, n: string) => {
    const h = Number(n)
    return h >= 48 ? `${m} (${Math.round((h / 24) * 10) / 10} days)` : m
  })
}

const measured = (c: ConstraintEvaluation) => withDays(measuredText(c))
const limit = (c: ConstraintEvaluation) => withDays(limitText(c))

function headroomText(c: ConstraintEvaluation): string {
  const h = headroom(c)
  return `${plainName(c)}: ${measured(c)}, limit ${limit(c)}${h ? `, ${withDays(h.text)}` : ''}`
}

function marginFacts(a: Assessment, ids: string[]): Fact[] {
  return ids.map((id) => a.constraints.find((c) => c.constraint_id === id)).filter((c): c is ConstraintEvaluation => !!c).map((c) => {
    const h = headroom(c)
    return { label: plainName(c), value: `${measured(c)} · limit ${limit(c)}${h ? ` · ${withDays(h.text)}` : ''}`, tone: tone(c.status) }
  })
}

function changeRows(oa: Assessment, da: Assessment): ChangeRow[] {
  return statusChanges(oa, da).map((x) => ({ name: plainName(x.after), before: measured(x.before), after: measured(x.after), limit: limit(x.after), from: x.from, to: x.to }))
}
