import { KIND_LABEL, fmtDelta, fmtShift, fmtUtc, fmtValue } from './format'
import type { Alternative } from './types'

const VERDICT_STYLE = {
  robust: 'bg-emerald-950 text-emerald-300 ring-emerald-800',
  sensitive: 'bg-amber-950 text-amber-300 ring-amber-800',
  fragile: 'bg-red-950 text-red-300 ring-red-800',
} as const

export function DataBadge({ source }: { source: string }) {
  const real = source.startsWith('precomputed')
  return (
    <span
      title={real ? `Real data (${source.replace('precomputed:', '')})` : 'Synthetic placeholder data'}
      className={`rounded px-1 text-[10px] ring-1 ${real ? 'text-sky-300 ring-sky-800' : 'text-amber-300 ring-amber-800'}`}
    >
      {real ? 'real data' : 'synthetic'}
    </span>
  )
}

interface Props {
  alt: Alternative
  selected: boolean
  onSelect: () => void
  onCheckSensitivity: () => void
}

export function AlternativeCard({ alt, selected, onSelect, onCheckSensitivity }: Props) {
  const { scenario, viability, robustness } = alt
  const rows = alt.improvements.filter((m) => m.metric !== 'score' && m.better !== null)

  return (
    <article
      aria-label={`Alternative ${alt.rank}: ${scenario.site.name}`}
      className={`rounded-md border p-3 ${selected ? 'border-sky-500 bg-sky-950/30' : 'border-slate-800 bg-slate-900/40'}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-xs text-slate-500">#{alt.rank}</span>
            <span className="font-medium text-slate-100">{scenario.site.name}</span>
            <span className="text-xs text-slate-400">{KIND_LABEL[alt.kind]}</span>
            <DataBadge source={viability.data_source} />
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {fmtUtc(scenario.landing_utc)} · {fmtShift(alt.date_shift_hours)}
            {alt.distance_km > 0.01 && <> · {alt.distance_km.toFixed(1)} km away</>}
          </p>
        </div>
        <div className="text-right">
          <div className="text-xl font-semibold tabular-nums text-slate-100">{viability.score?.toFixed(0) ?? '—'}</div>
          <div className="text-[11px] text-slate-500">score</div>
        </div>
      </header>

      <ul className="mt-2 space-y-0.5 text-xs text-slate-300">
        {alt.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      {rows.length > 0 && (
        <table className="mt-2 w-full text-xs">
          <caption className="sr-only">Metric changes compared with the delayed plan</caption>
          <thead>
            <tr className="text-left text-slate-500">
              <th className="font-normal">Metric</th>
              <th className="font-normal">Delayed</th>
              <th className="font-normal">This</th>
              <th className="font-normal">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.metric} className="border-t border-slate-800">
                <td className="py-0.5 text-slate-300">{m.label}</td>
                <td className="tabular-nums text-slate-400">{fmtValue(m.before, m.unit)}</td>
                <td className="tabular-nums text-slate-200">{fmtValue(m.after, m.unit)}</td>
                <td className={`tabular-nums ${m.better ? 'text-emerald-400' : 'text-red-400'}`}>{fmtDelta(m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {robustness && (
          <span
            title={robustness.note}
            className={`rounded px-1.5 py-0.5 text-[11px] ring-1 ${VERDICT_STYLE[robustness.verdict]}`}
          >
            {robustness.verdict} · {robustness.passing_points}/{robustness.checked_points} nearby checks pass
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onCheckSensitivity}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            Sensitivity
          </button>
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            className="rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-500"
          >
            {selected ? 'Selected' : 'Use this plan'}
          </button>
        </div>
      </footer>
    </article>
  )
}
