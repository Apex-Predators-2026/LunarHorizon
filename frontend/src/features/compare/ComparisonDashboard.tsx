// Multi-Scenario Comparison dashboard (Member 4). Page layout and data wiring only; each section is
// its own component and all comparison logic lives in analysis.ts.
import { useEffect, useMemo, useRef } from 'react'

import { routeHash } from '../../appRoute'

import { GlassSurface } from '../../ui/GlassSurface'

import { axisOffsets, axisOrigin, fullDomain, type Entry } from './analysis'
import { AtAGlance } from './AtAGlance'
import { ConditionsPanel } from './ConditionsPanel'
import { ElevationCharts } from './ElevationCharts'
import { HorizonCompare } from './HorizonCompare'
import { MetricsTable } from './MetricsTable'
import { OverviewCards } from './OverviewCards'
import { AvailabilityCharts, MissionPerformance } from './PerformancePanels'
import { resultKey, selectionKey, validateScenario } from './scenario'
import { ExportButtons } from './ExportButtons'
import { RescueStory } from './RescueStory'
import { ScenarioManager } from './ScenarioManager'
import { SummaryPanel } from './SummaryPanel'
import { SyncTimeline } from './SyncTimeline'
import { TradeoffPanel } from './TradeoffPanel'
import { SelectField } from '../../ui/MdFields'
import './compare.css'
import { Empty, Explain, Icon, Section } from './ui'
import { useCompareStore } from './useCompareStore'
import { useView } from './useTimeAxis'
import { COMPARE_SECTIONS } from './sections'
import { MissionAssistant } from './assistant/MissionAssistant'
import { useAssistant } from './assistant/useAssistant'
import { CompareTour } from './tour/CompareTour'
import { TourButton, TourOffer } from './tour/TourButton'

// Reading order: choose plans -> the answer -> the evidence -> when it happens -> ranking -> deeper analysis.
const NAV = COMPARE_SECTIONS

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

/**
 * `onOpen3D` switches the app to the 3D view; the selected site/time are already in the shared app store.
 * `section`: the section to show (from the URL: refresh, Back / Forward); `onSection` is told when the
 * section bar jumps to one, so the URL can remember it. The bar scrolls within the page: it never
 * changes the app's route (a plain #cmp-... link used to replace the whole app with the landing page).
 */
export function ComparisonDashboard({ onOpen3D, section = null, onSection }: {
  onOpen3D?: () => void
  section?: string | null
  onSection?: (id: string) => void
} = {}) {
  const scenarios = useCompareStore((s) => s.scenarios)
  const selectedIds = useCompareStore((s) => s.selectedIds)
  const results = useCompareStore((s) => s.results)
  const allowDemo = useCompareStore((s) => s.allowDemo)
  const align = useCompareStore((s) => s.align)
  const educational = useCompareStore((s) => s.educational)
  const notes = useCompareStore((s) => s.notes)
  const sitesStatus = useCompareStore((s) => s.sitesStatus)
  const { setAllowDemo, setEducational, setAlign, loadSites, refresh } = useCompareStore.getState()
  const assistantOpen = useAssistant((s) => s.open)

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
  const rankingPairs = useCompareStore((s) => s.rankingPairs)
  // A canonical ranking belongs to one selected set; while the set is being re-ranked no rank is shown.
  const rankingCurrent = rankingSetKey === selectionKey(selected.filter((s) => !validateScenario(s).length), allowDemo)

  const entries: Entry[] = useMemo(() => {
    const offsets = axisOffsets(selected, align)
    return selected.map((s) => {
      const state = results[resultKey(s, allowDemo)]
      const result = state?.state === 'done' && state.result.status === 'ok' ? state.result : null
      // Unassessed scenarios (e.g. no data) still carry their UNKNOWN ranking entry.
      const raw = state?.state === 'done' ? state.result : null
      const ranking = rankingCurrent && raw ? raw.ranking : null
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

  const pageRef = useRef<HTMLDivElement>(null)
  const sectionBarRef = useRef<HTMLElement>(null)
  /** Scroll the page so the section's heading sits just below the sticky section bar. */
  const scrollToSection = (id: string, behavior: ScrollBehavior) => {
    const el = document.getElementById(id)
    const bar = sectionBarRef.current
    if (!el || !bar) return
    let scroller = el.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
    const box = scroller ?? document.scrollingElement ?? document.documentElement
    // Where the bar sits once stuck: below the scroller's top padding (the app header) plus its own offset.
    const top = scroller ? scroller.getBoundingClientRect().top : 0
    const barBottom = top + parseFloat(getComputedStyle(box).paddingTop || '0') + parseFloat(getComputedStyle(bar).top || '0') + bar.offsetHeight
    box.scrollTo({ top: box.scrollTop + el.getBoundingClientRect().top - barBottom - 12, behavior })
  }
  // The section from the URL (refresh, Back / Forward): shown, and kept in view while the results load
  // and the page above it grows, until the user scrolls or clicks, or after a few seconds.
  useEffect(() => {
    if (!section) return
    let active = true
    const show = () => {
      if (active) scrollToSection(section, 'auto')
    }
    show()
    const ro = new ResizeObserver(show)
    if (pageRef.current) ro.observe(pageRef.current)
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
    const stop = () => {
      active = false
      ro.disconnect()
      events.forEach((ev) => window.removeEventListener(ev, stop))
    }
    events.forEach((ev) => window.addEventListener(ev, stop, { passive: true }))
    const timer = setTimeout(stop, 5000)
    return () => {
      clearTimeout(timer)
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the URL's section changes
  }, [section])
  const jumpTo = (id: string) => {
    scrollToSection(id, 'smooth')
    onSection?.(id)
  }

  return (
    <div ref={pageRef} data-tour="compare-dashboard" className="cmp-page lp-light md-host min-h-full">
      {/* With the Mission Assistant open on a wide screen, the page makes room for it instead of being covered. */}
      <div className={`mx-auto max-w-[1500px] px-6 pb-16 pt-8 lg:px-8 ${assistantOpen ? 'min-[1100px]:mr-[416px]' : ''}`}>
        <header className="mb-6 flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <h1 className="text-[28px] font-medium leading-tight text-ink">Scenario comparison</h1>
            <p className="mt-2 text-base text-ink-3">Sunlight, Earth contact and outages for each landing plan, side by side, from the same JPL Horizons and LOLA data</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TourButton />
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
        <nav ref={sectionBarRef} aria-label="Comparison sections" className="sticky top-2 z-40 mb-6">
          <div>
            <GlassSurface radius="9999px" className="flex items-center gap-1 overflow-x-auto px-4 py-1">
              {NAV.map(([id, label]) => (
                <a key={id} href={routeHash('compare', id)} className="cmp-navlink"
                  onClick={(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return // new tab etc.: the link itself
                    e.preventDefault()
                    jumpTo(id)
                  }}>{label}</a>
              ))}
              <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap pl-4 text-xs" aria-live="polite">
                {loading ? 'Evaluating scenarios…' : backendDown ? <><Icon name="warning" size={14} className="text-red-700" /> Backend unavailable</> : anyData ? 'Data loaded' : ''}
              </span>
            </GlassSurface>
          </div>
        </nav>

        <TourOffer />
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
              <Section id="cmp-overview" title={`At a glance${sameSite && differentDates ? ': landing dates' : !differentDates && !sameSite ? ': landing sites' : ''}`}>
                <AtAGlance entries={entries} groups={rankingCurrent ? rankingGroups : []} pairs={rankingCurrent ? rankingPairs : []}
                  ready={rankingCurrent} onJump={jumpTo} />
                <RescueStory entries={entries} groups={rankingCurrent ? rankingGroups : []} pairs={rankingCurrent ? rankingPairs : []} />
                <OverviewCards entries={entries} />
              </Section>

              <Section id="cmp-metrics" title="Key metrics and requirements">
                {anyData ? <MetricsTable entries={entries} /> : <Empty>No scientific data for the selected scenarios yet.</Empty>}
              </Section>

              <Section id="cmp-summary" title="Decision and trade-offs" actions={
                <ExportButtons entries={entries} groups={rankingCurrent ? rankingGroups : []} pairs={rankingCurrent ? rankingPairs : []}
                  notes={notes} ready={rankingCurrent && entries.every((e) => e.state?.state !== 'loading')} />
              }>
                <SummaryPanel entries={entries} groups={rankingCurrent ? rankingGroups : []} pairs={rankingCurrent ? rankingPairs : []} />
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

              <Section id="cmp-performance" title="Ranking, availability and outages">
                <AvailabilityCharts entries={entries} />
                <div className="mt-6 border-t border-line pt-6">
                  <MissionPerformance entries={entries} groups={rankingCurrent ? rankingGroups : []} ranking={!rankingCurrent && entries.some((e) => e.result) ? 'updating' : 'ready'} />
                </div>
              </Section>

              <div className="flex items-center gap-3 pt-4">
                <h2 className="text-sm font-medium uppercase tracking-wide text-ink-3">Detailed analysis</h2>
                <span className="h-px flex-1 bg-line" aria-hidden="true" />
              </div>

              <Section id="cmp-charts" title="Solar and Earth elevation over time">
                {anyData ? <ElevationCharts entries={entries} view={view} align={align} originMs={originMs} /> : <Empty>No data to chart.</Empty>}
              </Section>

              <Section id="cmp-terrain" title="Terrain horizon and Sun/Earth position">
                <HorizonCompare entries={entries} />
              </Section>

              <Section id="cmp-tradeoff" title="Trade-off analysis">
                <TradeoffPanel entries={entries} />
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
      <MissionAssistant entries={entries} groups={rankingCurrent ? rankingGroups : []} pairs={rankingCurrent ? rankingPairs : []}
        notes={notes} ready={rankingCurrent && entries.every((e) => e.state?.state !== 'loading')} />
      <CompareTour />
    </div>
  )
}
