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
import { useTutorialStore } from '../tutorial/useTutorialStore'
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
  start: () => void
  go: (i: number) => void
  next: () => void
  back: () => void
  retry: () => void
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
  start: () => {
    // The feature tutorial and the story never compete for focus or navigation.
    const tut = useTutorialStore.getState()
    if (tut.open) tut.skipTour()
    tut.dismissOffer()
    set({ ...initial, active: true, run: get().run + 1 })
    get().go(0)
  },
  go: (i) => {
    const stage = Math.max(0, Math.min(STAGES.length - 1, i))
    const run = get().run + 1
    set({ stage, run, error: null })
    const id = STAGES[stage].id
    Promise.resolve(ENTER[id](run)).catch((e: unknown) => {
      if (live(run)) set({ error: e instanceof Error ? e.message : String(e) })
    })
  },
  next: () => get().go(get().stage + 1),
  back: () => get().go(get().stage - 1),
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
    get().go(get().stage)
  },
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

// The feature tutorial takes over when it opens: the story stops, so the two never issue conflicting navigation.
useTutorialStore.subscribe((t, prev) => {
  if (t.open && !prev.open && useGuide.getState().active) useGuide.getState().exit()
})

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

const VIEW_LABEL: Record<View, string> = { planner: 'Mission Planner', compare: 'Scenario Comparison', atlas: 'Atlas', method: 'Validation' }

/** The card's content for the current stage, from the live stores only. */
export function stageModel(s: Snapshot): StageModel {
  const stage = STAGES[s.guide.stage]
  const o = originalScenario(), d = disruptedScenario()
  const oa = done(s.results[scenarioKey(o)])?.assessment ?? null
  const da = done(s.results[scenarioKey(d)])?.assessment ?? null
  const working = (lead: string) => base('working', lead, { primary: { label: 'Working…', action: 'next', disabled: true } })
  const failed = (msg: string) => base('error', msg, { primary: { label: 'Retry', action: 'retry' } })
  const outdated = (why: string) =>
    base('outdated', `This example no longer matches its verified baseline, so the guided story stops here. ${why}`, {
      note: `Mission ${MISSION.id} v${MISSION.version}. The tools keep showing the actual current results; you can keep exploring them.`,
      primary: { label: 'Explore on your own', action: 'finish' },
    })

  // Inputs edited by the user: never narrate the original script over changed inputs.
  if (s.guide.stage <= stageIndex('rescue')) {
    const cur = s.rescue.original ? scenarioKey(s.rescue.original) : null
    if (cur !== scenarioKey(o) && s.guide.stage > 0)
      return base('modified', 'The running plan was changed, so the guided story is paused: it describes the original inputs.', {
        note: `The story uses ${o.site.name}, landing ${o.landing_utc.slice(0, 10)}, ${o.duration_days} days. Restart the example, or exit and keep exploring your changed plan.`,
        primary: { label: 'Restart the example', action: 'restart' },
      })
    const ch = s.rescue.change
    const overrides = Object.values(ch.requirement_overrides ?? {}).some((v) => v !== undefined && v !== null)
    if (s.guide.stage >= stageIndex('delay') && ((ch.launch_delay_days ?? 0) !== MISSION.disruption.launch_delay_days || ch.new_duration_days || overrides))
      return base('modified', 'The plan change was edited in Mission Rescue, so the guided story is paused: it describes a 4-day launch delay with the same duration and requirements.', {
        primary: { label: 'Restart the example', action: 'restart' },
      })
  } else {
    const why = comparisonIntegrity(s.guide, s)
    if (why) return base('modified', `${why} The guided story is paused because it describes the three imported plans.`, { primary: { label: 'Restart the example', action: 'restart' } })
  }
  if (s.view !== stage.view)
    return base('elsewhere', `This step happens in ${VIEW_LABEL[stage.view]}.`, { primary: { label: `Go to ${VIEW_LABEL[stage.view]}`, action: 'view' } })
  if (s.guide.error) return failed(s.guide.error)

  switch (stage.id) {
    case 'mission':
      return base('ready', MISSION.objective, {
        facts: [
          { label: 'Site', value: `${o.site.name} (${Math.abs(o.site.lat).toFixed(2)}° S)` },
          { label: 'Landing', value: utc(o.landing_utc) },
          { label: 'Duration', value: `${o.duration_days} days` },
          ...MISSION.original.requirements_plain.map((r, i) => ({ label: i === 0 ? 'Requirements' : '', value: r })),
        ],
        note: 'Real JPL Horizons ephemerides and LOLA terrain, assessed by the canonical engine. Nothing in this story is pre-recorded.',
        primary: { label: 'Assess the original plan', action: 'next' },
      })
    case 'original': {
      const st = s.results[scenarioKey(o)]
      if (st?.status === 'error') return failed(`The assessment failed: ${st.message}`)
      if (!oa) return working('The canonical engine is assessing the plan against every requirement…')
      const chk = checkOriginal(oa)
      if (!chk.ok) return outdated(chk.reason)
      return base('ready', `As planned, the mission ${word(oa.eligibility)} every requirement. The margins below are what a delay could eat into.`, {
        facts: [{ label: 'Verdict', value: oa.eligibility.toUpperCase(), tone: 'pass' }, ...marginFacts(oa, MISSION.expected.original.margin_constraints)],
        note: 'The Mission assessment panel lists every requirement with its limit, measured value and margin.',
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
        note: `Entered through Mission Rescue's "Plan change" form (launch delay = ${MISSION.disruption.launch_delay_days} days), so the normal tools show the same change.`,
        primary: { label: 'See what changed', action: 'next' },
      })
    }
    case 'changed': {
      if (!oa || !da) return working('Waiting for both assessments…')
      const chk = checkDisrupted(da)
      if (!chk.ok) return outdated(chk.reason)
      const rows = changeRows(oa, da)
      const failing = da.constraints.filter((c) => c.status === 'fail')
      const others = da.constraints.filter((c) => c.status !== 'not_applicable').length - rows.length
      return base('ready', `Landing ${MISSION.disruption.launch_delay_days} days later, the same plan ${word(da.eligibility)} ${failing.length === 1 ? 'one requirement' : `${failing.length} requirements`}: ${failing.map((c) => c.name).join('; ')}. ${others > 0 ? `The other ${others} applicable requirements keep their status.` : ''}`.trim(), {
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
        `Earth is out of the lander’s line of sight from ${utc(w!.start_utc)} ${w!.clipped_at_end ? 'until the mission ends' : 'until'} ${utc(w!.end_utc)}: ${hrs} h without a direct-to-Earth link, against a limit of ${limitHours(constraint!)} h. The 3D view looks from the lander toward Earth at that moment; the band on the time strip marks the blackout.`, {
          note: w!.clipped_at_end ? 'The blackout is still going on when the mission ends, so the outage itself may last longer; 118 h is what this mission experiences.' : null,
          facts: [{ label: 'Blackout', value: `${hrs} h (limit ${limitHours(constraint!)} h)`, tone: 'fail' }],
          secondary: [{ label: 'Show the evidence again', action: 'evidence' }],
          primary: { label: 'Search for a recovery', action: 'next' },
        })
    }
    case 'rescue': {
      if (s.rescue.status === 'error') return failed(`Mission Rescue failed: ${s.rescue.error}`)
      const res = s.rescue.response
      if (!res || s.rescue.status === 'loading' || s.rescue.status === 'idle')
        return working(`Mission Rescue is searching nearby sites and dates (${MISSION.search.date_window_days} days after the delayed landing, every ${MISSION.search.date_step_hours} h, real data only)…`)
      const m = rescueMatches(res)
      if (!m.ok) return failed(m.reason)
      const cands = recoveryCandidates(res)
      if (!cands.length) return outdated(`Mission Rescue found no alternative that passes with the same ${d.duration_days}-day duration and requirements (status: ${res.status}).`)
      const pick = s.guide.recovery
      if (!pick) return working('Selecting the recovery…')
      const ra = done(s.results[scenarioKey(pick)])?.assessment
      const rst = s.results[scenarioKey(pick)]
      if (rst?.status === 'error') return failed(`The canonical check of the recovery failed: ${rst.message}`)
      if (!ra) return working('The canonical engine is double-checking the recovery…')
      if (ra.eligibility !== 'pass') return outdated(`The canonical engine assesses Rescue’s recovery as ${ra.eligibility.toUpperCase()}.`)
      const alt = cands[0]
      const sameDate = new Date(pick.landing_utc).getTime() === new Date(d.landing_utc).getTime()
      return base('ready',
        `Mission Rescue evaluated ${res.stats.candidates_evaluated} candidate landings at ${res.stats.locations_considered} locations; ${res.stats.passing} meet every requirement. The first that keeps the ${pick.duration_days}-day mission and every requirement: ${pick.site.name}, landing ${utc(pick.landing_utc)}${sameDate ? ' (same date, different site)' : ''}. The canonical engine confirms it ${word(ra.eligibility)}.`, {
          facts: [
            { label: 'Recovery', value: `${pick.site.name} · ${utc(pick.landing_utc)}`, tone: 'pass' },
            ...marginFacts(ra, MISSION.expected.original.margin_constraints),
          ],
          note: alt.headline ? `Rescue’s note: ${alt.headline}` : null,
          primary: { label: 'Compare the three plans', action: 'next' },
        })
    }
    case 'compare':
    case 'report': {
      const c = s.comparison
      const errs = c.entries.filter((e) => e.state?.state === 'error')
      if (errs.length) return failed(`The comparison could not assess ${errs.map((e) => e.scenario.name).join(', ')}: ${errs[0].state?.state === 'error' ? errs[0].state.message : ''}`)
      if (!c.settled) return working('Scenario Comparison is re-assessing the three plans together…')
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
      const rec = ents[2]!
      const named = (t: string) => ents.reduce((acc, e, i) => acc.split(`Scenario ${e!.scenario.label}`).join(`Scenario ${e!.scenario.label} (${roles[i].toLowerCase()})`), t)
      const n = c.groups.find((x) => x.primary)?.ranked_keys.length ?? 0
      if (stage.id === 'compare')
        return base('ready', `The comparison recommends the recovery, ${rec.scenario.label}: ${rec.scenario.site.name} on ${utc(rec.scenario.landing_utc)}. It passes every requirement and holds canonical rank 1 of ${n} passing plans in one comparable group. ${named(decision.evidence[0] ?? '')} The original plan stays as the reference: after the delay it can no longer be flown.`.replace(/\s+/g, ' ').trim(), {
          facts,
          note: 'Every status here is the comparison’s own canonical re-assessment of the imported plans, with the same requirements and duration, so they are ranked in one group.',
          primary: { label: 'Generate the summary report', action: 'next' },
        })
      return base('ready', s.guide.reportOpened
        ? 'The summary report freezes exactly these evaluated plans: verdicts, the recommendation and its evidence, margins, sources and limitations. Print it or save it as PDF, or download the matching JSON.'
        : 'Export the decision from the comparison summary: the JSON and CSV exports carry the same evaluated plans, verdicts and provenance.', {
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

function headroomText(c: ConstraintEvaluation): string {
  const h = headroom(c)
  return `${c.name}: ${measuredText(c)} (limit ${limitText(c)})${h ? `, ${h.text}` : ''}`
}

function marginFacts(a: Assessment, ids: string[]): Fact[] {
  return ids.map((id) => a.constraints.find((c) => c.constraint_id === id)).filter((c): c is ConstraintEvaluation => !!c).map((c) => {
    const h = headroom(c)
    return { label: c.name, value: `${measuredText(c)} (limit ${limitText(c)})${h ? ` · ${h.text}` : ''}`, tone: tone(c.status) }
  })
}

function changeRows(oa: Assessment, da: Assessment): ChangeRow[] {
  return statusChanges(oa, da).map((x) => ({ name: x.name, before: measuredText(x.before), after: measuredText(x.after), limit: limitText(x.after), from: x.from, to: x.to }))
}
