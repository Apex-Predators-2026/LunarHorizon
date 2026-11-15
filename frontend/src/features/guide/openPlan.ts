// Open a scenario as the running plan, as the Plans panel's Run button does: saved as a plan card (never duplicated),
// used by Mission assessment and Rescue, and shown in the 3D view at its site and landing time. Recovered from the
// source branch's plans/openPlan.ts (c6fde69 / 06e1c04); kept in the guide so the Planner's files are not edited.
import { useAppStore } from '../../store'
import type { Scenario } from '../../types'
import { clearEvidence } from '../../viz/evidence'
import { usePlansStore } from '../plans/usePlansStore'
import { useRescueStore } from '../rescue/useRescueStore'
import { goTo } from './nav'

const sameScenario = (a: Scenario, b: Scenario) => JSON.stringify(a) === JSON.stringify(b)

export function openScenarioInPlanner(scenario: Scenario, name: string, opts: { save?: boolean } = {}): string | null {
  clearEvidence()
  let id: string | null = null
  if (opts.save !== false) {
    const plans = usePlansStore.getState()
    const label = name.slice(0, 40) // plan names are limited to 40 characters (PlanDialog)
    const existing = plans.plans.find((p) => p.name === label && sameScenario(p.scenario, scenario))
    id = existing?.id ?? plans.add(label, scenario)
    plans.setActive(id)
  }
  const rescue = useRescueStore.getState()
  rescue.reset()
  rescue.setOriginal(id ? (usePlansStore.getState().plans.find((p) => p.id === id)?.scenario ?? scenario) : scenario)
  const app = useAppStore.getState()
  app.setPlaying(false)
  if (!scenario.site.id.startsWith('custom:')) app.setSite(scenario.site.id)
  app.setTime(scenario.landing_utc)
  goTo('planner')
  return id
}
