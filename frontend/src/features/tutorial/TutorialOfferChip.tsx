import { InteractiveGrainGradient } from '../../ui/InteractiveGrainGradient'
import { playUiTap } from '../../viz/sfx'
import { useTutorialStore } from './useTutorialStore'

/**
 * Non-blocking M3 welcome pill inside #app offering the 90-second Guided Mission Briefing.
 * Respects dark mode (.lp-light/.lp-dark), `dontShowAgain`, and `[data-ui-hidden='true']`.
 */
export function TutorialOfferChip({ uiHidden, compareActive }: { uiHidden: boolean; compareActive: boolean }) {
  const open = useTutorialStore((s) => s.open)
  const offerDismissed = useTutorialStore((s) => s.offerDismissed)
  const dontShowAgain = useTutorialStore((s) => s.dontShowAgain)
  const startTour = useTutorialStore((s) => s.startTour)
  const dismissOffer = useTutorialStore((s) => s.dismissOffer)

  if (uiHidden || open || offerDismissed || dontShowAgain) return null

  return (
    <aside
      aria-label="Interactive mission briefing offer"
      data-testid="tutorial-offer-chip"
      className={`lp-light md-reveal pointer-events-auto fixed z-40 flex max-w-[min(360px,calc(100vw-32px))] flex-col gap-2.5 rounded-[22px] border border-opal-300 bg-opal-50/95 p-3.5 text-slate-100 shadow-xl shadow-black/35 backdrop-blur-md ${
        compareActive
          ? 'bottom-5 left-[clamp(16px,4.5vw,65px)]'
          : 'right-[calc(4vw+clamp(280px,23.5vw,360px)+20px)] top-[clamp(72px,7vw,96px)] max-lg:bottom-5 max-lg:left-4 max-lg:right-auto max-lg:top-auto max-md:hidden'
      }`}
      style={{ fontFamily: 'var(--font-inter)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-coral" aria-hidden />
            <p className="font-display text-sm font-bold tracking-tight text-slate-100">
              Guided Tour: Mission Briefing
            </p>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-300">
            Learn 3D shadows, polar sky blockers, JPL verification &amp; Mission Rescue interactively in 8 quick stops.
          </p>
        </div>
        <button
          type="button"
          data-no-sfx
          aria-label="Dismiss guided tour offer"
          onClick={() => {
            playUiTap()
            dismissOffer(false)
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-opal-100 hover:text-slate-100"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          data-no-sfx
          onClick={() => {
            playUiTap()
            dismissOffer(true)
          }}
          className="inline-flex h-8 items-center rounded-full px-2 text-xs font-medium text-slate-400 transition-colors hover:text-slate-100"
        >
          Don&apos;t show again
        </button>

        <button
          type="button"
          onClick={() => startTour(0)}
          className="md-compact relative overflow-hidden font-semibold text-white shadow-sm"
        >
          <span aria-hidden className="absolute inset-0">
            <InteractiveGrainGradient className="h-full w-full" />
          </span>
          <span className="relative z-10">Start tour (8 stops)</span>
        </button>
      </div>
    </aside>
  )
}
