// Integration with Mission Rescue (Member 5 / Arush): bring the original plan, the changed plan and Rescue's top
// alternatives into the comparison, and remember each one's role for the rescue story. Read-only use of the rescue
// store; nothing is re-optimised here, and every imported plan is re-assessed by the canonical engine.
import { useRescueStore } from '../rescue/useRescueStore'
import { describeChange, rescueImportPlan } from './rescueFlow'
import { btnPrimary } from './ui'
import { sendToComparison, useCompareStore } from './useCompareStore'

export function RescueImport() {
  const rescue = useRescueStore((s) => s.rescue)
  const change = useRescueStore((s) => s.change)
  const setRescueContext = useCompareStore((s) => s.setRescueContext)
  if (!rescue) {
    return (
      <p className="text-[11px] text-slate-500">
        Tip: run <span className="text-slate-300">Mission rescue</span> in the planner to compare its recommended alternatives here.
      </p>
    )
  }
  const plan = rescueImportPlan(rescue)
  const alts = plan.roles.filter((r) => r.role === 'alternative').length
  const importAll = () => {
    const ids = sendToComparison(plan.scenarios, { origin: 'rescue', names: plan.names, notes: plan.notes,
      baselineIndex: plan.includesOriginal ? 1 : 0 }) // the changed plan is the baseline: deltas show what each alternative fixes
    setRescueContext({
      importedAt: new Date().toISOString(),
      status: rescue.status,
      summary: rescue.summary,
      change: describeChange(change),
      roles: Object.fromEntries(ids.map((id, i) => [id, plan.roles[i]])),
    })
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-900/70 bg-sky-950/20 px-3 py-2 text-xs">
      <span className="text-sky-200">
        Mission Rescue has {rescue.alternatives.length} alternative{rescue.alternatives.length === 1 ? '' : 's'} for{' '}
        <strong>{rescue.changed.scenario.site.name}</strong>.
      </span>
      <button type="button" className={btnPrimary} onClick={importAll}>
        Compare {plan.includesOriginal ? 'original, changed plan' : 'the changed plan'}{alts ? ` and top ${alts} alternative${alts > 1 ? 's' : ''}` : ''}
      </button>
      <span className="text-slate-500">
        The changed plan becomes the baseline. Every plan is re-assessed here, so an alternative is only called a fix if it really passes.
      </span>
    </div>
  )
}
