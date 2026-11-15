// Mission Rescue: when a plan slips or a requirement changes, search for alternative landing dates and sites that
// still work. (The Science vs engineering search now lives on the Scenario Comparison page.)
import { fmtUtc } from './format'
import { RescuePanel } from './RescuePanel'
import { useRescueStore } from './useRescueStore'
import { useTutorialStore } from '../tutorial'

export function MissionRescue() {
  const original = useRescueStore((s) => s.original)
  const selected = useRescueStore((s) => s.selected)

  return (
    <div data-tour="mission-rescue" className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-100" data-tip="When a plan slips or a requirement changes, search for alternative landing dates and sites that still work.">
        Mission rescue
      </h2>
      {selected && selected !== original && (
        <p className="text-xs text-sky-300">
          Viewing: {selected.site.name}, {fmtUtc(selected.landing_utc)}
        </p>
      )}

      <div
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) useTutorialStore.getState().recordInteraction('rescue-run')
        }}
      >
        <RescuePanel />
      </div>
    </div>
  )
}
