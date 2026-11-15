// Multi-Scenario Comparison dashboard (Member 4). Page layout and data wiring only; each section is
// its own component and all comparison logic lives in analysis.ts.
import { useEffect, useMemo } from 'react'

import { GlassSurface } from '../../ui/GlassSurface'

import { axisOffsets, axisOrigin, fullDomain, type Entry } from './analysis'
import { ConditionsPanel } from './ConditionsPanel'
import { ElevationCharts } from './ElevationCharts'
import { HorizonCompare } from './HorizonCompare'
import { MetricsTable } from './MetricsTable'
import { OverviewCards } from './OverviewCards'
import { AvailabilityCharts, MissionPerformance } from './PerformancePanels'
import { resultKey, selectionKey, validateScenario } from './scenario'
import { ScenarioManager } from './ScenarioManager'
import { SummaryPanel } from './SummaryPanel'
import { SyncTimeline } from './SyncTimeline'
import { TradeoffPanel } from './TradeoffPanel'
import { SelectField } from '../../ui/MdFields'
import './compare.css'
import { Empty, Explain, Icon, Section } from './ui'
import { useCompareStore } from './useCompareStore'
import { useView } from './useTimeAxis'

const NAV = [
  ['cmp-scenarios', 'Scenarios'], ['cmp-overview', 'Overview'], ['cmp-metrics', 'Metrics'], ['cmp-timeline', 'Timeline'],
  ['cmp-charts', 'Elevation'], ['cmp-terrain', 'Terrain'], ['cmp-performance', 'Performance'], ['cmp-tradeoff', 'Trade-off'],
  ['cmp-summary', 'Summary'],
] as const

/** An M3 switch row, the same markup as the planner's layer switches (md-row + md-switch). */
function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} data-tip={hint} data-no-ripple
      onClick={() => onChange(!checked)}
      className="md-row flex h-10 items-center gap-3 rounded-full px-3 text-sm text-ink-2">
      <span className="md-switch" aria-hidden="true">
        <span className="md-switch-handle"><Icon name="check" size={16} /></span>
      </span>
      {label}
    </button>
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

  const rankingSetKey = useCompareStore((s) => s.rankingSetKey)
  const rankingGroups = useCompareStore((s) => s.rankingGroups)
  // A canonical ranking belongs to one selected set; while the set is being re-ranked no rank is shown.
  const rankingCurrent = rankingSetKey === selectionKey(selected.filter((s) => !validateScenario(s).length), allowDemo)

  const entries: Entry[] = useMemo(() => {
    const offsets = axisOffsets(selected, align)
    return selected.map((s) => {
      const state = results[resultKey(s, allowDemo)]
      const result = state?.state === 'done' && state.result.status === 'ok' ? state.result : null
      const ranking = rankingCurrent && result ? result.ranking : null
      return { scenario: s, state, result, offsetHours: offsets[s.id] ?? 0, ranking }
    })
  }, [selected, results, allowDemo, align, rankingCurrent])

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
    <div data-tour="compare-dashboard" className="cmp-page lp-light md-host min-h-full">
      <div className="mx-auto max-w-[1500px] px-6 pb-16 pt-8 lg:px-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <h1 className="text-[28px] font-medium leading-tight text-ink">Scenario comparison</h1>
            <p className="mt-2 text-base text-ink-3">Sunlight, Earth contact and outages for each landing plan, side by side, from the same JPL Horizons and LOLA data</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SelectField label="Align timelines by" value={align} fieldClassName="w-60"
              tip="Line the scenarios up by time since landing, or by calendar date"
              onChange={(e) => setAlign(e.target.value as 'met' | 'utc')}>
              <option value="met">Mission elapsed time</option>
              <option value="utc">Calendar date (UTC)</option>
            </SelectField>
            <Toggle checked={educational} onChange={setEducational} label="Educational mode" hint="Show short explanations of the science behind each panel" />
            <Toggle checked={allowDemo} onChange={setAllowDemo} label="Allow demonstration data"
              hint="Where no real Horizons + LOLA data exists (other dates/sites), show a clearly labelled synthetic illustration instead of nothing" />
          </div>
        </header>

        {/* Section bar: a glass pill, sticky just below the app header. */}
        <nav aria-label="Comparison sections" className="sticky top-2 z-40 mb-6">
          <div>
            <GlassSurface radius="9999px" className="flex items-center gap-1 overflow-x-auto px-4 py-1">
              {NAV.map(([id, label]) => (
                <a key={id} href={`#${id}`} className="cmp-navlink">{label}</a>
              ))}
              <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap pl-4 text-xs" aria-live="polite">
                {loading ? 'Evaluating scenarios…' : backendDown ? <><Icon name="warning" size={14} className="text-red-700" /> Backend unavailable</> : anyData ? 'Data loaded' : ''}
              </span>
            </GlassSurface>
          </div>
        </nav>

        {hasDemo && (
          <div role="alert" className="mb-6 flex gap-3 rounded-xl bg-amber-950 p-4 text-sm text-amber-200">
            <Icon name="warning" className="mt-0.5" /><p><span className="font-medium">Demonstration data in use.</span> Scenarios tagged “Demonstration data” use a synthetic placeholder (approximate Sun/Earth motion, invented terrain). They are ranked separately and must not be used for planning.</p>
          </div>
        )}
        {backendDown && (
          <div role="alert" className="mb-6 rounded-xl bg-red-950 p-4 text-sm text-red-200">
            The backend is not reachable, so no scientific data can be shown. Start it with <code>uvicorn app.main:app --port 8000</code> in <code>backend/</code>. Scenarios are kept for this session.
          </div>
        )}

        <div className="space-y-6">
          <Section id="cmp-scenarios" title="Scenario workspace">
            <ScenarioManager />
            <Explain title="How to compare">
              <p>Tick 2–4 scenarios. Use <b>Duplicate &amp; shift date</b> to see what a launch delay does at the same site, or <b>Same date, 3 sites</b> to compare locations. Set a <b>baseline</b> to see how much every other scenario improves or worsens it.</p>
            </Explain>
          </Section>

          {selected.length === 0 ? (
            <Empty>Select at least two scenarios above to start comparing.</Empty>
          ) : (
            <>
              <Section id="cmp-overview" title={sameSite && differentDates ? 'Landing date comparison' : !differentDates && !sameSite ? 'Landing location comparison' : 'Scenario overview'}>
                <OverviewCards entries={entries} />
              </Section>

              <Section id="cmp-metrics" title="Scientific metrics">
                {anyData ? <MetricsTable entries={entries} /> : <Empty>No scientific data for the selected scenarios yet.</Empty>}
              </Section>

              <Section id="cmp-timeline" title="Solar availability and Earth communication timeline">
                {anyData ? (
                  <>
                    <SyncTimeline {...timelineProps} />
                    <div className="mt-6 border-t border-line pt-6">
                      <h3 className="mb-3 text-sm font-medium text-ink">Conditions at the selected time</h3>
                      <ConditionsPanel entries={entries} align={align} originMs={originMs} onOpen3D={onOpen3D} />
                    </div>
                    <Explain title="Why can Earth disappear below the local horizon?">
                      <p>From the Moon, Earth stays in nearly the same spot in the sky, but near the south pole that spot is only a few degrees above the horizon. Libration makes Earth wobble by several degrees over a month, so at some sites it periodically dips behind nearby terrain, causing a direct-to-Earth blackout that lasts until it rises again.</p>
                    </Explain>
                  </>
                ) : <Empty>Timelines appear once scenarios have data.</Empty>}
              </Section>

              <Section id="cmp-charts" title="Solar and Earth elevation over time">
                {anyData ? <ElevationCharts entries={entries} view={view} align={align} originMs={originMs} /> : <Empty>No data to chart.</Empty>}
              </Section>

              <Section id="cmp-terrain" title="Terrain horizon and Sun/Earth position">
                <HorizonCompare entries={entries} />
              </Section>

              <Section id="cmp-performance" title="Availability, outages and ranking">
                <AvailabilityCharts entries={entries} />
                <div className="mt-6 border-t border-line pt-6">
                  <MissionPerformance entries={entries} groups={rankingCurrent ? rankingGroups : []} ranking={!rankingCurrent && entries.some((e) => e.result) ? 'updating' : 'ready'} />
                </div>
              </Section>

              <Section id="cmp-tradeoff" title="Trade-off analysis">
                <TradeoffPanel entries={entries} />
              </Section>

              <Section id="cmp-summary" title="Comparison summary">
                <SummaryPanel entries={entries} />
              </Section>

              {notes.length > 0 && (
                <footer className="px-1 text-xs leading-relaxed text-ink-4">
                  <h2 className="mb-2 text-sm font-medium text-ink-3">Data sources and assumptions</h2>
                  <ul className="list-disc space-y-1 pl-4">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
                </footer>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
