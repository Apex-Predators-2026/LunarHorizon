// Integration with Mission Rescue (Member 5 / Arush): bring the delayed plan and its recommended
// alternatives into the comparison. Read-only use of the rescue store; nothing is re-optimised here.
import { KIND_LABEL } from '../rescue/format'
import { useRescueStore } from '../rescue/useRescueStore'
import { sendToComparison } from './useCompareStore'
import { btnPrimary } from './ui'

export function RescueImport() {
  const rescue = useRescueStore((s) => s.rescue)
  if (!rescue) {
    return (
      <p className="text-[11px] text-slate-500">
        Tip: run <span className="text-slate-300">Mission rescue</span> in the planner to compare its recommended alternatives here.
      </p>
    )
  }
  const alts = rescue.alternatives.slice(0, 3)
  const importAll = () =>
    sendToComparison([rescue.changed.scenario, ...alts.map((a) => a.scenario)], {
      origin: 'rescue',
      names: [`Delayed plan · ${rescue.changed.scenario.site.name}`, ...alts.map((a) => `Rescue #${a.rank} · ${a.scenario.site.name} (${KIND_LABEL[a.kind]})`)],
      notes: ['Plan after the change, as evaluated by Mission Rescue', ...alts.map((a) => a.headline)],
    })
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-900/70 bg-sky-950/20 px-3 py-2 text-xs">
      <span className="text-sky-200">
        Mission Rescue has {rescue.alternatives.length} alternative{rescue.alternatives.length === 1 ? '' : 's'} for{' '}
        <strong>{rescue.changed.scenario.site.name}</strong>.
      </span>
      <button type="button" className={btnPrimary} disabled={!alts.length} onClick={importAll}>
        Compare delayed plan + top {alts.length} alternatives
      </button>
      <span className="text-slate-500">The delayed plan becomes the baseline, so every metric shows how much each alternative improves or worsens it.</span>
    </div>
  )
}
