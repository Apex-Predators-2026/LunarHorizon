// Small presentational pieces shared by the comparison panels.
import { Component, type ReactNode } from 'react'

import type { Provenance } from './analysis'
import { seriesColor, seriesDash } from './palette'
import type { ComparisonScenario, DataKind } from './types'
import { useCompareStore } from './useCompareStore'

export function Section({ id, title, kicker, actions, children, className = '' }: {
  id?: string
  title: string
  kicker?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined}
      className={`rounded-xl border border-[#1c2a48] bg-[#0b1426]/80 p-4 shadow-[0_0_0_1px_rgba(56,189,248,0.03)] sm:p-5 ${className}`}>
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          {kicker && <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-400/80">{kicker}</div>}
          <h2 id={id ? `${id}-h` : undefined} className="text-base font-semibold text-slate-100">{title}</h2>
        </div>
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
      <span className={`grid place-items-center rounded font-bold text-[#06101f] ${size === 'sm' ? 'h-4 min-w-4 px-0.5 text-[10px]' : 'h-5 min-w-5 px-1 text-xs'}`}
        style={{ background: c }}>
        {s.label}
      </span>
    </span>
  )
}

const KIND_STYLE: Record<DataKind, { text: string; cls: string; title: string }> = {
  real: { text: 'JPL Horizons + LOLA', cls: 'text-sky-300 ring-sky-700/70 bg-sky-950/40',
    title: 'Sun/Earth positions from JPL Horizons, terrain horizon from Moon Trek LOLA DEMs (precomputed by the data engine).' },
  demonstration: { text: 'Demonstration data', cls: 'text-amber-300 ring-amber-700/70 bg-amber-950/40',
    title: 'Synthetic placeholder timeline. Illustrates the tool only; not real lunar conditions.' },
  unavailable: { text: 'No data', cls: 'text-slate-400 ring-slate-700 bg-slate-900/60',
    title: 'No scientific data exists for this site and date range.' },
}

export function DataKindBadge({ kind }: { kind: DataKind }) {
  const k = KIND_STYLE[kind]
  return (
    <span title={k.title} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${k.cls}`}>
      {kind === 'demonstration' ? '⚠' : kind === 'real' ? '◉' : '○'} {k.text}
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
    <span title={PROV[p].title} className="rounded bg-slate-800/70 px-1 text-[9px] uppercase tracking-wide text-slate-400">
      {PROV[p].text}
    </span>
  )
}

export function PassBadge({ passes }: { passes: boolean }) {
  return passes ? (
    <span className="inline-flex items-center gap-1 rounded bg-emerald-950/60 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-800">
      ✓ Passes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded bg-red-950/60 px-1.5 py-0.5 text-[11px] font-medium text-red-300 ring-1 ring-red-800">
      ✕ Fails
    </span>
  )
}

/** Educational explanation, only rendered when educational mode is on. */
export function Explain({ title, children }: { title: string; children: ReactNode }) {
  const on = useCompareStore((s) => s.educational)
  if (!on) return null
  return (
    <details className="mt-3 rounded-lg border border-cyan-900/60 bg-cyan-950/20 px-3 py-2 text-xs text-slate-300 open:pb-3">
      <summary className="cursor-pointer select-none font-medium text-cyan-300">ⓘ {title}</summary>
      <div className="mt-2 space-y-1.5 leading-relaxed">{children}</div>
    </details>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-slate-700/80 p-4 text-center text-sm text-slate-400">{children}</p>
}

export const btn = 'rounded-md border border-[#25365a] bg-[#0f1b33] px-2.5 py-1 text-xs text-slate-200 transition hover:border-cyan-700 hover:bg-[#13233f] disabled:cursor-not-allowed disabled:opacity-40'
export const btnPrimary = 'rounded-md bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-[#03101e] transition hover:bg-cyan-500 disabled:opacity-40'
export const input = 'w-full rounded-md border border-[#25365a] bg-[#081124] px-2 py-1 text-sm text-slate-100 outline-none focus:border-cyan-600 focus:ring-1 focus:ring-cyan-700'

/** Tooltip box used by every chart. */
export function TooltipBox({ title, rows }: { title: string; rows: { s: ComparisonScenario; text: string }[] }) {
  return (
    <div className="rounded-md border border-[#2a3c63] bg-[#08111f]/95 px-2.5 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-slate-300">{title}</div>
      {rows.map(({ s, text }) => (
        <div key={s.id} className="flex items-center gap-2 py-0.5 text-slate-200">
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
        <p role="alert" className="rounded-lg border border-red-900 bg-red-950/30 p-3 text-xs text-red-200">
          The {this.props.name} panel could not be drawn ({this.state.error.message}). Other panels are unaffected.
          <button type="button" className="ml-2 text-cyan-300 underline" onClick={() => this.setState({ error: null })}>Retry</button>
        </p>
      )
    }
    return this.props.children
  }
}
