// Zustand slice for Mission Rescue (Member 5).
// - `original` is the plan being rescued. PlanForm sets it; the mission configuration panel
//   can also call useRescueStore.getState().setOriginal(scenario).
// - `select(scenario)` marks the plan the user picked and pushes its site/time into the
//   shared app store, so the 3D view and timelines follow the choice.
import { create } from 'zustand'

import { useAppStore } from '../../store'
import { usePlansStore } from '../plans/usePlansStore'
import type { Scenario } from '../../types'
import { errorMessage, runCompromise, runRescue, runSensitivity } from './api'
import type {
  CompromiseResponse,
  PlanChange,
  RescueCatalog,
  RescueResponse,
  ScienceGoal,
  SearchOptions,
  SensitivityResponse,
} from './types'

export type Status = 'idle' | 'loading' | 'done' | 'error'

export const isCustomSite = (id: string) => id.startsWith('custom:')

interface RescueState {
  original: Scenario | null
  /** Saved plan the original scenario was captured from (matched by identity), or null. */
  originalPlanId: string | null
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
  /** Which plan the compromise result is for (site, landing, length), so another page can tell if it is current. */
  compromiseFor: string | null
  /** One error per request kind, so a failure only shows in the tab that caused it. */
  rescueError: string | null
  sensitivityError: string | null
  compromiseError: string | null

  /** Plan the user picked from the results (alternative, loosening, compromise...). */
  selected: Scenario | null
  /** "Show on map" switch: draw the rescue result in the 3D view. */
  showOnMap: boolean
  /** "Explain" switch: show a step-by-step walkthrough above the alternatives. */
  explain: boolean
  /** Site catalog (coordinates) for the 3D overlay; loaded once. */
  catalog: RescueCatalog | null

  setShowOnMap: (v: boolean) => void
  setExplain: (v: boolean) => void
  setCatalog: (c: RescueCatalog) => void
  setOriginal: (s: Scenario) => void
  setChange: (c: Partial<PlanChange>) => void
  setSearch: (s: Partial<SearchOptions>) => void
  setScience: (g: Partial<ScienceGoal>) => void
  setWeights: (w: Partial<{ engineering: number; science: number }>) => void
  select: (s: Scenario | null) => void

  findAlternatives: () => Promise<void>
  checkSensitivity: (s: Scenario) => Promise<void>
  /** `base` lets another page (Scenario Comparison) ask about a plan other than the Rescue plan. */
  findCompromise: (base?: Scenario) => Promise<void>
  reset: () => void
}

const initialResults = {
  rescue: null,
  rescueStatus: 'idle' as Status,
  sensitivity: null,
  sensitivityStatus: 'idle' as Status,
  compromise: null,
  compromiseStatus: 'idle' as Status,
  compromiseFor: null as string | null,
  rescueError: null,
  sensitivityError: null,
  compromiseError: null,
  selected: null,
}

// Latest request per kind. A response or error is applied only if no newer request of the same
// kind (or a new plan / reset) has started since, so a slow old search can't overwrite a newer one.
type Kind = 'rescue' | 'sensitivity' | 'compromise'
const latest: Record<Kind, { id: number; ctl: AbortController | null }> = {
  rescue: { id: 0, ctl: null },
  sensitivity: { id: 0, ctl: null },
  compromise: { id: 0, ctl: null },
}
/** Start a request of this kind: supersedes (and aborts) the previous one. */
function begin(kind: Kind) {
  const l = latest[kind]
  l.ctl?.abort()
  l.ctl = new AbortController()
  const id = ++l.id
  return { signal: l.ctl.signal, current: () => id === latest[kind].id }
}
function invalidateKind(kind: Kind) {
  const l = latest[kind]
  l.ctl?.abort()
  l.ctl = null
  l.id++
}
function invalidateAll() {
  for (const kind of Object.keys(latest) as Kind[]) invalidateKind(kind)
}

export const useRescueStore = create<RescueState>((set, get) => ({
  original: null,
  originalPlanId: null,
  change: { launch_delay_days: 0, requirement_overrides: {} },
  search: { date_window_days: 30, date_step_hours: 12, top_n: 5 },
  science: { target_psr_id: 'shackleton-psr', max_traverse_km: 15, min_science_score: 0.5 },
  weights: { engineering: 0.5, science: 0.5 },
  ...initialResults,
  showOnMap: true,
  explain: false,
  catalog: null,
  setShowOnMap: (showOnMap) => set({ showOnMap }),
  setExplain: (explain) => set({ explain }),
  setCatalog: (catalog) => set({ catalog }),

  // A new plan makes old results meaningless.
  setOriginal: (original) => {
    invalidateAll()
    // Plans Run passes the saved plan's own scenario object, so an identity match means "from that plan".
    const plan = usePlansStore.getState().plans.find((p) => p.scenario === original)
    set({ original, originalPlanId: plan?.id ?? null, ...initialResults })
  },
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
    if (!original) return set({ rescueStatus: 'error', rescueError: 'Pick a landing site and date first.' })
    const req = begin('rescue')
    invalidateKind('sensitivity')
    set({ rescueStatus: 'loading', rescueError: null, sensitivity: null, sensitivityStatus: 'idle', sensitivityError: null })
    try {
      const rescue = await runRescue({ original, change, search }, req.signal)
      if (!req.current()) return
      set({ rescue, rescueStatus: 'done' })
      const best = rescue.alternatives[0]?.scenario
      if (best) get().select(best)
    } catch (e) {
      if (!req.current()) return
      set({ rescueStatus: 'error', rescueError: errorMessage(e) })
    }
  },

  checkSensitivity: async (scenario) => {
    const req = begin('sensitivity')
    set({ sensitivityStatus: 'loading', sensitivityError: null })
    try {
      const sensitivity = await runSensitivity({ scenario }, req.signal)
      if (!req.current()) return
      set({ sensitivity, sensitivityStatus: 'done' })
    } catch (e) {
      if (!req.current()) return
      set({ sensitivityStatus: 'error', sensitivityError: errorMessage(e) })
    }
  },

  findCompromise: async (base) => {
    const { science, weights, search } = get()
    const original = base ?? get().original
    if (!original) return set({ compromiseStatus: 'error', compromiseError: 'Pick a landing site and date first.' })
    const req = begin('compromise')
    set({ compromiseStatus: 'loading', compromiseError: null })
    try {
      const compromise = await runCompromise({
        scenario: original,
        science,
        engineering_weight: weights.engineering,
        science_weight: weights.science,
        search,
      }, req.signal)
      if (!req.current()) return
      set({ compromise, compromiseStatus: 'done', compromiseFor: `${original.site.id}|${original.landing_utc}|${original.duration_days}` })
    } catch (e) {
      if (!req.current()) return
      set({ compromiseStatus: 'error', compromiseError: errorMessage(e) })
    }
  },

  reset: () => {
    invalidateAll()
    set(initialResults)
  },
}))
