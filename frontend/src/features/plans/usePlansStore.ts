// Saved mission plans for the Mission Planner sidebar. Each plan is a name plus the same Scenario the
// rescue tools use, so running a plan simply makes it the rescue tools' plan. Kept in localStorage.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { guardedMerge, isPlan, isString } from '../../lib/persistGuard'
import type { Scenario } from '../../types'
import type { ScenarioOrigin, SpacecraftConfig } from '../compare/types'

export interface Plan {
  id: string
  name: string
  scenario: Scenario
  spacecraft?: SpacecraftConfig
  notes?: string
  origin?: ScenarioOrigin
}

interface PlansState {
  plans: Plan[]
  activeId: string | null // the plan last run
  compareIds: string[] // plans ticked for comparison
  add: (name: string, scenario: Scenario, details?: Pick<Plan, 'spacecraft' | 'notes'>) => string
  addPlans: (plans: Plan[]) => void
  update: (id: string, name: string, scenario: Scenario, details?: Pick<Plan, 'spacecraft' | 'notes'>) => void
  remove: (id: string) => void
  setActive: (id: string | null) => void
  toggleCompare: (id: string) => void
}

let counter = 0
const newId = () => `plan-${Date.now().toString(36)}-${(counter++).toString(36)}`

export const usePlansStore = create<PlansState>()(
  persist(
    (set) => ({
      plans: [],
      activeId: null,
      compareIds: [],
      add: (name, scenario, details) => {
        const id = newId()
        set((s) => ({ plans: [...s.plans, { id, name, scenario, ...details }] }))
        return id
      },
      addPlans: (plans) => {
        if (plans.length) set((s) => ({ plans: [...s.plans, ...plans] }))
      },
      update: (id, name, scenario, details) => set((s) => ({
        plans: s.plans.map((p) => (p.id === id ? { ...p, ...details, name, scenario } : p)),
      })),
      remove: (id) =>
        set((s) => ({
          plans: s.plans.filter((p) => p.id !== id),
          activeId: s.activeId === id ? null : s.activeId,
          compareIds: s.compareIds.filter((x) => x !== id),
        })),
      setActive: (id) => set({ activeId: id }),
      toggleCompare: (id) =>
        set((s) => ({ compareIds: s.compareIds.includes(id) ? s.compareIds.filter((x) => x !== id) : [...s.compareIds, id] })),
    }),
    {
      name: 'lunar-plans',
      storage: createJSONStorage(() => localStorage),
      // The comparison reads saved plans at startup: a malformed one must not stop the app from loading.
      merge: guardedMerge<PlansState>({ plans: isPlan, activeId: isString, compareIds: isString }),
    },
  ),
)

/** Which plan (if any) the New / Edit plan dialog is showing. The dialog is opened from the floating + button or a plan card. */
interface PlanDialogState {
  open: boolean
  plan: Plan | null // null = a new plan
  show: (plan?: Plan | null) => void
  hide: () => void
}
export const usePlanDialog = create<PlanDialogState>((set) => ({
  open: false,
  plan: null,
  show: (plan = null) => set({ open: true, plan }),
  hide: () => set({ open: false }),
}))

export function editSavedPlan(id: string) {
  const plan = usePlansStore.getState().plans.find((p) => p.id === id)
  if (plan) usePlanDialog.getState().show(plan)
}
