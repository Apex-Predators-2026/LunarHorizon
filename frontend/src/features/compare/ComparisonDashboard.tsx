// Multi-Scenario Comparison dashboard (Member 4). Page layout and data wiring only; each section is
// its own component and all comparison logic lives in analysis.ts.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'

import { GlassSurface } from '../../ui/GlassSurface'

import { axisOrigin, fullDomain, type Entry } from './analysis'
import { AtAGlance } from './AtAGlance'
import { ConditionsPanel } from './ConditionsPanel'
import { axisPlacement, missionTime } from './missionTime'
import { ElevationCharts } from './ElevationCharts'
import { HorizonCompare } from './HorizonCompare'
import { MetricsTable } from './MetricsTable'
import { OverviewCards } from './OverviewCards'
import { AvailabilityCharts, MissionPerformance } from './PerformancePanels'
import { buildEntries } from './entries'
import { resultKey, selectionKey, validateScenario } from './scenario'
import { DecisionOverview } from './DecisionOverview'
import { RescueStory } from './RescueStory'
import { SummaryPanel } from './SummaryPanel'
import { SyncTimeline } from './SyncTimeline'
import { TradeoffPanel } from './TradeoffPanel'
import { Disclosure, TabPanel, Tabs, useReveal } from './disclosure'
import { ScenarioStrip } from './ScenarioStrip'
import './compare.css'
import { Empty, Explain, Icon, Section } from './ui'
import { useCompareStore } from './useCompareStore'
import { useView } from './useTimeAxis'
import { COMPARE_TABS, TAB_ENTRY, tabOfSection, useCompareView } from './sections'
import { DataAssumptionsBlock, MissionAssessmentBlock, ScienceVsEngineeringBlock } from './PlanAnalysis'
import { MissionAssistant } from './assistant/MissionAssistant'
import { useAssistantLayout } from './assistant/layout'
import { useAssistant } from './assistant/useAssistant'
import { CompareTour } from './tour/CompareTour'
import { TourButton, TourOffer } from './tour/TourButton'
import { ReportHeaderAction } from './ReportHeaderAction'
import { COMPARE_METHODOLOGY } from '../../appRoute'
import { ComparisonMethodology } from './methodology/ComparisonMethodology'
import { MethodologyIntro } from './methodology/MethodologyIntro'

const originOf = (e: Entry) => axisPlacement(missionTime(e)).landingMs

/**
 * `onOpen3D` switches the app to the 3D view; the selected site/time are already in the shared app store.
 * `section`: the section to show (from the URL: refresh, Back / Forward); `onSection` is told when the
 * section bar jumps to one, so the URL can remember it. The bar scrolls within the page: it never
 * changes the app's route (a plain #cmp-... link used to replace the whole app with the landing page).
 */
export function ComparisonDashboard({ onOpen3D, section = null, onSection }: {
  onOpen3D?: () => void
  section?: string | null
  onSection?: (id: string | null) => void
} = {}) {
  const scenarios = useCompareStore((s) => s.scenarios)
  const selectedIds = useCompareStore((s) => s.selectedIds)
  const results = useCompareStore((s) => s.results)
  const allowDemo = useCompareStore((s) => s.allowDemo)
  const align = useCompareStore((s) => s.align)
  const notes = useCompareStore((s) => s.notes)
  const sitesStatus = useCompareStore((s) => s.sitesStatus)
  const { loadSites, refresh } = useCompareStore.getState()
  const assistantIsOpen = useAssistant((s) => s.open)
  const assistantLayout = useAssistantLayout((s) => s.layout)
  const assistantOpen = assistantIsOpen && assistantLayout === 'side' // the page only makes room for the side panel

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

  const entries: Entry[] = useMemo(() => buildEntries(selected, results, allowDemo, align, rankingCurrent),
    [selected, results, allowDemo, align, rankingCurrent])

  const full = useMemo(() => fullDomain(entries), [entries])
  const view = useView(full)
  const originMs = useMemo(() => axisOrigin(entries), [entries])
  const anyData = entries.some((e) => e.result)
  const hasDemo = entries.some((e) => e.result?.data_kind === 'demonstration')
  const loading = entries.some((e) => e.state?.state === 'loading')
  const backendDown = entries.some((e) => e.state?.state === 'error' && /Backend unavailable/.test(e.state.message))
  const sameSite = selected.length > 1 && new Set(selected.map((s) => s.site.id)).size === 1
  // Evaluated landings: two requests that the grid evaluates at the same hour are the same date.
  const differentDates = new Set(entries.map((e) => originOf(e))).size > 1

  const timelineProps = { entries, full, view, align, originMs }

  const tab = useCompareView((s) => s.tab)
  const setTab = useCompareView((s) => s.setTab)
  const reveal = useReveal((s) => s.reveal)
  /** Open whatever hides a section (its view, then its expandable block) so it can be scrolled to. */
  const revealSection = (id: string) => {
    const t = tabOfSection(id)
    if (t) setTab(t)
    reveal(id)
  }

  const pageRef = useRef<HTMLDivElement>(null)
  const sectionBarRef = useRef<HTMLElement>(null)
  /** Scroll the page so the section's heading sits just below the sticky section bar. */
  const scrollToSection = (id: string, behavior: ScrollBehavior) => {
    const el = document.getElementById(id)
    const bar = sectionBarRef.current
    if (!el || !bar || el.getClientRects().length === 0) return // hidden (its view is not open yet): the next layout pass retries
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
  const onMethodology = section === COMPARE_METHODOLOGY // the methodology subpage, not a section of this page
  useLayoutEffect(() => {
    if (section && !onMethodology) revealSection(section)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the URL's section changes
  }, [section])
  useEffect(() => {
    if (!section || onMethodology) return
    let active = true
    const show = () => {
      if (active) scrollToSection(section, 'auto')
    }
    show()
    const ro = new ResizeObserver(show)
    // The page box can keep its size while its content grows, so watch the content box too.
    if (pageRef.current) {
      ro.observe(pageRef.current)
      if (pageRef.current.firstElementChild) ro.observe(pageRef.current.firstElementChild)
    }
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
    const stop = () => {
      active = false
      ro.disconnect()
      events.forEach((ev) => window.removeEventListener(ev, stop))
    }
    events.forEach((ev) => window.addEventListener(ev, stop, { passive: true }))
    // Results keep arriving and growing the page above the section for a while, so it stays in view until the user
    // scrolls, clicks or types (which stops it above), or after 40 s.
    const timer = setTimeout(stop, 40000)
    const poll = setInterval(show, 300) // the resize observer alone missed late growth
    return () => {
      clearTimeout(timer)
      clearInterval(poll)
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the URL's section changes
  }, [section])
  const jumpTo = (id: string) => {
    revealSection(id)
    // Let the revealed view / block lay out before measuring where to scroll.
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToSection(id, 'smooth')))
    onSection?.(id)
  }
  const chooseTab = (t: typeof tab) => {
    setTab(t)
    onSection?.(TAB_ENTRY[t]) // the URL remembers the view (no history step)
  }

  // The methodology subpage replaces the page while it is open; every plan and result stays in the store.
  if (onMethodology) return <ComparisonMethodology />

  return (
    <div ref={pageRef} data-tour="compare-dashboard" className="cmp-page lp-light md-host min-h-full">
      {/* With the Mission Assistant open on a wide screen, the page makes room for it instead of being covered. */}
      <div className="cmp-dashboard-content mx-auto max-w-[1500px] px-6 pb-16 pt-6 lg:px-8" data-assistant-open={assistantOpen}>
        <header className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-medium leading-tight text-ink">Scenario comparison</h1>
            <p className="mt-1 text-sm text-ink-3">Sunlight, Earth contact and outages for each landing plan, side by side, from the same JPL Horizons and LOLA data</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TourButton />
            <ReportHeaderAction />
          </div>
        </header>

        <ScenarioStrip />

        {/* The three views. Sticky just below the app header; the link to each section still works (it opens the
            view and block that hold it first). */}
        <nav ref={sectionBarRef} aria-label="Comparison views" className="sticky top-2 z-40 my-4">
          <GlassSurface radius="9999px" className="px-3 py-1">
            <Tabs base="cmp" label="Comparison views" tabs={COMPARE_TABS} value={tab} onChange={chooseTab}
              trailing={
                <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap pl-4 text-xs" aria-live="polite">
                  {loading ? 'Evaluating scenarios…' : backendDown ? <><Icon name="warning" size={14} className="text-red-700" /> Backend unavailable</> : anyData ? 'Data loaded' : ''}
                </span>
              } />
          </GlassSurface>
        </nav>

        <TourOffer />
        {hasDemo && (
          <div role="alert" className="mb-4 flex gap-3 rounded-xl bg-amber-950 p-4 text-sm text-amber-200">
            <Icon name="warning" className="mt-0.5" /><p><span className="font-medium">Demonstration data in use.</span> Scenarios tagged “Demonstration data” use a synthetic placeholder (approximate Sun/Earth motion, invented terrain). They are ranked separately and must not be used for planning.</p>
          </div>
        )}
        {backendDown && (
          <div role="alert" className="mb-4 rounded-xl bg-red-950 p-4 text-sm text-red-200">
            The backend is not reachable, so no scientific data can be shown. Start it with <code>uvicorn app.main:app --port 8000</code> in <code>backend/</code>. Scenarios are kept for this session.
          </div>
        )}

        {selected.length === 0 ? (
          <Empty>Select at least two scenarios above to start comparing.</Empty>
        ) : (
          <div className="space-y-6">
            <TabPanel base="cmp" id="overview" value={tab}>
              <div className="space-y-6">
                <Section id="cmp-overview" title={`At a glance${sameSite && differentDates ? ': landing dates' : !differentDates && !sameSite ? ': landing sites' : ''}`}>
                  {/* Decision first: the supported recommendation (or why there is none), the decisive requirement, the next action. */}
                  <div className="mb-6" data-tour="compare-decision">
                    <DecisionOverview entries={entries} groups={rankingCurrent ? rankingGroups : []} pairs={rankingCurrent ? rankingPairs : []}
                      rankingCurrent={rankingCurrent} notes={notes} />
                  </div>
                  <AtAGlance entries={entries} groups={rankingCurrent ? rankingGroups : []} pairs={rankingCurrent ? rankingPairs : []}
                    ready={rankingCurrent} onJump={jumpTo} />
                  <RescueStory entries={entries} groups={rankingCurrent ? rankingGroups : []} pairs={rankingCurrent ? rankingPairs : []} />
                  <OverviewCards entries={entries} />
                </Section>

                <Disclosure id="cmp-summary" card level={2} title="Decision and trade-offs"
                  summary="The reasoning behind the decision: who wins on what, and what is still uncertain">
                  <SummaryPanel entries={entries} groups={rankingCurrent ? rankingGroups : []} pairs={rankingCurrent ? rankingPairs : []} />
                </Disclosure>
              </div>
            </TabPanel>

            <TabPanel base="cmp" id="evidence" value={tab}>
              <div className="space-y-6">
                <Section id="cmp-metrics" title="Key metrics and requirements">
                  {anyData ? <MetricsTable entries={entries} /> : <Empty>No scientific data for the selected scenarios yet.</Empty>}
                </Section>

                <Section id="cmp-assessment" title="Mission assessment">
                  {anyData ? <MissionAssessmentBlock entries={entries} /> : <Empty>The assessment appears once scenarios have data.</Empty>}
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
              </div>
            </TabPanel>

            <TabPanel base="cmp" id="detail" value={tab}>
              <div className="space-y-4">
                <Disclosure id="cmp-charts" card lazy level={2} defaultOpen title="Solar and Earth elevation over time"
                  summary="Sun and Earth elevation for each scenario, on the shared timeline">
                  {anyData ? <ElevationCharts entries={entries} view={view} align={align} originMs={originMs} /> : <Empty>No data to chart.</Empty>}
                </Disclosure>
                <Disclosure id="cmp-terrain" card lazy level={2} title="Terrain horizon and Sun/Earth position"
                  summary="Why a site is shadowed: the local horizon against the Sun and Earth">
                  <HorizonCompare entries={entries} />
                </Disclosure>
                <Disclosure id="cmp-tradeoff" card lazy level={2} title="Trade-off analysis"
                  summary="Scenarios compared across several measures at once">
                  <TradeoffPanel entries={entries} />
                </Disclosure>
                <Disclosure id="cmp-science" card lazy level={2} title="Science vs engineering"
                  summary="Find the landing that best balances what the science team wants against what is safe to operate">
                  <ScienceVsEngineeringBlock entries={entries} />
                </Disclosure>
                <Disclosure id="cmp-assumptions" card lazy level={2} title="Data, assumptions and limitations"
                  summary="What the assessment is built from, what it assumes and what it cannot tell you">
                  <DataAssumptionsBlock entries={entries} />
                </Disclosure>
              </div>
            </TabPanel>

            {notes.length > 0 && (
              <footer className="px-1 text-xs leading-relaxed text-ink-4">
                <h2 className="mb-2 text-sm font-medium text-ink-3">Data sources and assumptions</h2>
                <ul className="list-disc space-y-1 pl-4">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
              </footer>
            )}
          </div>
        )}

        {/* Last on the page, after every result: a compact way into the methodology subpage. */}
        <MethodologyIntro />
      </div>
      <MissionAssistant entries={entries} groups={rankingCurrent ? rankingGroups : []} pairs={rankingCurrent ? rankingPairs : []}
        notes={notes} ready={rankingCurrent && entries.every((e) => e.state?.state !== 'loading')} onJump={jumpTo} />
      <CompareTour />
    </div>
  )
}
