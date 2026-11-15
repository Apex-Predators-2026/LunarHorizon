import { resolveHeadroom } from '../../lib/headroom'
import { verdictOf } from '../../types'
import { PassHeadroomBadge } from '../../ui/PassHeadroom'
import { REASON_LABEL, reasonBreakdown } from './format'
import type { SensitivityPoint, SensitivityResponse, SensitivityStatus, UndecidedReason } from './types'

const DEFAULT_SENSITIVITY_SCREENING_NOTE =
  'Model screening across discrete tested offsets only; not a guarantee between tested points or of spacecraft survival.'

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
  pass: 'border border-emerald-800/70 bg-emerald-950 text-emerald-200',
  fail: 'border border-red-800/70 bg-red-950 text-red-200',
  unknown: 'bg-slate-800 text-slate-300 ring-1 ring-slate-600',
  not_evaluated: 'border border-dashed border-slate-700 text-slate-500',
}

const LIMITED_PASS_STYLE = 'border border-amber-800 bg-amber-950 text-amber-200'

const STATUS_LABEL: Record<SensitivityStatus, string> = {
  pass: 'passes',
  fail: 'fails',
  unknown: 'unknown (real data incomplete)',
  not_evaluated: 'not evaluated',
}

/** Short pill text for an undecided point. */
const REASON_SHORT: Record<UndecidedReason, string> = {
  incomplete_data: 'unknown · gap',
  outside_coverage: 'unknown · no data',
  no_real_data: 'unknown · no data',
  position_unsupported: 'n/a',
}

function statusLabel(p: SensitivityPoint): string {
  return p.reason && p.status !== 'pass' && p.status !== 'fail' ? REASON_LABEL[p.reason] : STATUS_LABEL[p.status]
}


function fmtOffset(h: number): string {
  return `${h > 0 ? '+' : ''}${h} h`
}

function pointHeadroomSnippet(p: SensitivityPoint): string | null {
  if (p.status !== 'pass') return null
  if (p.closest_headroom_text) return p.closest_headroom_text
  if (p.darkness_headroom_h !== null && p.darkness_headroom_h !== undefined) {
    const v = Math.abs(p.darkness_headroom_h - Math.round(p.darkness_headroom_h)) < 0.05
      ? Math.round(p.darkness_headroom_h)
      : Number(p.darkness_headroom_h.toFixed(1))
    return `${v > 0 ? '+' : ''}${v} h dark`
  }
  if (p.comms_headroom_h !== null && p.comms_headroom_h !== undefined) {
    const v = Math.abs(p.comms_headroom_h - Math.round(p.comms_headroom_h)) < 0.05
      ? Math.round(p.comms_headroom_h)
      : Number(p.comms_headroom_h.toFixed(1))
    return `${v > 0 ? '+' : ''}${v} h comms`
  }
  return null
}

function pointTitle(p: SensitivityPoint, limited: boolean, snippet: string | null): string {
  if (p.status === 'fail' && p.failing_constraints.length) {
    return `fails: ${p.failing_constraints.join(', ')}`
  }
  if (p.status === 'pass') {
    const detail = p.closest_label && snippet ? `${p.closest_label}: ${snippet}` : snippet ?? STATUS_LABEL.pass
    return limited ? `${detail} (limited margin)` : detail
  }
  const undecided = p.undecided_constraints?.length ? ` (can't decide: ${p.undecided_constraints.join(', ')})` : ''
  return `${statusLabel(p)}${p.status === 'unknown' ? undecided : ''}`
}

export function SensitivityView({ data }: { data: SensitivityResponse }) {
  const datePts = data.points
    .filter((p) => p.distance_km === 0)
    .sort((a, b) => a.date_offset_hours - b.date_offset_hours)
  const posPts = data.points.filter((p) => p.distance_km > 0)
  const radii = [...new Set(posPts.map((p) => p.distance_km))].sort((a, b) => a - b)
  const c = data.counts

  const limitedOffsets = data.date_limited_offsets_hours ?? []
  const limitedOffsetSet = new Set(limitedOffsets)
  const isLimitedPoint = (p: SensitivityPoint) =>
    p.status === 'pass' &&
    (p.headroom_status === 'limited' ||
      p.headroom_status === 'at_threshold' ||
      (p.distance_km === 0 && limitedOffsetSet.has(p.date_offset_hours)))
  const hasLimited = limitedOffsets.length > 0 || data.points.some(isLimitedPoint)

  const baseHeadroom = resolveHeadroom(data.base)
  const baseElig = verdictOf(data.base)
  const screeningNote = data.screening_note || DEFAULT_SENSITIVITY_SCREENING_NOTE

  return (
    <section aria-label="Sensitivity analysis" className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-100">
          Sensitivity of {data.base.scenario.site.name}:{' '}
          <span className={VERDICT_STYLE[data.verdict]}>
            {data.verdict === 'not_assessed' ? VERDICT_LABEL.not_assessed : data.verdict}
          </span>
        </h3>
        <PassHeadroomBadge headroom={baseHeadroom} eligibility={baseElig} surface="planner" />
      </div>
      <p className="mt-1 text-slate-300">{data.explanation}</p>
      {c && (
        <p className="mt-1 tabular-nums text-slate-400">
          {`${c.requested} points requested: ${c.evaluated} evaluated (${c.passed} pass, ${c.failed} fail, ${c.unknown} unknown), ${c.skipped} not evaluated`}
          {reasonBreakdown(c.by_reason) && (
            <span data-testid="sensitivity-reasons">{`. Without an answer: ${reasonBreakdown(c.by_reason)}.`}</span>
          )}
        </p>
      )}
      {baseElig === 'unknown' && (
        <p className="mt-1 text-[11px] text-slate-400" data-testid="sensitivity-base-unknown">
          The planned date itself is undecided, so there is no robustness verdict. Each slip below is a separate mission
          judged on its own data.
        </p>
      )}
      {data.tightest_passing_headroom && (
        <div
          data-testid="tightest-headroom-banner"
          className={`mt-2 rounded border px-2 py-1 text-[11px] ${
            hasLimited
              ? 'border-amber-800 bg-amber-950/60 text-amber-200'
              : 'border-emerald-800 bg-emerald-950/60 text-emerald-200'
          }`}
        >
          <span className="font-medium">Tightest passing headroom:</span> {data.tightest_passing_headroom}
        </div>
      )}

      <h4 className="mt-2 text-slate-500">If the landing slips</h4>
      <div className="mt-1 flex flex-wrap gap-1">
        {datePts.map((p) => {
          const limited = isLimitedPoint(p)
          const snippet = pointHeadroomSnippet(p)
          const pillStyle = p.status === 'pass' && limited ? LIMITED_PASS_STYLE : STATUS_STYLE[p.status]
          const stateLabel =
            p.status === 'pass'
              ? `${limited ? 'limited' : 'pass'}${snippet ? ` (${snippet})` : ''}`
              : p.reason && p.status !== 'fail'
                ? REASON_SHORT[p.reason]
                : p.status === 'not_evaluated'
                  ? 'n/a'
                  : p.status
          return (
            <span
              key={p.date_offset_hours}
              title={pointTitle(p, limited, snippet)}
              data-limited={limited ? 'true' : undefined}
              data-reason={p.reason ?? undefined}
              className={`rounded px-1.5 py-0.5 tabular-nums ${pillStyle}`}
            >
              {fmtOffset(p.date_offset_hours)} · {stateLabel}
              <span className="sr-only"> {statusLabel(p)}</span>
            </span>
          )
        })}
      </div>
      {limitedOffsets.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-200" data-testid="limited-offsets-note">
          Limited margin at tested slip{limitedOffsets.length > 1 ? 's' : ''}:{' '}
          {limitedOffsets.map((h) => fmtOffset(h)).join(', ')}.
        </p>
      )}

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
              {ring.map((p) => {
                const limited = isLimitedPoint(p)
                const snippet = pointHeadroomSnippet(p)
                const pillStyle = p.status === 'pass' && limited ? LIMITED_PASS_STYLE : STATUS_STYLE[p.status]
                return (
                  <span
                    key={`${r}-${p.bearing_deg}`}
                    title={pointTitle(p, limited, snippet)}
                    data-limited={limited ? 'true' : undefined}
                    className={`rounded px-1.5 py-0.5 tabular-nums ${pillStyle}`}
                  >
                    {p.bearing_deg?.toFixed(0)}°
                    {p.status === 'pass' && snippet ? ` (${limited ? 'limited · ' : ''}${snippet})` : ''}
                    <span className="sr-only"> {statusLabel(p)}</span>
                  </span>
                )
              })}
            </div>
          </div>
        )
      })}

      <p className="mt-2 border-t border-slate-800 pt-1.5 text-[11px] leading-snug text-slate-300" data-testid="sensitivity-screening-note">
        {screeningNote}
      </p>
    </section>
  )
}
