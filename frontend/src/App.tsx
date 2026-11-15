import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ComparisonDashboard } from './features/compare'
import { PlanDialogHost, PlanFab, PlansPanel } from './features/plans/PlansPanel'
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
import { installMangoTexture } from './ui/mangoShader'
import { initMaterialMotion } from './viz/materialMotion'
import { UiHiddenNotice } from './viz/UiHiddenNotice'
import { useUiPrefs } from './viz/uiPrefs'
import { Scene } from './viz/Scene'

// The landing page is the first screen ("/"); the navigator itself lives at #app. Loaded on demand so
// neither page pays for the other.
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
  window.location.hash = 'app'
  window.scrollTo(0, 0)
}

const VIEWS = [
  { id: 'planner', label: 'Mission Planner' },
  { id: 'compare', label: 'Scenario Comparison' }, // Member 4
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
    <div className="pointer-events-none flex flex-wrap items-baseline gap-x-[clamp(16px,3vw,44px)] gap-y-1">
      <a href="#" title="Back to the project page" className="pointer-events-auto font-display text-[clamp(22px,2.7vw,40px)] font-bold leading-none tracking-[-0.06em] text-opal-50 no-underline">
        Site Navigator
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
            aria-current={view === v.id ? 'page' : undefined}
            onClick={() => {
              if (v.id === 'compare') useTutorialStore.getState().recordInteraction('compare-open')
              onView(v.id)
            }}
            className="flex min-h-10 cursor-pointer items-center font-[var(--font-inter)] text-[clamp(15px,1.9vw,28px)] font-bold leading-tight tracking-[-0.06em] text-opal-50 transition-colors duration-200 hover:text-opal-300"
          >
            {v.label}
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
  const [view, setView] = useState<View>('planner')
  const compare = view === 'compare'
  useEffect(() => initMaterialMotion(), [])
  useEffect(() => installMangoTexture(), [])
  const dark = useUiPrefs((u) => u.dark)
  const uiHidden = useUiPrefs((u) => u.uiHidden)
  useEffect(() => {
    document.documentElement.classList.toggle('lp-dark', dark)
  }, [dark])

  const hash = useHash()
  const tourLaunchedRef = useRef(false)

  useEffect(() => {
    if (!tourLaunchedRef.current && hash.startsWith('#app')) {
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
      if (nextView) setView((cur) => (cur === nextView ? cur : nextView))
    }
    const id = setTimeout(sync, 0)
    const unsub = useTutorialStore.subscribe(sync)
    return () => {
      clearTimeout(id)
      unsub()
    }
  }, [])
  if (hash === '#mango') return <GradientPreview />
  if (hash === '#glass') return (
    <>
      <GlassDefs />
      <GlassDemo />
    </>
  )
  if (!hash.startsWith('#app')) return (
    <Suspense fallback={<div className="h-full bg-black" />}>
      <Landing onOpen={openNavigator} />
    </Suspense>
  )

  return (
    <div className="relative h-full overflow-hidden bg-black" data-ui-hidden={uiHidden && !compare}>
      <UiHiddenNotice />
      {/* The header is rendered once for both pages (floating over the 3D view, or above the comparison). */}
      <GlassDefs />
      <header className={`ui-chrome md-host absolute inset-x-0 top-0 z-30 pb-3 ${NAV_PAD} ${compare ? 'border-b border-line bg-black' : 'pointer-events-none'}`}>
        <TopNav view={view} onView={setView} />
      </header>
      <PlanDialogHost />
      {compare ? (
        <main key="compare" className="md-fade-through h-full overflow-y-auto pt-[calc(clamp(14px,2.5vw,34px)+clamp(22px,2.7vw,40px)+28px)]">
          <ComparisonDashboard onOpen3D={() => setView('planner')} />
        </main>
      ) : (
        <main key="planner" className="md-fade-through h-full">
          {/* Full-screen 3D simulation; the sidebar content is Member 5's mission-rescue panel. */}
          <Scene
            fab={<PlanFab />}
            sidebar={
              <div className="space-y-6">
                <PlansPanel onCompare={() => setView('compare')} />
                <MissionRescue />
              </div>
            }
          />
        </main>
      )}
      <TutorialOfferChip uiHidden={uiHidden && !compare} compareActive={compare} />
      <TutorialSpotlight
        uiHidden={uiHidden && !compare}
        appView={view}
        onOpenCompare={() => setView('compare')}
        onResetTourView={() => setView('planner')}
      />
    </div>
  )
}
