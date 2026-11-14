// Multi-Scenario Comparison dashboard (Member 4). Page layout and data wiring only; each section is
// its own component and all comparison logic lives in analysis.ts.
import { useEffect, useMemo } from 'react'

import { axisOffsets, axisOrigin, fullDomain, type Entry } from './analysis'
import { ConditionsPanel } from './ConditionsPanel'
import { ElevationCharts } from './ElevationCharts'
import { HorizonCompare } from './HorizonCompare'
import { MetricsTable } from './MetricsTable'
import { OverviewCards } from './OverviewCards'
import { AvailabilityCharts, MissionPerformance } from './PerformancePanels'
import { resultKey } from './scenario'
import { ScenarioManager } from './ScenarioManager'
import { SummaryPanel } from './SummaryPanel'
import { SyncTimeline } from './SyncTimeline'
import { TradeoffPanel } from './TradeoffPanel'
import { Empty, Explain, Section } from './ui'
import { useCompareStore } from './useCompareStore'
import { useView } from './useTimeAxis'

const NAV = [
  ['cmp-scenarios', 'Scenarios'], ['cmp-overview', 'Overview'], ['cmp-metrics', 'Metrics'], ['cmp-timeline', 'Timeline'],
  ['cmp-charts', 'Elevation'], ['cmp-terrain', 'Terrain'], ['cmp-performance', 'Performance'], ['cmp-tradeoff', 'Trade-off'],
  ['cmp-summary', 'Summary'],
] as const

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300" title={hint}>
      <span className="relative inline-flex">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-4 w-7 rounded-full bg-slate-700 transition peer-checked:bg-cyan-600 peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-400" />
        <span className="absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition peer-checked:translate-x-3" />
      </span>
      {label}
    </label>
  )
}

/** `onOpen3D` switches the app to the 3D view; the selected site/time are already in the shared app store. */
export function ComparisonDashboard({ onOpen3D }: { onOpen3D?: () => void } = {}) {
  const scenarios = useCompareStore((s) => s.scenarios)
  const selectedIds = useCompareStore((s) => s.selectedIds)
  const results = useCompareStore((s) => s.results)
  const allowDemo = useCompareStore((s) => s.allowDemo)
  const align = useCompareStore((s) => s.align)
  const educational = useCompareStore((s) => s.educational)
  const notes = useCompareStore((s) => s.notes)
  const sitesStatus = useCompareStore((s) => s.sitesStatus)
  const { setAllowDemo, setEducational, setAlign, loadSites, refresh } = useCompareStore.getState()

  useEffect(() => {
    if (sitesStatus === 'idle') loadSites()
  }, [sitesStatus, loadSites])

  const selected = useMemo(
    () => selectedIds.map((id) => scenarios.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s),
    [scenarios, selectedIds],
  )
  const keys = selected.map((s) => resultKey(s, allowDemo)).join('|')
  useEffect(() => {
    refresh()
  }, [keys, refresh])

  const entries: Entry[] = useMemo(() => {
    const offsets = axisOffsets(selected, align)
    return selected.map((s) => {
      const state = results[resultKey(s, allowDemo)]
      const result = state?.state === 'done' && state.result.status === 'ok' ? state.result : null
      return { scenario: s, state, result, offsetHours: offsets[s.id] ?? 0 }
    })
  }, [selected, results, allowDemo, align])

  const full = useMemo(() => fullDomain(entries), [entries])
  const view = useView(full)
  const originMs = useMemo(() => axisOrigin(selected), [selected])
  const anyData = entries.some((e) => e.result)
  const hasDemo = entries.some((e) => e.result?.data_kind === 'demonstration')
  const loading = entries.some((e) => e.state?.state === 'loading')
  const backendDown = entries.some((e) => e.state?.state === 'error' && /Backend unavailable/.test(e.state.message))
  const sameSite = selected.length > 1 && new Set(selected.map((s) => s.site.id)).size === 1
  const differentDates = new Set(selected.map((s) => s.landing_utc)).size > 1

  const timelineProps = { entries, full, view, align, originMs }

  return (
    <div className="min-h-full bg-[radial-gradient(ellipse_at_top,_#0f2147_0%,_#070d1c_55%,_#050912_100%)] text-slate-200">
      <div className="mx-auto max-w-[1500px] px-4 pb-16 pt-6 sm:px-6">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-cyan-400">Lunar south pole · mission planning</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">Mission Scenario Comparison</h1>
            <p className="text-sm text-slate-400">Evaluate landing locations, schedules, and mission conditions side by side.</p>
          </div>
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-[#1c2a48] bg-[#0b1426]/80 px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              Align timelines by
              <select value={align} onChange={(e) => setAlign(e.target.value as 'met' | 'utc')}
                className="rounded border border-[#25365a] bg-[#081124] px-1.5 py-0.5 text-xs text-slate-100">
                <option value="met">Mission elapsed time</option>
                <option value="utc">Calendar date (UTC)</option>
              </select>
            </label>
            <Toggle checked={educational} onChange={setEducational} label="Educational mode" hint="Show short explanations of the science behind each panel" />
            <Toggle checked={allowDemo} onChange={setAllowDemo} label="Allow demonstration data"
              hint="Where no real Horizons + LOLA data exists (other dates/sites), show a clearly labelled synthetic illustration instead of nothing" />
          </div>
        </header>

        <nav aria-label="Comparison sections" className="sticky top-0 z-20 -mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-[#1c2a48] bg-[#070d1c]/90 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
          {NAV.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="whitespace-nowrap rounded px-2 py-1 text-xs text-slate-400 hover:bg-[#13233f] hover:text-cyan-200">{label}</a>
          ))}
          <span className="ml-auto whitespace-nowrap py-1 text-[11px] text-slate-500" aria-live="polite">
            {loading ? 'Evaluating scenarios…' : backendDown ? '⚠ Backend unavailable' : anyData ? 'Data loaded' : ''}
          </span>
        </nav>

        {hasDemo && (
          <div role="alert" className="mb-4 rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-xs text-amber-100">
            ⚠ <b>Demonstration data in use.</b> Scenarios tagged “Demonstration data” use a synthetic placeholder (approximate Sun/Earth motion, invented terrain). They are ranked separately and must not be used for planning.
          </div>
        )}
        {backendDown && (
          <div role="alert" className="mb-4 rounded-lg border border-red-800 bg-red-950/40 p-3 text-xs text-red-100">
            The backend is not reachable, so no scientific data can be shown. Start it with <code>uvicorn app.main:app --port 8000</code> in <code>backend/</code>. Scenarios are kept for this session.
          </div>
        )}

        <div className="space-y-4">
          <Section id="cmp-scenarios" kicker="1 · Scenarios" title="Scenario workspace">
            <ScenarioManager />
            <Explain title="How to compare">
              <p>Tick 2–4 scenarios. Use <b>Duplicate &amp; shift date</b> to see what a launch delay does at the same site, or <b>Same date, 3 sites</b> to compare locations. Set a <b>baseline</b> to see how much every other scenario improves or worsens it.</p>
            </Explain>
          </Section>

          {selected.length === 0 ? (
            <Empty>Select at least two scenarios above to start comparing.</Empty>
          ) : (
            <>
              <Section id="cmp-overview" kicker="2 · Overview" title={sameSite && differentDates ? 'Landing date comparison' : !differentDates && !sameSite ? 'Landing location comparison' : 'Scenario overview'}>
                <OverviewCards entries={entries} />
              </Section>

              <Section id="cmp-metrics" kicker="3 · Side by side" title="Scientific metrics">
                {anyData ? <MetricsTable entries={entries} /> : <Empty>No scientific data for the selected scenarios yet.</Empty>}
              </Section>

              <Section id="cmp-timeline" kicker="4 · 5 · Synchronized" title="Solar availability and Earth communication timeline">
                {anyData ? (
                  <>
                    <SyncTimeline {...timelineProps} />
                    <div className="mt-4 border-t border-[#1c2a48] pt-3">
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-cyan-300/90">Conditions at the selected time</h3>
                      <ConditionsPanel entries={entries} align={align} originMs={originMs} onOpen3D={onOpen3D} />
                    </div>
                    <Explain title="Why can Earth disappear below the local horizon?">
                      <p>From the Moon, Earth stays in nearly the same spot in the sky, but near the south pole that spot is only a few degrees above the horizon. Libration makes Earth wobble by several degrees over a month, so at some sites it periodically dips behind nearby terrain, causing a direct-to-Earth blackout that lasts until it rises again.</p>
                    </Explain>
                  </>
                ) : <Empty>Timelines appear once scenarios have data.</Empty>}
              </Section>

              <Section id="cmp-charts" kicker="6 · Geometry" title="Solar and Earth elevation over time">
                {anyData ? <ElevationCharts entries={entries} view={view} align={align} originMs={originMs} /> : <Empty>No data to chart.</Empty>}
              </Section>

              <Section id="cmp-terrain" kicker="Location comparison" title="Terrain horizon and Sun/Earth position">
                <HorizonCompare entries={entries} />
              </Section>

              <Section id="cmp-performance" kicker="Mission performance" title="Availability, outages and ranking">
                <AvailabilityCharts entries={entries} />
                <div className="mt-5 border-t border-[#1c2a48] pt-4">
                  <MissionPerformance entries={entries} />
                </div>
              </Section>

              <Section id="cmp-tradeoff" kicker="7 · Science vs engineering" title="Trade-off analysis">
                <TradeoffPanel entries={entries} />
              </Section>

              <Section id="cmp-summary" kicker="8 · Explanation" title="Comparison summary">
                <SummaryPanel entries={entries} />
              </Section>

              {notes.length > 0 && (
                <footer className="rounded-lg border border-[#1c2a48] p-3 text-[11px] leading-relaxed text-slate-500">
                  <div className="mb-1 font-semibold uppercase tracking-wider text-slate-400">Data sources and assumptions</div>
                  <ul className="space-y-0.5">{notes.map((n) => <li key={n}>• {n}</li>)}</ul>
                </footer>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
