// "Open in Planner": the selected Atlas cell becomes a saved plan, run in the Mission Planner exactly as the
// Plans panel's Run button does (Rescue's original plan, the site and time on the map, the active plan).
import { goToView } from '../../appRoute'
import { useAppStore } from '../../store'
import type { Scenario } from '../../types'
import { showSnackbar } from '../../viz/snackbarStore'
import { usePlansStore } from '../plans/usePlansStore'
import { useRescueStore } from '../rescue/useRescueStore'

export function openInPlanner(name: string, scenario: Scenario): string {
  const id = usePlansStore.getState().add(name, scenario)
  useRescueStore.getState().setOriginal(scenario)
  const app = useAppStore.getState()
  app.setSite(scenario.site.id)
  app.setTime(scenario.landing_utc)
  usePlansStore.getState().setActive(id)
  showSnackbar(`Running ${name} in the Mission Planner`, 'success')
  goToView('planner')
  return id
}
