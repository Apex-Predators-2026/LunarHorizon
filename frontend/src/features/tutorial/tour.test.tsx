// The unified Guided Tour across the four views: the tour steps drive the live mission story (real API fixtures
// through a mocked fetch) and the app view, in Acts 1–3.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scenarioKey } from '../assessment/useAssessmentStore'
import { useReportStore } from '../compare/report'
import { useCompareStore } from '../compare/useCompareStore'
import { flush, resetMissionStores, stubMissionFetch, viewerShows, type MissionApiControls } from '../guide/__fixtures__/mockApi'
import { snapshot, stageModel, STAGES, useGuide } from '../guide/mission'
import { originalScenario } from '../guide/missionDefinition'
import { useNav } from '../guide/nav'
import { useRescueStore } from '../rescue/useRescueStore'
import { TUTORIAL_STEPS } from './steps'
import { installTourBridge, requiredStage } from './storyBridge'
import { resetTutorialStoreForTests, useTutorialStore } from './useTutorialStore'
import { handleTutorialKeyDown } from './utils'

function memoryStorage() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
}

const indexOf = (id: string) => TUTORIAL_STEPS.findIndex((s) => s.id === id)

async function goToId(id: string) {
  useTutorialStore.getState().goToStep(indexOf(id))
  await flush(12)
  if (id === 'evidence') viewerShows()
}

let unsub: () => void = () => {}
let api: MissionApiControls

beforeEach(() => {
  resetMissionStores()
  api = stubMissionFetch()
  resetTutorialStoreForTests(memoryStorage())
  useNav.setState({ view: 'planner' })
  useReportStore.setState({ open: false })
  unsub = installTourBridge()
})

afterEach(() => {
  useTutorialStore.getState().skipTour()
  unsub()
  useGuide.getState().exit()
  vi.unstubAllGlobals()
})

describe('unified guided tour', () => {
  it('requiredStage maps spotlight steps to the story stage they sit on', () => {
    expect(requiredStage(indexOf('terrain'))).toBe('mission')
    expect(requiredStage(indexOf('sync'))).toBe('compare')
    expect(requiredStage(indexOf('assistant'))).toBe('compare') // the report is an output, not a prerequisite
    expect(requiredStage(indexOf('atlas'))).toBeNull()
  })

  it('starting the tour loads the mission on the planner', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    expect(useGuide.getState()).toMatchObject({ active: true, stage: 0 })
    expect(useNav.getState().view).toBe('planner')
    expect(scenarioKey(useRescueStore.getState().original!)).toBe(scenarioKey(originalScenario()))
  })

  it('walks Act 1 into Act 2 with live results', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    await goToId('original')
    expect(stageModel(snapshot()).status).toBe('ready')
    await goToId('delay')
    expect(stageModel(snapshot()).rows[0]).toMatchObject({ before: '22 h', after: '118 h', to: 'fail' })
    await goToId('evidence')
    expect(stageModel(snapshot()).status).toBe('ready')
    await goToId('rescue')
    await flush(12)
    expect(useGuide.getState().recovery?.site.id).toBe('malapert-massif')
    await goToId('compare')
    await useCompareStore.getState().refresh()
    await flush()
    expect(useNav.getState().view).toBe('compare')
    expect(useGuide.getState().compareIds).toHaveLength(3)
    expect(stageModel(snapshot()).status).toBe('ready')
  })

  it('catches up the story when jumping to Act 2', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    useTutorialStore.getState().goToAct(2)
    for (let i = 0; i < 10; i++) {
      await flush(12)
      viewerShows()
    }
    expect(TUTORIAL_STEPS[useTutorialStore.getState().stepIndex].id).toBe('compare')
    expect(STAGES[useGuide.getState().stage].id).toBe('compare')
    expect(useNav.getState().view).toBe('compare')
    expect(useGuide.getState().compareIds).toHaveLength(3)
  })

  it('Back re-enters the earlier story stage and removes the delay', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    await goToId('delay')
    expect(useRescueStore.getState().change.launch_delay_days).toBe(4)
    useTutorialStore.getState().prevStep()
    await flush(12)
    expect(STAGES[useGuide.getState().stage].id).toBe('original')
    expect(useRescueStore.getState().change.launch_delay_days).toBe(0)
  })

  it('spotlight steps between story steps leave the story where it is', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    await goToId('sky')
    expect(useGuide.getState().stage).toBe(0)
    expect(useNav.getState().view).toBe('planner')
  })

  it('Act 3 visits the Atlas then Methodology, and Finish closes the tour', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    useTutorialStore.getState().goToAct(3)
    await flush()
    expect(useNav.getState().view).toBe('atlas')
    useTutorialStore.getState().nextStep()
    await flush()
    expect(useNav.getState().view).toBe('method')
    useTutorialStore.getState().nextStep() // Finish
    expect(useTutorialStore.getState()).toMatchObject({ open: false, completed: true })
    expect(useGuide.getState().active).toBe(false)
  })

  it('leaving the report step closes the report preview', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    useTutorialStore.getState().goToStep(indexOf('report'))
    useReportStore.setState({ open: true })
    useTutorialStore.getState().nextStep()
    await flush()
    expect(useReportStore.getState().open).toBe(false)
  })

  it('jumping to Act 3 while Act 2 is still catching up stays on the Atlas', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    useTutorialStore.getState().goToAct(2) // starts the catch-up through Rescue
    await flush(2)
    useTutorialStore.getState().goToAct(3)
    for (let i = 0; i < 10; i++) {
      await flush(12)
      viewerShows()
    }
    expect(useNav.getState().view).toBe('atlas')
    expect(TUTORIAL_STEPS[useTutorialStore.getState().stepIndex].id).toBe('atlas')
  })

  it('jumping ahead while Rescue is still searching still reaches the recovery', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    let release!: () => void
    api.setRescueGate(new Promise((r) => (release = r)))
    await goToId('rescue') // Rescue is now waiting on the gate
    useTutorialStore.getState().goToAct(2)
    await flush(4)
    release()
    for (let i = 0; i < 10; i++) await flush(12)
    expect(useGuide.getState().recovery?.site.id).toBe('malapert-massif')
    expect(STAGES[useGuide.getState().stage].id).toBe('compare')
    expect(useGuide.getState().compareIds).toHaveLength(3)
    expect(useGuide.getState().error).toBeNull()
  })

  it('reopening the tour does not duplicate the comparison plans', async () => {
    for (let round = 0; round < 2; round++) {
      useTutorialStore.getState().startTour(0)
      await flush()
      useTutorialStore.getState().goToAct(2)
      for (let i = 0; i < 10; i++) {
        await flush(12)
        viewerShows()
      }
      expect(useGuide.getState().compareIds).toHaveLength(3)
      useTutorialStore.getState().skipTour()
    }
    expect(useCompareStore.getState().scenarios.filter((s) => s.origin === 'rescue')).toHaveLength(3)
  })

  it('Esc with the report open closes only the report, not the tour', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    useReportStore.setState({ open: true })
    expect(handleTutorialKeyDown({ key: 'Escape' })).toBe(false)
    expect(useTutorialStore.getState().open).toBe(true)
  })

  it('skipping stops the story', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    useTutorialStore.getState().skipTour()
    expect(useGuide.getState().active).toBe(false)
  })
})
