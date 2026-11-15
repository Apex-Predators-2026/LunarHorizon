// The Guided Tour drives the live "Try a mission" story (features/guide/mission.ts) and the app views. The tour owns
// the step; the story engine owns every scientific result (assessment, Rescue, comparison, report) and is only told
// which stage to be on. Jumping ahead runs the earlier stages in order first, so a judge who opens Act 2 directly
// still sees the real imported plans rather than an empty comparison.
import { goTo, useNav } from '../guide/nav'
import {
  showStoryEvidenceAgain,
  snapshot,
  stageIndex,
  stageModel,
  useGuide,
  type Snapshot,
  type StageId,
  type StageModel,
} from '../guide/mission'
import { eligibilityOf } from '../compare/analysis'
import { useAssessmentStore } from '../assessment/useAssessmentStore'
import { useReportStore } from '../compare/report'
import { useCompareStore } from '../compare/useCompareStore'
import { useRescueStore } from '../rescue/useRescueStore'
import { useEvidence } from '../../viz/evidence'
import { TUTORIAL_STEPS } from './steps'
import { useTutorialStore } from './useTutorialStore'

/**
 * The story stage a step needs before it makes sense: its own stage on a story step, otherwise the last story stage
 * before it in Acts 1–2. The report is an output, not a prerequisite, so later Act 2 steps only need the comparison.
 * Act 3 (Atlas, Methodology) needs no story.
 */
export function requiredStage(stepIndex: number): StageId | null {
  const step = TUTORIAL_STEPS[stepIndex]
  if (!step || step.act === 3) return null
  if (step.story) return step.story
  for (let i = stepIndex - 1; i >= 0; i--) {
    const s = TUTORIAL_STEPS[i].story
    if (s && s !== 'report') return s
  }
  return null
}

/** Cancels older catch-up runs. */
let token = 0
/** The last stage whose entry finished, in order, in the current story run (-1: none). */
let settled = -1
/** The stage the running catch-up is heading for (null: none running). */
let heading: number | null = null

/** Stop any catch-up and the stage that is entering, so nothing navigates away from the step the judge is on. */
function cancelStory() {
  token++
  if (heading !== null && useGuide.getState().active) useGuide.getState().pause()
  heading = null
}

/** Enter stage k; true when it finished for this catch-up (not cancelled or taken over by another call). */
async function enter(k: number, mine: number): Promise<boolean> {
  const p = useGuide.getState().go(k)
  const run = useGuide.getState().run
  await p
  if (mine !== token || useGuide.getState().run !== run) return false
  settled = k
  return true
}

/** Bring the story to `stage`, running any stages it has not finished yet in order. A newer call cancels an older one. */
export async function enterStoryStage(stage: StageId): Promise<void> {
  const mine = ++token
  const target = stageIndex(stage)
  if (!useGuide.getState().active) {
    useGuide.getState().begin()
    settled = -1
  }
  heading = target
  for (let k = Math.min(target, settled + 1); k <= target; k++) {
    if (mine !== token || !useTutorialStore.getState().open) return
    if (!(await enter(k, mine))) return
  }
  if (mine === token) heading = null
}

/** Subscribe the bridge to the tour. Returns the unsubscribe function. */
export function installTourBridge(): () => void {
  let lastNonce = -1
  let lastIndex: number | null = null
  let wasOpen = false
  const sync = () => {
    const st = useTutorialStore.getState()
    if (!st.open) {
      if (wasOpen) {
        wasOpen = false
        const last = lastIndex === null ? null : TUTORIAL_STEPS[lastIndex]
        lastIndex = null
        cancelStory()
        if (last?.story === 'report') useReportStore.getState().close()
        if (useGuide.getState().active) useGuide.getState().exit()
      }
      return
    }
    wasOpen = true
    if (st.prepNonce === lastNonce) return
    lastNonce = st.prepNonce
    const step = TUTORIAL_STEPS[st.stepIndex]
    if (!step) return
    const prev = lastIndex === null ? null : TUTORIAL_STEPS[lastIndex]
    lastIndex = st.stepIndex
    goTo(step.view)
    if (prev?.story === 'report' && step.story !== 'report') useReportStore.getState().close()
    const req = requiredStage(st.stepIndex)
    if (!req) {
      cancelStory() // Act 3: a catch-up still running must not pull the judge back to the planner
      return
    }
    const need = stageIndex(req)
    if (!step.story && useGuide.getState().active) {
      if (heading === need) return // already on its way to exactly what this step needs
      if (settled >= need) {
        cancelStory() // already there; stop heading further (e.g. Back from Act 2 to an Act 1 tool)
        return
      }
    }
    void enterStoryStage(req)
  }
  sync()
  return useTutorialStore.subscribe(sync)
}

export interface StoryView {
  model: StageModel
  /** The story is not on this step's stage yet (starting up or running earlier stages). */
  catchingUp: boolean
}

/** The live story content for a story step, or null on other steps. Re-renders whenever a result arrives. */
export function useStoryModel(stage: StageId | undefined): StoryView | null {
  const active = useGuide((g) => g.active)
  const current = useGuide((g) => g.stage)
  useGuide((g) => g.error)
  useGuide((g) => g.recovery)
  useGuide((g) => g.evidenceShown)
  useGuide((g) => g.reportOpened)
  useGuide((g) => g.compareIds)
  useNav((n) => n.view)
  useAssessmentStore((s) => s.results)
  useRescueStore((s) => s.rescueStatus)
  useRescueStore((s) => s.rescue)
  useRescueStore((s) => s.original)
  useRescueStore((s) => s.change)
  useCompareStore((s) => s.results)
  useCompareStore((s) => s.scenarios)
  useCompareStore((s) => s.selectedIds)
  useCompareStore((s) => s.rankingSetKey)
  useEvidence((e) => e.highlight)
  useEvidence((e) => e.problem)
  if (!stage) return null
  return { model: stageModel(snapshot()), catchingUp: !active || current !== stageIndex(stage) }
}

export interface RecapFact {
  label: string
  value: string
  tone: 'pass' | 'fail' | 'unknown' | 'neutral'
}

const RECAP_ROLES = ['Original plan', 'After the delay', 'Recovery']
const VERDICT_WORD = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN' } as const

/**
 * The story's outcome for the last step: the three plans the comparison re-assessed (original, delayed, recovery)
 * with their live verdicts. Null until the story has imported them and every verdict is in: never a guess.
 */
export function recapFacts(snap: Snapshot = snapshot()): RecapFact[] | null {
  const ids = snap.guide.compareIds
  if (ids.length !== RECAP_ROLES.length) return null
  const facts: RecapFact[] = []
  for (const [i, id] of ids.entries()) {
    const entry = snap.comparison.entries.find((e) => e.scenario.id === id)
    const verdict = entry ? eligibilityOf(entry) : null
    if (!entry || !verdict) return null
    facts.push({ label: RECAP_ROLES[i], value: `${entry.scenario.site.name} · ${VERDICT_WORD[verdict]}`, tone: verdict })
  }
  return facts
}

/** recapFacts(), kept live while `on` (the comparison may still be settling when the last step opens). */
export function useRecap(on: boolean): RecapFact[] | null {
  useGuide((g) => g.compareIds)
  useCompareStore((s) => s.results)
  useCompareStore((s) => s.scenarios)
  useCompareStore((s) => s.rankingSetKey)
  return on ? recapFacts() : null
}

export type StoryAction = StageModel['primary']['action'] | StageModel['secondary'][number]['action']

/** Carry out a story card action inside the tour. */
export function runStoryAction(a: StoryAction): void {
  const g = useGuide.getState()
  switch (a) {
    case 'next':
    case 'finish':
      useTutorialStore.getState().nextStep()
      return
    case 'retry': {
      // Re-run the current stage; once it finishes, continue any catch-up this step still needs.
      const mine = ++token
      const at = g.stage
      settled = Math.min(settled, at - 1)
      heading = at
      const p = g.retry()
      const run = useGuide.getState().run
      void p.then(() => {
        if (mine !== token || useGuide.getState().run !== run) return
        settled = at
        heading = null
        const req = requiredStage(useTutorialStore.getState().stepIndex)
        if (req && stageIndex(req) > at) void enterStoryStage(req)
      })
      return
    }
    case 'view': {
      const req = requiredStage(useTutorialStore.getState().stepIndex)
      if (req) void enterStoryStage(req)
      return
    }
    case 'restart': {
      cancelStory()
      g.restart()
      settled = -1
      const req = requiredStage(useTutorialStore.getState().stepIndex)
      if (req) void enterStoryStage(req)
      return
    }
    case 'evidence':
      showStoryEvidenceAgain()
      return
    case 'report':
      useReportStore.getState().reopen()
      return
    case 'section':
      if (typeof document !== 'undefined') document.getElementById('cmp-summary')?.scrollIntoView({ block: 'start' })
      return
  }
}
