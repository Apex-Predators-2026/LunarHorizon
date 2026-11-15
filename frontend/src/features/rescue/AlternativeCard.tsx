import { resolveHeadroom } from '../../lib/headroom'
import { verdictOf } from '../../types'
import { PassHeadroom, PassHeadroomBadge } from '../../ui/PassHeadroom'
import { KIND_LABEL, fmtDelta, fmtShift, fmtUtc, fmtValue } from './format'
import type { Alternative, DateSlipCheck, Robustness } from './types'

const VERDICT_STYLE = {
  robust: 'bg-emerald-950 text-emerald-300 ring-emerald-800',
  sensitive: 'bg-amber-950 text-amber-300 ring-amber-800',
  fragile: 'bg-red-950 text-red-300 ring-red-800',
  unchecked: 'bg-slate-800 text-slate-300 ring-slate-600',
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

function fmtOffset(h: number): string {
  return `${h > 0 ? '+' : ''}${h} h`
}

function fmtSlipMargin(c: DateSlipCheck): string | null {
  if (c.closest_headroom_text) return c.closest_headroom_text
  if (c.darkness_headroom_h !== null && c.darkness_headroom_h !== undefined) {
    const val = Math.abs(c.darkness_headroom_h - Math.round(c.darkness_headroom_h)) < 0.05
      ? Math.round(c.darkness_headroom_h)
      : Number(c.darkness_headroom_h.toFixed(1))
    return `${val > 0 ? '+' : ''}${val} h dark`
  }
  if (c.comms_headroom_h !== null && c.comms_headroom_h !== undefined) {
    const val = Math.abs(c.comms_headroom_h - Math.round(c.comms_headroom_h)) < 0.05
      ? Math.round(c.comms_headroom_h)
      : Number(c.comms_headroom_h.toFixed(1))
    return `${val > 0 ? '+' : ''}${val} h comms`
  }
  return null
}

function slipTitle(c: DateSlipCheck, limited: boolean, margin: string | null): string {
  if (c.status === 'fail' && c.failing_constraints.length) {
    return `fails: ${c.failing_constraints.join(', ')}`
  }
  if (c.status === 'pass') {
    const base = c.closest_label && margin ? `${c.closest_label}: ${margin}` : margin ?? 'passes tested offset'
    return limited ? `${base} (limited margin)` : base
  }
  return c.status === 'not_evaluated' ? 'not evaluated' : c.status
}

/** Separated date-slip checks showing pass/fail + closest headroom per tested offset. */
export function DateSlipChecks({
  robustness,
  title = 'Tested date-slip checks',
}: {
  robustness: Robustness
  title?: string
}) {
  const checks = robustness.date_checks ?? []
  if (checks.length === 0 && !robustness.date_note) return null

  return (
    <div className="mt-2 rounded border border-slate-800 bg-slate-900/50 p-2 text-[11px]" data-testid="date-slip-checks">
      <div className="flex flex-wrap items-center justify-between gap-2 text-slate-300">
        <span className="font-medium">{title}</span>
        {typeof robustness.date_checked === 'number' && robustness.date_checked > 0 && (
          <span className="tabular-nums text-slate-400">
            {robustness.date_passing ?? 0}/{robustness.date_checked} tested slips pass
          </span>
        )}
      </div>
      {checks.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {checks.map((c) => {
            const limited =
              c.status === 'pass' && (c.headroom_status === 'limited' || c.headroom_status === 'at_threshold')
            const margin = fmtSlipMargin(c)
            const toneClass =
              c.status === 'pass'
                ? limited
                  ? 'border border-amber-800 bg-amber-950/70 text-amber-200'
                  : 'border border-emerald-800 bg-emerald-950/70 text-emerald-200'
                : c.status === 'fail'
                  ? 'border border-red-800 bg-red-950/70 text-red-200'
                  : c.status === 'unknown'
                    ? 'border border-slate-700 bg-slate-800 text-slate-300'
                    : 'border border-dashed border-slate-700 text-slate-400'
            const statusText =
              c.status === 'pass'
                ? limited
                  ? `pass · limited${margin ? ` (${margin})` : ''}`
                  : `pass${margin ? ` (${margin})` : ''}`
                : c.status === 'not_evaluated'
                  ? 'n/a'
                  : c.status
            return (
              <span
                key={c.date_offset_hours}
                title={slipTitle(c, limited, margin)}
                data-limited={limited ? 'true' : undefined}
                className={`rounded px-1.5 py-0.5 tabular-nums ${toneClass}`}
              >
                {fmtOffset(c.date_offset_hours)}: {statusText}
              </span>
            )
          })}
        </div>
      )}
      {robustness.date_note && <p className="mt-1 text-slate-400">{robustness.date_note}</p>}
    </div>
  )
}

interface Props {
  alt: Alternative
  selected: boolean
  onSelect: () => void
  onCheckSensitivity: () => void
}

/** How far this passing option is from its limits: canonical headroom + screening note. */
export function Headroom({ alt }: { alt: Alternative }) {
  const hr = resolveHeadroom(alt.viability)
  return <PassHeadroom headroom={hr} surface="planner" compact className="mt-2" />
}

export function AlternativeCard({ alt, selected, onSelect, onCheckSensitivity }: Props) {
  const { scenario, viability, robustness } = alt
  const hr = resolveHeadroom(viability)
  const elig = verdictOf(viability)
  const rows = alt.improvements.filter((m) => m.metric !== 'score' && m.better !== null)

  return (
    <article
      aria-label={`Alternative ${alt.rank}: ${scenario.site.name}`}
      className={`rounded-md border p-3 ${selected ? 'border-sky-500 bg-sky-950/30' : 'border-slate-800 bg-slate-900/40'}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs text-slate-500">#{alt.rank}</span>
            <span className="font-medium text-slate-100">{scenario.site.name}</span>
            <span className="text-xs text-slate-400">{KIND_LABEL[alt.kind]}</span>
            <DataBadge source={viability.data_source} />
            <PassHeadroomBadge headroom={hr} eligibility={elig} surface="planner" />
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {fmtUtc(scenario.landing_utc)} · {fmtShift(alt.date_shift_hours)}
            {alt.distance_km > 0.01 && <> · {alt.distance_km.toFixed(1)} km away</>}
          </p>
          {elig === 'pass' && <PassHeadroom headroom={hr} surface="planner" compact className="mt-2" />}
        </div>
        <div className="shrink-0 text-right">
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

      {robustness && robustness.verdict !== 'unchecked' && (
        <DateSlipChecks robustness={robustness} />
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {robustness && (
          <div className="min-w-0 flex-1 space-y-1">
            <span
              title={robustness.note}
              className={`inline-block rounded px-1.5 py-0.5 text-[11px] ring-1 ${VERDICT_STYLE[robustness.verdict]}`}
            >
              {robustness.verdict === 'unchecked'
                ? 'Not checked'
                : `${robustness.verdict} · ${robustness.passing_points}/${robustness.checked_points} nearby checks pass`}
            </span>
            {robustness.verdict !== 'unchecked' && robustness.note && (
              <p className="text-[11px] text-slate-400" data-testid="position-checks-note">
                {robustness.note}
              </p>
            )}
          </div>
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
