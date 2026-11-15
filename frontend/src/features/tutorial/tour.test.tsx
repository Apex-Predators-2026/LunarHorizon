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
import { installTourBridge, recapFacts, requiredStage } from './storyBridge'
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
    expect(requiredStage(indexOf('science'))).toBe('compare') // the report is an output, not a prerequisite
    expect(requiredStage(indexOf('your-turn'))).toBeNull()
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
    expect(stageModel(snapshot()).rows[0]).toMatchObject({ before: '22 h', to: 'fail' })
    expect(stageModel(snapshot()).rows[0].after).toContain('118 h')
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

  it('Act 3 visits the Atlas, Methodology, then Your turn on the planner, and Explore on my own closes the tour', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    useTutorialStore.getState().goToAct(3)
    await flush()
    expect(useNav.getState().view).toBe('atlas')
    useTutorialStore.getState().nextStep()
    await flush()
    expect(useNav.getState().view).toBe('method')
    useTutorialStore.getState().nextStep()
    await flush()
    expect(useNav.getState().view).toBe('planner')
    useTutorialStore.getState().nextStep() // Explore on my own
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

  const idAt = () => TUTORIAL_STEPS[useTutorialStore.getState().stepIndex].id
  async function next() {
    useTutorialStore.getState().nextStep()
    await flush(12)
    if (idAt() === 'evidence') viewerShows()
  }

  it('the quick path walks the whole story across routes and ends with a live recap', async () => {
    useTutorialStore.getState().startTour(undefined, 'quick')
    await flush()
    expect(idAt()).toBe('mission')
    await next()
    expect(idAt()).toBe('delay')
    expect(stageModel(snapshot()).rows[0].after).toContain('118 h')
    await next()
    expect(idAt()).toBe('evidence')
    expect(stageModel(snapshot()).status).toBe('ready')
    await next()
    await flush(12)
    expect(idAt()).toBe('rescue')
    expect(useGuide.getState().recovery?.site.id).toBe('malapert-massif')
    await next()
    await useCompareStore.getState().refresh()
    await flush()
    expect(idAt()).toBe('compare')
    expect(useNav.getState().view).toBe('compare')
    expect(useGuide.getState().compareIds).toHaveLength(3)
    await next()
    expect(idAt()).toBe('science')
    expect(useNav.getState().view).toBe('compare')
    await next()
    expect(idAt()).toBe('your-turn')
    expect(useNav.getState().view).toBe('planner')
    const recap = recapFacts()
    expect(recap?.map((f) => f.label)).toEqual(['Original plan', 'After the delay', 'Recovery'])
    expect(recap?.map((f) => f.tone)).toEqual(['pass', 'fail', 'pass'])
    expect(recap?.[2].value).toContain('Malapert Massif')
    await next() // Explore on my own
    expect(useTutorialStore.getState().open).toBe(false)
    expect(useGuide.getState().active).toBe(false)
  })

  it('quick path: the Act 2 tab catches the story up to the comparison', async () => {
    useTutorialStore.getState().startTour(undefined, 'quick')
    await flush()
    useTutorialStore.getState().goToAct(2)
    for (let i = 0; i < 10; i++) {
      await flush(12)
      viewerShows()
    }
    expect(idAt()).toBe('compare')
    expect(STAGES[useGuide.getState().stage].id).toBe('compare')
    expect(useGuide.getState().compareIds).toHaveLength(3)
  })

  it('Your turn stops the story, so picking a site cannot pause it mid-explanation', async () => {
    useTutorialStore.getState().startTour(undefined, 'quick')
    await flush()
    useTutorialStore.getState().goToAct(3)
    for (let i = 0; i < 6; i++) await flush(12)
    expect(idAt()).toBe('your-turn')
    expect(useNav.getState().view).toBe('planner')
    expect(useGuide.getState().compareIds).toHaveLength(0) // no catch-up ran for Act 3
  })

  it('the recap is empty when the story never reached the comparison', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    useTutorialStore.getState().goToAct(3)
    await flush()
    expect(recapFacts()).toBeNull()
  })

  it('skipping stops the story', async () => {
    useTutorialStore.getState().startTour(0)
    await flush()
    useTutorialStore.getState().skipTour()
    expect(useGuide.getState().active).toBe(false)
  })
})
