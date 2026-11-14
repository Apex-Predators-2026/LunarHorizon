// Zustand slice for Mission Rescue (Member 5).
// - `original` is the plan being rescued. PlanForm sets it; the mission configuration panel
//   can also call useRescueStore.getState().setOriginal(scenario).
// - `select(scenario)` marks the plan the user picked and pushes its site/time into the
//   shared app store, so the 3D view and timelines follow the choice.
import { create } from 'zustand'

import { useAppStore } from '../../store'
import type { Scenario } from '../../types'
import { errorMessage, runCompromise, runRescue, runSensitivity } from './api'
import type {
  CompromiseResponse,
  PlanChange,
  RescueResponse,
  ScienceGoal,
  SearchOptions,
  SensitivityResponse,
} from './types'

export type Status = 'idle' | 'loading' | 'done' | 'error'

export const isCustomSite = (id: string) => id.startsWith('custom:')

interface RescueState {
  original: Scenario | null
  change: PlanChange
  search: SearchOptions
  science: ScienceGoal
  weights: { engineering: number; science: number }

  rescue: RescueResponse | null
  rescueStatus: Status
  sensitivity: SensitivityResponse | null
  sensitivityStatus: Status
  compromise: CompromiseResponse | null
  compromiseStatus: Status
  error: string | null

  /** Plan the user picked from the results (alternative, loosening, compromise...). */
  selected: Scenario | null

  setOriginal: (s: Scenario) => void
  setChange: (c: Partial<PlanChange>) => void
  setSearch: (s: Partial<SearchOptions>) => void
  setScience: (g: Partial<ScienceGoal>) => void
  setWeights: (w: Partial<{ engineering: number; science: number }>) => void
  select: (s: Scenario | null) => void

  findAlternatives: () => Promise<void>
  checkSensitivity: (s: Scenario) => Promise<void>
  findCompromise: () => Promise<void>
  reset: () => void
}

const initialResults = {
  rescue: null,
  rescueStatus: 'idle' as Status,
  sensitivity: null,
  sensitivityStatus: 'idle' as Status,
  compromise: null,
  compromiseStatus: 'idle' as Status,
  error: null,
  selected: null,
}

export const useRescueStore = create<RescueState>((set, get) => ({
  original: null,
  change: { launch_delay_days: 0, requirement_overrides: {} },
  search: { date_window_days: 30, date_step_hours: 12, top_n: 5 },
  science: { target_psr_id: 'shackleton-psr', max_traverse_km: 15, min_science_score: 0.5 },
  weights: { engineering: 0.5, science: 0.5 },
  ...initialResults,

  // A new plan makes old results meaningless.
  setOriginal: (original) => set({ original, ...initialResults }),
  setChange: (c) => set({ change: { ...get().change, ...c } }),
  setSearch: (s) => set({ search: { ...get().search, ...s } }),
  setScience: (g) => set({ science: { ...get().science, ...g } }),
  setWeights: (w) => set({ weights: { ...get().weights, ...w } }),

  select: (selected) => {
    set({ selected })
    if (selected) {
      const app = useAppStore.getState()
      if (!isCustomSite(selected.site.id)) app.setSite(selected.site.id)
      app.setTime(selected.landing_utc)
    }
  },

  findAlternatives: async () => {
    const { original, change, search } = get()
    if (!original) return set({ error: 'Pick a landing site and date first.' })
    set({ rescueStatus: 'loading', error: null, sensitivity: null, sensitivityStatus: 'idle' })
    try {
      const rescue = await runRescue({ original, change, search })
      set({ rescue, rescueStatus: 'done' })
      const best = rescue.alternatives[0]?.scenario
      if (best) get().select(best)
    } catch (e) {
      set({ rescueStatus: 'error', error: errorMessage(e) })
    }
  },

  checkSensitivity: async (scenario) => {
    set({ sensitivityStatus: 'loading', error: null })
    try {
      set({ sensitivity: await runSensitivity({ scenario }), sensitivityStatus: 'done' })
    } catch (e) {
      set({ sensitivityStatus: 'error', error: errorMessage(e) })
    }
  },

  findCompromise: async () => {
    const { original, science, weights, search } = get()
    if (!original) return set({ error: 'Pick a landing site and date first.' })
    set({ compromiseStatus: 'loading', error: null })
    try {
      const compromise = await runCompromise({
        scenario: original,
        science,
        engineering_weight: weights.engineering,
        science_weight: weights.science,
        search,
      })
      set({ compromise, compromiseStatus: 'done' })
    } catch (e) {
      set({ compromiseStatus: 'error', error: errorMessage(e) })
    }
  },

  reset: () => set(initialResults),
}))
