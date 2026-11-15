import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { goToView, parseRoute, rememberSection, routeHash } from './appRoute'
import { AtlasView } from './features/atlas/AtlasView'
import { MethodologyView } from './features/methodology/MethodologyView'
import { ComparisonDashboard } from './features/compare'
import { ReportPreview } from './features/compare/ReportPreview'
import { PlanDialogHost, PlanFab, PlansPanel } from './features/plans/PlansPanel'
import { GuideCard, TryMissionButton } from './features/guide/GuideCard'
import { useGuide } from './features/guide/mission'
import { MissionRescue } from './features/rescue'
import {
  TUTORIAL_STEPS,
  TutorialOfferChip,
  TutorialSpotlight,
  initTutorialFromSearch,
  useTutorialStore,
} from './features/tutorial'
import { GlassDemo } from './ui/GlassDemo'
import { GlassDefs } from './ui/GlassSurface'
import { GradientPreview } from './ui/GradientPreview'
import { LunarHorizonLogo } from './ui/LunarHorizonLogo'
import { InfoIcon } from './ui/icons'
import { installMangoTexture } from './ui/mangoShader'
import { initMaterialMotion } from './viz/materialMotion'
import { TooltipHost } from './viz/TooltipHost'
import { UiHiddenNotice } from './viz/UiHiddenNotice'
import { useUiPrefs } from './viz/uiPrefs'
import { Scene } from './viz/Scene'

// The landing page is the first screen ("/"); the navigator itself lives at #app/planner and
// #app/compare (appRoute.ts: Back / Forward and refresh keep the view). Loaded on demand so neither
// page pays for the other.
const Landing = lazy(() => import('./features/landing'))

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

function openNavigator() {
  window.location.hash = routeHash('planner')
  window.scrollTo(0, 0)
}

const VIEWS = [
  { id: 'planner', label: 'Mission Planner' },
  { id: 'compare', label: 'Scenario Comparison' }, // Member 4
  { id: 'atlas', label: 'Feasibility Atlas' },
  { id: 'method', label: 'Methodology' },
] as const

type View = (typeof VIEWS)[number]['id']

/** Title + tabs. One instance lives across both pages so the underline can slide between tabs. */
function TopNav({ view, onView }: { view: View; onView: (v: View) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const navRef = useRef<HTMLElement>(null)
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[view]
      if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (navRef.current) ro.observe(navRef.current)
    Object.values(refs.current).forEach((b) => b && ro.observe(b))
    document.fonts?.ready.then(measure)
    return () => ro.disconnect()
  }, [view])

  return (
    <div className="pointer-events-none flex flex-wrap items-center gap-x-[clamp(16px,3vw,44px)] gap-y-1">
      <a href="#" aria-label="Lunar Horizon Site Navigator: back to the project page" data-tip="Back to the project page" className="pointer-events-auto shrink-0">
        <LunarHorizonLogo className={`block h-auto ${view === 'planner' ? 'w-[clamp(176px,20vw,240px)]' : 'w-[clamp(144px,15vw,178px)]'}`} />
      </a>
      <nav ref={navRef} aria-label="Main" className="pointer-events-auto relative flex gap-[clamp(14px,2vw,32px)] pb-1">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            ref={(el) => {
              refs.current[v.id] = el
            }}
            type="button"
            data-tour={v.id === 'compare' ? 'nav-compare' : undefined}
            aria-label={v.id === 'method' ? v.label : undefined}
            data-tip={v.id === 'method' ? 'Methodology: data sources, validation and model assumptions' : undefined}
            aria-current={view === v.id ? 'page' : undefined}
            onClick={() => {
              if (v.id === 'compare') useTutorialStore.getState().recordInteraction('compare-open')
              onView(v.id)
            }}
            className="flex min-h-10 cursor-pointer items-center font-[var(--font-inter)] text-[clamp(15px,1.9vw,28px)] font-bold leading-tight tracking-[-0.06em] text-opal-50 transition-colors duration-200 hover:text-opal-300"
          >
            {v.id === 'method' ? (
              <span className="grid min-w-10 place-items-center">
                <InfoIcon size={36} />
              </span>
            ) : v.label}
          </button>
        ))}
        <span
          aria-hidden
          className="absolute bottom-0 h-[2px] rounded-full bg-opal-50 transition-[left,width] duration-[400ms] ease-[var(--md-ease-standard)]"
          style={bar ? { left: bar.left, width: bar.width } : { opacity: 0 }}
        />
      </nav>
    </div>
  )
}

const NAV_PAD = 'pl-[clamp(16px,4.5vw,65px)] pt-[clamp(14px,2.5vw,34px)]'

export default function App() {
  // The view comes from the URL, so Back / Forward and refresh show the same page.
  const hash = useHash()
  const route = parseRoute(hash)
  const view: View = route.page === 'app' ? route.view : 'planner'
  const compare = view === 'compare'
  const guideActive = useGuide((g) => g.active) // the story and the feature tutorial never compete for focus
  const pageView = view !== 'planner' // a scrolling page (Comparison, Atlas, Methodology) rather than the 3D view
  useEffect(() => initMaterialMotion(), [])
  useEffect(() => installMangoTexture(), [])
  const dark = useUiPrefs((u) => u.dark)
  const uiHidden = useUiPrefs((u) => u.uiHidden)
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('lp-dark', dark)
  }, [dark])

  const tourLaunchedRef = useRef(false)

  useEffect(() => {
    if (!tourLaunchedRef.current && parseRoute(hash).page === 'app') {
      tourLaunchedRef.current = true
      initTutorialFromSearch()
    }
  }, [hash])

  useEffect(() => {
    let lastNonce = -1
    const sync = () => {
      const st = useTutorialStore.getState()
      if (!st.open || st.prepNonce === lastNonce) return
      lastNonce = st.prepNonce
      const nextView = TUTORIAL_STEPS[st.stepIndex]?.prep?.appView
      if (nextView) goToView(nextView)
    }
    const id = setTimeout(sync, 0)
    const unsub = useTutorialStore.subscribe(sync)
    return () => {
      clearTimeout(id)
      unsub()
    }
  }, [])
  if (route.page === 'mango') return <GradientPreview />
  if (route.page === 'glass') return (
    <>
      <GlassDefs />
      <GlassDemo />
    </>
  )
  if (route.page !== 'app') return (
    <Suspense fallback={<div className="h-full bg-black" />}>
      <Landing onOpen={openNavigator} />
    </Suspense>
  )

  return (
    <div className="relative h-full overflow-hidden bg-black" data-ui-hidden={uiHidden && !pageView}>
      <UiHiddenNotice />
      {/* One tooltip host for every view: data-tip labels on Comparison, Atlas and Methodology need it too. */}
      <TooltipHost />
      {/* The header is rendered once for both pages (floating over the 3D view, or above the comparison). */}
      <GlassDefs />
      <header className={`ui-chrome md-host absolute inset-x-0 top-0 z-30 pb-3 ${NAV_PAD} ${pageView ? 'border-b border-line bg-black' : 'pointer-events-none'}`}>
        <div className="flex flex-wrap items-center gap-x-[clamp(16px,3vw,44px)] gap-y-2">
          <TopNav view={view} onView={goToView} />
          <TryMissionButton />
        </div>
      </header>
      <PlanDialogHost />
      <GuideCard />
      <ReportPreview />
      {compare ? (
        <main key="compare" className="md-fade-through h-full overflow-y-auto pt-[calc(clamp(14px,2.5vw,34px)+clamp(22px,2.7vw,40px)+28px)]">
          <ComparisonDashboard onOpen3D={() => goToView('planner')} section={route.section} onSection={rememberSection} />
        </main>
      ) : view === 'atlas' ? (
        <main key="atlas" className="md-fade-through h-full overflow-y-auto pt-[calc(clamp(14px,2.5vw,34px)+clamp(22px,2.7vw,40px)+28px)]">
          <AtlasView />
        </main>
      ) : view === 'method' ? (
        <main key="method" className="md-fade-through h-full overflow-y-auto pt-[calc(clamp(14px,2.5vw,34px)+clamp(22px,2.7vw,40px)+28px)]">
          <MethodologyView />
        </main>
      ) : (
        <main key="planner" className="md-fade-through h-full">
          {/* Full-screen 3D simulation; the sidebar content is Member 5's mission-rescue panel. */}
          <Scene
            fab={<PlanFab />}
            sidebar={
              <div className="space-y-6">
                <PlansPanel onCompare={() => goToView('compare')} />
                <MissionRescue />
              </div>
            }
          />
        </main>
      )}
      {!guideActive && <TutorialOfferChip uiHidden={uiHidden && !pageView} compareActive={compare} />}
      <TutorialSpotlight
        uiHidden={uiHidden && !pageView}
        appView={view === 'atlas' || view === 'method' ? undefined : view} // the guided tour has no Atlas or Methodology steps
        onOpenCompare={() => goToView('compare')}
        onResetTourView={() => goToView('planner')}
      />
    </div>
  )
}
