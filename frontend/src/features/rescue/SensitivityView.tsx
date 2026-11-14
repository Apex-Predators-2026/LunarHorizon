import type { SensitivityResponse } from './types'

const VERDICT_STYLE = {
  robust: 'text-emerald-400',
  sensitive: 'text-amber-400',
  fragile: 'text-red-400',
  fails: 'text-red-400',
} as const

export function SensitivityView({ data }: { data: SensitivityResponse }) {
  const datePts = data.points
    .filter((p) => p.distance_km === 0)
    .sort((a, b) => a.date_offset_hours - b.date_offset_hours)
  const posPts = data.points.filter((p) => p.distance_km > 0)
  const radii = [...new Set(posPts.map((p) => p.distance_km))].sort((a, b) => a - b)

  return (
    <section aria-label="Sensitivity analysis" className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs">
      <h3 className="text-sm font-medium text-slate-100">
        Sensitivity of {data.base.scenario.site.name}:{' '}
        <span className={VERDICT_STYLE[data.verdict]}>{data.verdict}</span>
      </h3>
      <p className="mt-1 text-slate-300">{data.explanation}</p>

      <h4 className="mt-2 text-slate-500">If the landing slips</h4>
      <div className="mt-1 flex flex-wrap gap-1">
        {datePts.map((p) => (
          <span
            key={p.date_offset_hours}
            title={p.passes ? 'passes' : `fails: ${p.failing_constraints.join(', ')}`}
            className={`rounded px-1.5 py-0.5 tabular-nums ${p.passes ? 'bg-emerald-950 text-emerald-300' : 'bg-red-950 text-red-300'}`}
          >
            {p.date_offset_hours > 0 ? '+' : ''}
            {p.date_offset_hours} h
          </span>
        ))}
      </div>

      <h4 className="mt-2 text-slate-500">If the lander touches down off target</h4>
      {data.position_pass_rate === null && (
        <p className="text-slate-400">Not checked: no real terrain data for points around this site yet.</p>
      )}
      {radii.map((r) => {
        const ring = posPts.filter((p) => p.distance_km === r)
        const ok = ring.filter((p) => p.passes).length
        return (
          <p key={r} className="tabular-nums text-slate-300">
            {r} km off: {ok}/{ring.length} directions still pass
          </p>
        )
      })}
    </section>
  )
}
