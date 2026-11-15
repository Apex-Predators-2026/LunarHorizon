import { openEvidence } from '../../viz/evidence'
import type { Entry } from './analysis'
import { compareEvidence } from './evidence'
import { scenarioDisplayName } from './scenario'
import type { CompareSectionId } from './sections'
import { ReqIcon, ScenarioChip } from './ui'

export function ShowWhy({ entry, constraintId, section }: { entry: Entry; constraintId?: string; section: CompareSectionId }) {
  const result = entry.result
  const constraint = result?.assessment?.constraints.find((c) => c.id === constraintId)
  const evidence = result && constraint
    ? compareEvidence(result, entry.scenario.site.id, constraint, entry.scenario.label, section)
    : { ok: false as const, reason: 'The assessment has no 3D evidence for this requirement.' }
  if (!evidence.ok) {
    return <span className="text-[11px] text-slate-500" data-testid="show-why-unavailable">{evidence.reason}</span>
  }
  return (
    <button type="button" onClick={() => openEvidence(evidence.request)}
      className="rounded-full bg-coral px-2 py-0.5 text-[11px] font-medium text-[#1f2326] hover:brightness-110"
      aria-label={`Show me why: ${constraint?.name ?? constraintId}, ${entry.scenario.name}`}
      data-tip={`Open this evidence in 3D and look toward the ${evidence.request.body === 'earth' ? 'Earth' : 'Sun'}`}>
      Show me why
    </button>
  )
}

export function RequirementEvidence({ entries }: { entries: Entry[] }) {
  const plans = entries.flatMap((entry) => {
    const issues = entry.result?.assessment?.constraints.filter((c) => c.status === 'fail' || c.status === 'unknown')
    return issues?.length ? [{ entry, issues }] : []
  })
  if (!plans.length) {
    return (
      <p className="text-xs text-slate-500">
        {entries.some((entry) => entry.result?.assessment)
          ? 'The assessed plans have no failed or undecided requirements.'
          : 'Requirement evidence appears once plans have been assessed.'}
      </p>
    )
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {plans.map(({ entry, issues }) => (
        <li key={entry.scenario.id} className="rounded-xl border border-line bg-inset p-3">
          <h3 className="flex items-center gap-2 text-sm font-medium text-ink">
            <ScenarioChip s={entry.scenario} size="sm" /> {scenarioDisplayName(entry.scenario)}
          </h3>
          <ul className="mt-2 space-y-2">
            {issues.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                <ReqIcon status={c.status} /> {c.name ?? c.id}
                <ShowWhy entry={entry} constraintId={c.id} section="cmp-why" />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}
