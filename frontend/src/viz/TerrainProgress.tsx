import { useEffect, useState } from 'react'
import { loadProgress, useTerrainLoad } from './globe/terrainLoad'

/** "Loading the Moon…" in the middle of the free 3D area until the first terrain is drawn. */
export function TerrainLoadingOverlay() {
  const load = useTerrainLoad()
  if (load.drawn > 0) return null
  const pct = Math.round(loadProgress(load) * 100)
  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 right-[calc(4vw+var(--lp-side-w))] flex items-center justify-center">
      <div className="md-reveal w-64 rounded-xl bg-slate-950/75 px-4 py-3 text-center text-sm text-slate-100 shadow-lg shadow-black/40">
        Loading the Moon…
        <Bar pct={load.pending > 0 ? pct : null} />
        {load.total > 0 && (
          <div className="mt-1 text-[11px] tabular-nums text-slate-400">
            {load.done} of {load.total} terrain tiles
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Slim "Loading terrain" bar (sits above the map tools) whenever more terrain streams in after the
 * first view. Shown only for loads longer than 300 ms, so ordinary camera moves don't flicker it;
 * it reaches 100% before fading out.
 */
export function TerrainProgressBar() {
  const load = useTerrainLoad()
  const busy = load.pending > 0
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShown(busy), busy ? 300 : 500)
    return () => clearTimeout(t)
  }, [busy])
  const pct = Math.round(loadProgress(load) * 100)
  const visible = shown && load.drawn > 0
  return (
    <div className="pointer-events-none mb-2 flex justify-center">
      <div
        role="progressbar"
        aria-label="Loading terrain"
        aria-hidden={!visible}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className={`w-56 rounded-full bg-slate-950/70 px-3 py-1.5 text-[11px] text-slate-200 shadow-lg shadow-black/30 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="flex justify-between tabular-nums">
          <span>Loading terrain</span>
          <span>{busy ? `${load.done} / ${load.total}` : 'done'}</span>
        </div>
        <Bar pct={pct} />
      </div>
    </div>
  )
}

/** Progress bar; `null` = still starting (a moving stripe instead of a percentage). */
function Bar({ pct }: { pct: number | null }) {
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-700">
      {pct === null ? (
        <div className="h-full w-1/3 animate-pulse rounded-full bg-coral" />
      ) : (
        <div className="h-full rounded-full bg-coral transition-[width] duration-200" style={{ width: `${pct}%` }} />
      )}
    </div>
  )
}
