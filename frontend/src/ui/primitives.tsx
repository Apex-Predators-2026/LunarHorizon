// Shared UI primitives built on the design tokens in src/index.css.
// Presentation only: no data fetching, no scientific logic. See docs/design-system.md.
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { AlertIcon, CheckIcon, CrossIcon, InfoIcon, UnknownIcon } from './icons'

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

// ---------------------------------------------------------------- panels

/** Bordered surface with an optional compact header row. The basic building block of every page. */
export function Panel({ title, meta, actions, children, className, bodyClassName, as: Tag = 'section', id }: {
  title?: ReactNode
  meta?: ReactNode // small secondary text next to the title (source, count, time)
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  as?: 'section' | 'div' | 'aside' | 'article'
  id?: string
}) {
  const headingId = id && title ? `${id}-title` : undefined
  return (
    <Tag id={id} aria-labelledby={headingId} className={cx('rounded-panel border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
          {title && <h2 id={headingId} className="text-title font-semibold text-ink">{title}</h2>}
          {meta && <span className="text-label text-ink-3">{meta}</span>}
          {actions && <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cx('p-3', bodyClassName)}>{children}</div>
    </Tag>
  )
}

/** Small uppercase label used above values and as group headings inside panels. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('text-micro font-semibold uppercase tracking-[0.08em] text-ink-3', className)}>{children}</div>
}

// ---------------------------------------------------------------- values

/** Placeholder for a value that does not exist. Never rendered as 0. */
export const UNAVAILABLE = '—'

/**
 * A measured or derived value with its unit. `value === null` renders as unavailable (an em dash with a
 * tooltip), so missing data is never confused with zero.
 */
export function Value({ value, unit, digits = 1, className, unavailableReason = 'Unavailable' }: {
  value: number | null | undefined
  unit?: string
  digits?: number
  className?: string
  unavailableReason?: string
}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span className={cx('text-ink-4', className)} title={unavailableReason} aria-label={unavailableReason}>{UNAVAILABLE}</span>
  }
  return (
    <span className={cx('nums', className)}>
      {value.toFixed(digits)}
      {unit && <span className="ml-0.5 text-ink-3">{unit}</span>}
    </span>
  )
}

export type Status = 'ok' | 'warn' | 'crit' | 'unknown' | 'info'

const STATUS_STYLE: Record<Status, { text: string; border: string; Icon: typeof CheckIcon }> = {
  ok: { text: 'text-ok', border: 'border-ok/40', Icon: CheckIcon },
  warn: { text: 'text-warn', border: 'border-warn/40', Icon: AlertIcon },
  crit: { text: 'text-crit', border: 'border-crit/40', Icon: CrossIcon },
  unknown: { text: 'text-unknown', border: 'border-line-strong', Icon: UnknownIcon },
  info: { text: 'text-accent', border: 'border-accent/40', Icon: InfoIcon },
}

/** Labelled metric: small label on top, value below, optional status and note. */
export function Stat({ label, children, status, note, className }: {
  label: ReactNode
  children: ReactNode
  status?: Status
  note?: ReactNode
  className?: string
}) {
  const s = status ? STATUS_STYLE[status] : null
  return (
    <div className={cx('min-w-0', className)}>
      <Label>{label}</Label>
      <div className={cx('mt-0.5 flex items-center gap-1.5 text-figure font-semibold nums', s ? s.text : 'text-ink')}>
        {s && <s.Icon size={14} />}
        <span className="truncate">{children}</span>
      </div>
      {note && <div className="mt-0.5 text-label text-ink-3">{note}</div>}
    </div>
  )
}

/** Status shown as icon + word (never colour alone). */
export function StatusBadge({ status, children, className }: { status: Status; children: ReactNode; className?: string }) {
  const s = STATUS_STYLE[status]
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-control border bg-inset px-1.5 py-px text-label font-medium', s.text, s.border, className)}>
      <s.Icon size={12} />
      {children}
    </span>
  )
}

export type DataSource = 'real' | 'demonstration' | 'unavailable'

const SOURCE: Record<DataSource, { label: string; status: Status; title: string }> = {
  real: { label: 'Horizons + LOLA', status: 'info',
    title: 'Sun/Earth positions from JPL Horizons; terrain horizon from Moon Trek LOLA elevation models (precomputed by the data engine).' },
  demonstration: { label: 'Demonstration data', status: 'warn',
    title: 'Synthetic placeholder. Illustrates the tool only; not real lunar conditions.' },
  unavailable: { label: 'No data', status: 'unknown', title: 'No scientific data exists for this site and time range.' },
}

/** Where a number came from. Every result that shows science data carries one. */
export function DataSourceBadge({ source, className }: { source: DataSource; className?: string }) {
  const s = SOURCE[source]
  return (
    <span title={s.title} className={className}>
      <StatusBadge status={s.status}>{s.label}</StatusBadge>
    </span>
  )
}

/** Inline message row for warnings, errors and notes. */
export function Callout({ status = 'info', title, children, className }: {
  status?: Status
  title?: ReactNode
  children: ReactNode
  className?: string
}) {
  const s = STATUS_STYLE[status]
  return (
    <div role={status === 'crit' || status === 'warn' ? 'alert' : undefined}
      className={cx('flex gap-2 rounded-panel border border-l-2 bg-inset px-3 py-2 text-body text-ink-2', s.border, className)}
      style={{ borderLeftColor: 'currentColor' }}>
      <s.Icon size={14} className={cx('mt-0.5 shrink-0', s.text)} />
      <div className="min-w-0">
        {title && <div className={cx('font-medium', s.text)}>{title}</div>}
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- controls

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON: Record<ButtonVariant, string> = {
  primary: 'border-accent bg-accent text-canvas hover:bg-accent-strong hover:border-accent-strong',
  secondary: 'border-line-strong bg-raised text-ink-2 hover:border-ink-4 hover:text-ink',
  ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-raised hover:text-ink',
  danger: 'border-line-strong bg-raised text-ink-2 hover:border-crit hover:text-crit',
}

/** Class string for button-like elements (links, labels) that cannot use <Button>. */
export const buttonClass = (variant: ButtonVariant = 'secondary', size: 'sm' | 'md' = 'sm') =>
  cx(
    'inline-flex items-center justify-center gap-1.5 rounded-control border font-medium transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-40',
    size === 'sm' ? 'h-7 px-2.5 text-label' : 'h-8 px-3 text-body',
    BUTTON[variant],
  )

export function Button({ variant = 'secondary', size = 'sm', className, type = 'button', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  return <button type={type} className={cx(buttonClass(variant, size), className)} {...rest} />
}

/** Shared class for text inputs, number inputs, date inputs and selects. */
export const inputClass =
  'h-8 w-full rounded-control border border-line-strong bg-inset px-2 text-body text-ink nums ' +
  'placeholder:text-ink-4 hover:border-ink-4 focus:border-accent focus:outline-none disabled:opacity-50'

/** Label + control + optional hint, stacked. */
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-label text-ink-3">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-micro text-ink-3">{hint}</span>}
    </label>
  )
}

/** Mutually exclusive options shown as a joined button row (view modes, units, alignment). */
export function Segmented<T extends string>({ options, value, onChange, label, className }: {
  options: { value: T; label: ReactNode }[]
  value: T
  onChange: (v: T) => void
  label: string
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex rounded-control border border-line-strong bg-inset p-px', className)}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={cx('h-6 rounded-[2px] px-2.5 text-label font-medium transition-colors',
              on ? 'bg-raised text-ink shadow-[inset_0_-2px_0_var(--color-accent)]' : 'text-ink-3 hover:text-ink')}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Small on/off switch with a visible text label. */
export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-label text-ink-2" title={hint}>
      <span className="relative inline-flex">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-3.5 w-6 rounded-full border border-line-strong bg-inset transition-colors peer-checked:border-accent peer-checked:bg-accent/30 peer-focus-visible:outline-2 peer-focus-visible:outline-accent" />
        <span className="absolute left-[3px] top-[3px] h-2 w-2 rounded-full bg-ink-3 transition-transform peer-checked:translate-x-2.5 peer-checked:bg-accent" />
      </span>
      {label}
    </label>
  )
}
