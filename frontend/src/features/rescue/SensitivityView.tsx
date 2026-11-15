import type { SensitivityPoint, SensitivityResponse, SensitivityStatus } from './types'

const VERDICT_STYLE = {
  robust: 'text-emerald-400',
  sensitive: 'text-amber-400',
  fragile: 'text-red-400',
  fails: 'text-red-400',
  unknown: 'text-slate-300',
  not_assessed: 'text-slate-300',
} as const

const VERDICT_LABEL = { not_assessed: 'not assessed' } as const

const STATUS_STYLE: Record<SensitivityStatus, string> = {
  pass: 'bg-emerald-950 text-emerald-300',
  fail: 'bg-red-950 text-red-300',
  unknown: 'bg-slate-800 text-slate-300 ring-1 ring-slate-600',
  not_evaluated: 'border border-dashed border-slate-700 text-slate-500',
}

const STATUS_LABEL: Record<SensitivityStatus, string> = {
  pass: 'passes',
  fail: 'fails',
  unknown: 'unknown (real data incomplete)',
  not_evaluated: 'not evaluated',
}

function pointTitle(p: SensitivityPoint): string {
  return p.status === 'fail' && p.failing_constraints.length
    ? `fails: ${p.failing_constraints.join(', ')}`
    : STATUS_LABEL[p.status]
}

export function SensitivityView({ data }: { data: SensitivityResponse }) {
  const datePts = data.points
    .filter((p) => p.distance_km === 0)
    .sort((a, b) => a.date_offset_hours - b.date_offset_hours)
  const posPts = data.points.filter((p) => p.distance_km > 0)
  const radii = [...new Set(posPts.map((p) => p.distance_km))].sort((a, b) => a - b)
  const c = data.counts

  return (
    <section aria-label="Sensitivity analysis" className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs">
      <h3 className="text-sm font-medium text-slate-100">
        Sensitivity of {data.base.scenario.site.name}:{' '}
        <span className={VERDICT_STYLE[data.verdict]}>
          {data.verdict === 'not_assessed' ? VERDICT_LABEL.not_assessed : data.verdict}
        </span>
      </h3>
      <p className="mt-1 text-slate-300">{data.explanation}</p>
      {c && (
        <p className="mt-1 tabular-nums text-slate-400">
          {`${c.requested} points requested: ${c.evaluated} evaluated (${c.passed} pass, ${c.failed} fail, ${c.unknown} unknown), ${c.skipped} not evaluated`}
        </p>
      )}

      <h4 className="mt-2 text-slate-500">If the landing slips</h4>
      <div className="mt-1 flex flex-wrap gap-1">
        {datePts.map((p) => (
          <span
            key={p.date_offset_hours}
            title={pointTitle(p)}
            className={`rounded px-1.5 py-0.5 tabular-nums ${STATUS_STYLE[p.status]}`}
          >
            {p.date_offset_hours > 0 ? '+' : ''}
            {p.date_offset_hours} h <span className="sr-only">{STATUS_LABEL[p.status]}</span>
          </span>
        ))}
      </div>

      <h4 className="mt-2 text-slate-500">If the lander touches down off target</h4>
      {posPts.length === 0 && <p className="text-slate-400">Not requested.</p>}
      {posPts.length > 0 && data.position_pass_rate === null && (
        <p className="text-slate-400">
          Not checked: no real terrain data for points around this site yet, so passing date slips says nothing about
          landing-position error.
        </p>
      )}
      {radii.map((r) => {
        const ring = posPts.filter((p) => p.distance_km === r)
        const ok = ring.filter((p) => p.status === 'pass').length
        const decided = ring.filter((p) => p.status === 'pass' || p.status === 'fail').length
        const rest = ring.length - decided
        return (
          <div key={r} className="mt-1">
            <p className="tabular-nums text-slate-300">
              {decided === 0
                ? `${r} km off: no directions could be tested`
                : `${r} km off: ${ok}/${decided} tested directions still pass` +
                  (rest > 0 ? ` (${rest} not evaluated or unknown)` : '')}
            </p>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {ring.map((p) => (
                <span
                  key={`${r}-${p.bearing_deg}`}
                  title={pointTitle(p)}
                  className={`rounded px-1.5 py-0.5 tabular-nums ${STATUS_STYLE[p.status]}`}
                >
                  {p.bearing_deg?.toFixed(0)}° <span className="sr-only">{STATUS_LABEL[p.status]}</span>
                </span>
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}
