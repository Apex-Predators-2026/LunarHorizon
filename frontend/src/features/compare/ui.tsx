// Small presentational pieces shared by the comparison panels. Styling follows the Mission Planner's
// conventions (Opaline surfaces, charcoal ink, one coral accent, M3 shapes); see compare.css.
import { Component, type ReactNode } from 'react'

import type { Provenance } from './analysis'
import { seriesColor, seriesDash } from './palette'
import type { ComparisonScenario, DataKind } from './types'
import type { Eligibility } from '../../types'
import { useCompareStore } from './useCompareStore'

// One line-icon set, one size and stroke, in the colour of the surrounding text.
const ICON_PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  warning: 'M12 4l9 16H3L12 4zM12 10v4.5M12 17.5v.5',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 7.5v.5',
  unknown: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.6 9.4a2.5 2.5 0 114.3 1.7c-.9.8-1.9 1.3-1.9 2.6M12 17v.5',
} as const
export type IconName = keyof typeof ICON_PATHS

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`inline-block shrink-0 ${className}`}>
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

export function Section({ id, title, actions, children, className = '' }: {
  id?: string
  title: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className={`cmp-section scroll-mt-16 ${className}`}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id={id ? `${id}-h` : undefined} className="text-lg font-medium text-ink">{title}</h2>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <PanelBoundary name={title}>{children}</PanelBoundary>
    </section>
  )
}

/** Line swatch in the scenario's colour and dash, plus its letter: identity never relies on colour alone. */
export function ScenarioChip({ s, size = 'md' }: { s: Pick<ComparisonScenario, 'label' | 'colorSlot'>; size?: 'sm' | 'md' }) {
  const c = seriesColor(s.colorSlot)
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" aria-label={`Scenario ${s.label}`}>
      <svg width={size === 'sm' ? 14 : 18} height="8" aria-hidden="true">
        <line x1="1" y1="4" x2={size === 'sm' ? 13 : 17} y2="4" stroke={c} strokeWidth="2.5" strokeDasharray={seriesDash(s.colorSlot)} strokeLinecap="round" />
      </svg>
      <span className={`grid place-items-center rounded font-medium text-[#1f2326] ${size === 'sm' ? 'h-4 min-w-4 px-0.5 text-[11px]' : 'h-5 min-w-5 px-1 text-xs'}`}
        style={{ background: c }}>
        {s.label}
      </span>
    </span>
  )
}

const KIND_STYLE: Record<DataKind, { text: string; dot: string; title: string }> = {
  real: { text: 'JPL Horizons + LOLA', dot: '#3c4044',
    title: 'Sun/Earth positions from JPL Horizons, terrain horizon from Moon Trek LOLA DEMs (precomputed by the data engine).' },
  demonstration: { text: 'Demonstration data', dot: '#c98500',
    title: 'Synthetic placeholder timeline. Illustrates the tool only; not real lunar conditions.' },
  unavailable: { text: 'No data', dot: '#b9babd',
    title: 'No scientific data exists for this site and date range.' },
}

/** Where a scenario's numbers come from: quiet text with a status dot. */
export function DataKindBadge({ kind }: { kind: DataKind }) {
  const k = KIND_STYLE[kind]
  return (
    <span title={k.title} className={`inline-flex items-center gap-1.5 text-xs ${kind === 'demonstration' ? 'text-amber-300' : 'text-ink-3'}`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: k.dot }} aria-hidden="true" />
      {k.text}
    </span>
  )
}

const PROV: Record<Provenance, { text: string; title: string }> = {
  measured: { text: 'ephemeris', title: 'Directly from the JPL Horizons Sun/Earth positions' },
  derived: { text: 'derived', title: 'Calculated from the Horizons + LOLA timeline (hourly samples)' },
  idealized: { text: 'idealised', title: 'Idealised direct-beam geometry, not electrical output' },
  viability: { text: 'viability', title: 'From the team viability evaluator' },
  config: { text: 'config', title: 'From the spacecraft configuration you entered' },
}

export function ProvenanceTag({ p }: { p: Provenance }) {
  return (
    <span title={PROV[p].title} className="text-[11px] text-ink-4">
      {PROV[p].text}
    </span>
  )
}

const ELIGIBILITY_STYLE: Record<Eligibility, { icon: IconName; text: string; cls: string; title: string }> = {
  pass: { icon: 'check', text: 'Passes', cls: 'bg-emerald-950 text-emerald-300',
    title: 'Every applicable mission requirement is proven satisfied (canonical viability engine).' },
  fail: { icon: 'close', text: 'Fails', cls: 'bg-red-950 text-red-300',
    title: 'At least one mission requirement is proven violated. Never ranked as a recommendation.' },
  unknown: { icon: 'unknown', text: 'Cannot be decided', cls: 'bg-slate-800 text-slate-200 ring-1 ring-slate-500',
    title: 'UNKNOWN: the data cannot decide at least one requirement. Not a failure; never ranked or scored.' },
}

/** PASS / FAIL / UNKNOWN with icon and words. UNKNOWN is a neutral, separate state, never shown as a failure. */
export function EligibilityBadge({ eligibility }: { eligibility: Eligibility }) {
  const s = ELIGIBILITY_STYLE[eligibility]
  return (
    <span title={s.title} className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      <Icon name={s.icon} size={14} /> {s.text}
    </span>
  )
}

const REQ_ICON: Record<'pass' | 'fail' | 'unknown' | 'not_applicable', { icon: IconName; cls: string; text: string }> = {
  pass: { icon: 'check', cls: 'text-emerald-300', text: 'requirement met' },
  fail: { icon: 'close', cls: 'text-red-300', text: 'requirement failed' },
  unknown: { icon: 'unknown', cls: 'text-slate-300', text: 'cannot be decided (missing data)' },
  not_applicable: { icon: 'info', cls: 'text-slate-500', text: 'not applicable' },
}

/** One requirement verdict as an icon with screen-reader text (the visible label sits next to it). */
export function ReqIcon({ status }: { status: keyof typeof REQ_ICON }) {
  const s = REQ_ICON[status]
  return (
    <span className={`inline-flex shrink-0 ${s.cls}`} title={s.text}>
      <Icon name={s.icon} size={14} />
      <span className="sr-only">{s.text}</span>
    </span>
  )
}

/** Canonical rank badge, scoped to its comparable group. Only rendered for ranked (PASS) scenarios. */
export function RankBadge({ text }: { text: string }) {
  return (
    <span title="Canonical rank from the viability engine, among comparable passing scenarios"
      className="inline-flex items-center rounded-md bg-sky-950 px-2 py-0.5 text-xs font-medium tabular-nums text-sky-200 ring-1 ring-sky-800">
      {text.startsWith('#') ? `Rank ${text}` : text}
    </span>
  )
}

/** Educational explanation, only rendered when educational mode is on. */
export function Explain({ title, children }: { title: string; children: ReactNode }) {
  const on = useCompareStore((s) => s.educational)
  if (!on) return null
  return (
    <details className="mt-4 rounded-xl bg-inset px-4 py-3 text-sm text-ink-2 open:pb-4">
      <summary className="flex cursor-pointer select-none items-center gap-2 font-medium text-ink">
        <Icon name="info" className="text-ink-3" /> {title}
      </summary>
      <div className="mt-2 space-y-2 leading-relaxed">{children}</div>
    </details>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line-strong p-6 text-center text-sm text-ink-3">{children}</p>
}

export const btn = 'cmp-btn'
export const btnPrimary = 'cmp-btn-primary'
export const btnText = 'cmp-btn-text'
export const btnQuiet = 'cmp-btn-quiet'
export const input = 'cmp-input'

/** Tooltip box used by every chart. */
export function TooltipBox({ title, rows }: { title: string; rows: { s: ComparisonScenario; text: string }[] }) {
  return (
    <div className="cmp-tip">
      <div className="mb-1 font-medium text-ink">{title}</div>
      {rows.map(({ s, text }) => (
        <div key={s.id} className="flex items-center gap-2 py-0.5 text-ink-2">
          <ScenarioChip s={s} size="sm" />
          <span className="tabular-nums">{text}</span>
        </div>
      ))}
    </div>
  )
}

/** Keeps one failing panel (e.g. unexpected data) from unmounting the whole application. */
export class PanelBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <p role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-red-950 p-4 text-sm text-red-300">
          <Icon name="warning" /> The {this.props.name} panel could not be drawn ({this.state.error.message}). Other panels are unaffected.
          <button type="button" className={btnText} onClick={() => this.setState({ error: null })}>Retry</button>
        </p>
      )
    }
    return this.props.children
  }
}
