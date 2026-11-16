import { useEffect, useState } from 'react'
import { LoadingIndicator } from '../ui/LoadingIndicator'
import { loadingBarUp, useTerrainLoad } from './globe/terrainLoad'

/**
 * "Loading the Moon…" in the middle of the free 3D area until the first terrain is drawn. When the site list could
 * not be loaded (backend down), says so instead, with the automatic retry and a Retry button.
 */
export function TerrainLoadingOverlay({ problem = null, retryInS = null, onRetry }: {
  /** Why the site list failed; null while there is no failure. Kept during a retry. */
  problem?: string | null
  /** Seconds until the next automatic retry; null while a retry is in flight. */
  retryInS?: number | null
  onRetry?: () => void
} = {}) {
  const firstLoad = useTerrainLoad((s) => s.drawn === 0)
  const finished = useTerrainLoad((s) => s.finished)
  if (!firstLoad) return null
  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 right-[calc(4vw+var(--lp-side-w))] flex items-center justify-center max-md:right-0">
      {problem ? (
        <div role="alert" className="md-reveal pointer-events-auto flex w-72 flex-col items-center gap-2 rounded-2xl bg-black/70 px-4 py-4 text-center text-sm text-white backdrop-blur">
          <p className="font-semibold">Can't reach the Lunar Horizon server</p>
          <p className="text-[11px] text-white/70">
            The site list didn't load ({problem}).{' '}
            {import.meta.env.DEV
              ? 'Check that the backend is running on port 8000.'
              : 'The server may be starting up after being idle; this can take about a minute.'}
          </p>
          <p className="text-[11px] text-white/70" aria-live="polite">
            {retryInS === null ? 'Trying again…' : `Trying again automatically in about ${retryInS} s.`}
          </p>
          {onRetry && (
            <button
              type="button"
              disabled={retryInS === null}
              onClick={onRetry}
              className="mt-1 rounded-full bg-amber-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-60"
            >
              Retry now
            </button>
          )}
        </div>
      ) : (
        <div className="md-reveal flex w-64 flex-col items-center gap-3 px-4 py-5 text-center text-sm text-white"
          style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
          <LoadingIndicator size={64} label="Loading the Moon" />
          Loading the Moon…
          {finished > 0 && <div className="-mt-1 text-[11px] tabular-nums text-white/70">{finished} terrain tiles loaded</div>}
        </div>
      )}
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
    <div className="recede-behind-menu pointer-events-none mb-2 flex justify-center">
      <div
        role="status"
        aria-label="Loading terrain"
        aria-hidden={!visible}
        style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}
        className={`w-52 px-3 py-1.5 text-center text-[11px] text-white transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <span className="inline-flex items-center justify-center gap-2">
          <LoadingIndicator size={22} contained={false} color="#ffffff" label="Loading terrain" />
          Loading terrain…
        </span>
      </div>
    </div>
  )
}
