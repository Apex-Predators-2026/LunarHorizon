import type { CanonicalMarginItem, Eligibility, OperationalHeadroom } from '../types'
import { formatMarginMetric, headroomTone, passBadgeText } from '../lib/headroom'
import { cx } from './classes'
import { AlertIcon, CheckIcon, CrossIcon, UnknownIcon } from './icons'

export type HeadroomSurface = 'compare' | 'planner'

const COMPARE_TONE = {
  ok: {
    box: 'border-ok/35 bg-inset',
    badge: 'border-ok/40 bg-inset text-ok',
    title: 'text-ok',
    pill: 'border-ok/30 bg-surface text-ok',
    Icon: CheckIcon,
  },
  warn: {
    box: 'border-warn/45 bg-inset',
    badge: 'border-warn/45 bg-inset text-warn',
    title: 'text-warn',
    pill: 'border-warn/40 bg-surface text-warn',
    Icon: AlertIcon,
  },
  crit: {
    box: 'border-crit/40 bg-inset',
    badge: 'border-crit/40 bg-inset text-crit',
    title: 'text-crit',
    pill: 'border-crit/35 bg-surface text-crit',
    Icon: CrossIcon,
  },
  unknown: {
    box: 'border-line-strong bg-inset',
    badge: 'border-line-strong bg-inset text-unknown',
    title: 'text-ink-2',
    pill: 'border-line-strong bg-surface text-ink-3',
    Icon: UnknownIcon,
  },
  info: {
    box: 'border-accent/35 bg-inset',
    badge: 'border-accent/40 bg-inset text-accent',
    title: 'text-accent',
    pill: 'border-accent/30 bg-surface text-accent',
    Icon: CheckIcon,
  },
} as const

const PLANNER_TONE = {
  ok: {
    box: 'border-emerald-800/70 bg-emerald-950/60',
    badge: 'border-emerald-800 bg-emerald-950 text-emerald-200',
    title: 'text-emerald-200',
    pill: 'border-emerald-800/70 bg-slate-900/70 text-emerald-200',
    Icon: CheckIcon,
  },
  warn: {
    box: 'border-amber-800/80 bg-amber-950/70',
    badge: 'border-amber-800 bg-amber-950 text-amber-200',
    title: 'text-amber-200',
    pill: 'border-amber-800/70 bg-slate-900/70 text-amber-200',
    Icon: AlertIcon,
  },
  crit: {
    box: 'border-red-800/70 bg-red-950/60',
    badge: 'border-red-800 bg-red-950 text-red-200',
    title: 'text-red-200',
    pill: 'border-red-800/70 bg-slate-900/70 text-red-200',
    Icon: CrossIcon,
  },
  unknown: {
    box: 'border-slate-700 bg-slate-900/80',
    badge: 'border-slate-600 bg-slate-800 text-slate-200',
    title: 'text-slate-200',
    pill: 'border-slate-700 bg-slate-900 text-slate-300',
    Icon: UnknownIcon,
  },
  info: {
    box: 'border-sky-800/70 bg-sky-950/60',
    badge: 'border-sky-800 bg-sky-950 text-sky-200',
    title: 'text-sky-200',
    pill: 'border-sky-800/70 bg-slate-900/70 text-sky-200',
    Icon: CheckIcon,
  },
} as const

function fmtItemLine(item: CanonicalMarginItem | null | undefined): string {
  if (!item || item.margin_class === 'not_applicable') return 'Not configured'
  const marginText = formatMarginMetric(item.margin, true)
  const measuredText = formatMarginMetric(item.measured, false)
  if (item.threshold !== null && item.threshold !== undefined) {
    const unit = item.unit === 'fraction' ? '%' : ` ${item.unit}`
    const thrDisplay = item.unit === 'fraction' ? `${(item.threshold * 100).toFixed(0)}%` : `${item.threshold}${unit}`
    return `${marginText} (${measuredText} vs ${thrDisplay})`
  }
  return `${marginText} (measured ${measuredText})`
}

export function PassHeadroomBadge({
  headroom,
  eligibility = 'pass',
  surface = 'compare',
  className,
}: {
  headroom: OperationalHeadroom | null | undefined
  eligibility?: Eligibility
  surface?: HeadroomSurface
  className?: string
}) {
  const tone = headroomTone(headroom, eligibility)
  const palette = (surface === 'planner' ? PLANNER_TONE : COMPARE_TONE)[tone]
  const Icon = palette.Icon
  return (
    <span
      title={headroom?.qualified_verdict}
      className={cx(
        'inline-flex items-center gap-1 rounded-control border px-1.5 py-px text-label font-medium',
        palette.badge,
        className,
      )}
    >
      <Icon size={12} />
      <span>{passBadgeText(headroom, eligibility)}</span>
    </span>
  )
}

export function PassHeadroom({
  headroom,
  surface = 'compare',
  compact = false,
  showScreeningNote = true,
  className,
}: {
  headroom: OperationalHeadroom
  surface?: HeadroomSurface
  compact?: boolean
  showScreeningNote?: boolean
  className?: string
}) {
  const tone = headroomTone(headroom)
  const palette = (surface === 'planner' ? PLANNER_TONE : COMPARE_TONE)[tone]
  const Icon = palette.Icon
  const muted = surface === 'planner' ? 'text-slate-400' : 'text-ink-3'
  const primary = surface === 'planner' ? 'text-slate-100' : 'text-ink'
  const secondary = surface === 'planner' ? 'text-slate-300' : 'text-ink-2'
  const rowBorder = surface === 'planner' ? 'border-slate-700/70' : 'border-line'

  return (
    <div
      data-testid="pass-headroom"
      data-headroom-status={headroom.status}
      className={cx(
        'rounded-panel border px-2.5 py-2 text-label',
        palette.box,
        className,
      )}
    >
      <div className="flex items-start gap-1.5">
        <Icon size={14} className={cx('mt-0.5 shrink-0', palette.title)} />
        <div className={cx('min-w-0 font-medium leading-snug', palette.title)}>
          {headroom.qualified_verdict}
        </div>
      </div>

      <dl
        className={cx(
          'mt-2 grid gap-x-3 gap-y-1.5 border-t pt-1.5',
          rowBorder,
          compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2',
        )}
      >
        <div className="min-w-0">
          <dt className={cx('text-micro uppercase tracking-wider', muted)}>Darkness headroom</dt>
          <dd className={cx('nums font-medium leading-snug', primary)}>
            {fmtItemLine(headroom.darkness)}
          </dd>
        </div>

        <div className="min-w-0">
          <dt className={cx('text-micro uppercase tracking-wider', muted)}>Comms-blackout headroom</dt>
          <dd className={cx('nums font-medium leading-snug', primary)}>
            {fmtItemLine(headroom.communication_blackout)}
          </dd>
        </div>

        <div className="min-w-0">
          <dt className={cx('text-micro uppercase tracking-wider', muted)}>Initial illumination</dt>
          <dd className={cx('nums leading-snug', secondary)}>
            {headroom.initial_sunlight.summary_text}
          </dd>
        </div>

        <div className="min-w-0">
          <dt className={cx('text-micro uppercase tracking-wider', muted)}>Initial Earth contact</dt>
          <dd className={cx('nums leading-snug', secondary)}>
            {headroom.initial_earth.summary_text}
          </dd>
        </div>

        {headroom.closest_constraint && (
          <div className={cx('min-w-0', !compact && 'sm:col-span-2')}>
            <dt className={cx('text-micro uppercase tracking-wider', muted)}>Closest requirement to limit</dt>
            <dd className={cx('nums font-medium leading-snug', palette.title)}>
              {headroom.closest_constraint.summary_text}
            </dd>
          </div>
        )}
      </dl>

      {showScreeningNote && (
        <p className={cx('mt-1.5 border-t pt-1 text-micro leading-snug', rowBorder, muted)}>
          {headroom.screening_note}
        </p>
      )}
    </div>
  )
}
