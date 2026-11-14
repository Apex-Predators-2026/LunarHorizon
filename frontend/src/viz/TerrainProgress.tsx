import { useEffect, useState } from 'react'
import { loadingBarUp, useTerrainLoad } from './globe/terrainLoad'

/** "Loading the Moon…" in the middle of the free 3D area until the first terrain is drawn. */
export function TerrainLoadingOverlay() {
  const firstLoad = useTerrainLoad((s) => s.drawn === 0)
  const finished = useTerrainLoad((s) => s.finished)
  if (!firstLoad) return null
  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 right-[calc(4vw+var(--lp-side-w))] flex items-center justify-center">
      <div className="md-reveal w-64 rounded-xl bg-slate-950/75 px-4 py-3 text-center text-sm text-slate-100 shadow-lg shadow-black/40">
        Loading the Moon…
        <Stripe />
        {finished > 0 && <div className="mt-1 text-[11px] tabular-nums text-slate-400">{finished} terrain tiles loaded</div>}
      </div>
    </div>
  )
}

/**
 * Small "Loading terrain…" bar above the map tools while terrain data is slow to arrive after the first
 * view (see loadingBarUp: quiet for ordinary zooming over cached terrain, never flashes).
 */
export function TerrainProgressBar() {
  const busy = useTerrainLoad((s) => s.pending > 0)
  const [shownAt, setShownAt] = useState<number | null>(null)
  useEffect(() => {
    if (!busy && shownAt === null) return // idle and hidden: nothing to watch
    const id = setInterval(() => {
      const now = performance.now()
      const up = loadingBarUp(useTerrainLoad.getState(), shownAt, now)
      if (up !== (shownAt !== null)) setShownAt(up ? now : null)
    }, 150)
    return () => clearInterval(id)
  }, [busy, shownAt])

  const visible = shownAt !== null
  return (
    <div className="pointer-events-none mb-2 flex justify-center">
      <div
        role="status"
        aria-label="Loading terrain"
        aria-hidden={!visible}
        className={`w-48 rounded-full bg-slate-950/70 px-3 py-1.5 text-center text-[11px] text-slate-200 shadow-lg shadow-black/30 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'lp-terrain-paused opacity-0'
        }`}
      >
        Loading terrain…
        <Stripe />
      </div>
    </div>
  )
}

const STRIPE_CSS =
  '@keyframes lp-terrain-slide{from{transform:translateX(-100%)}to{transform:translateX(300%)}}' +
  '.lp-terrain-stripe{animation:lp-terrain-slide 1.1s ease-in-out infinite}' +
  '.lp-terrain-paused .lp-terrain-stripe{animation-play-state:paused}' + // hidden: no work for the compositor
  '@media (prefers-reduced-motion:reduce){.lp-terrain-stripe{animation:none;width:100%;opacity:.6}}'

/** Indeterminate progress: a stripe sliding across (the amount of work left isn't known in advance). */
function Stripe() {
  return (
    <div className="relative mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-700">
      <style>{STRIPE_CSS}</style>
      <div className="lp-terrain-stripe absolute inset-y-0 left-0 w-1/3 rounded-full bg-coral" />
    </div>
  )
}
