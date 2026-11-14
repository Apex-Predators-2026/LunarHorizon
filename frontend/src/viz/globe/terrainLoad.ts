// Terrain loading state for the loading indicators (TerrainProgress.tsx). TileTree reports raw counts
// through advanceLoad; only the indicators listen, so loading ticks don't re-render the rest of the scene.
//
// No percentage: the quadtree only asks for a level once its parent has arrived, so the amount of work
// left is never known (a percentage would race ahead, then sit at 99%). Instead the bar says *that*
// terrain is loading, and only when the data is actually slow to come.
import { create } from 'zustand'

/** The bar appears once a tile request has been waiting this long (cached tiles answer in ~50 ms). */
export const SLOW_TILE_MS = 800
/** Once shown it stays at least this long, so it never flashes. */
export const MIN_SHOWN_MS = 1000
/** It hides once loading has been idle this long (brief pauses between zoom steps keep it up). */
export const HIDE_AFTER_IDLE_MS = 500

export interface TerrainLoad {
  drawn: number // tiles on screen (0 = nothing yet: the first-load message)
  pending: number // tiles in flight or queued for the current view
  finished: number // tile loads finished for this site
  waitingSince: number | null // when the oldest tile request still in flight started (ms, performance.now)
  idleSince: number | null // when pending last dropped to 0 (null while loading)
}

export const initialLoad: TerrainLoad = { drawn: 0, pending: 0, finished: 0, waitingSince: null, idleSince: null }

export const useTerrainLoad = create<TerrainLoad>(() => initialLoad)

/** The next state from TileTree's counts (the same object when nothing changed: no re-render). */
export function advanceLoad(
  prev: TerrainLoad,
  now: Pick<TerrainLoad, 'drawn' | 'pending' | 'finished' | 'waitingSince'>,
  time: number,
): TerrainLoad {
  const idleSince = now.pending > 0 ? null : (prev.idleSince ?? time)
  if (
    now.drawn === prev.drawn &&
    now.pending === prev.pending &&
    now.finished === prev.finished &&
    now.waitingSince === prev.waitingSince &&
    idleSince === prev.idleSince
  )
    return prev
  return { ...now, idleSince }
}

/**
 * Whether the "Loading terrain" bar should be up at `time`, given when it was shown (null = hidden).
 * Shown when a request has waited SLOW_TILE_MS; kept up while loading continues and for MIN_SHOWN_MS
 * at least; hidden HIDE_AFTER_IDLE_MS after loading stops.
 */
export function loadingBarUp(load: TerrainLoad, shownAt: number | null, time: number): boolean {
  if (load.drawn === 0) return false // the first-load message covers this
  if (shownAt === null) return load.waitingSince !== null && time - load.waitingSince >= SLOW_TILE_MS
  if (load.pending > 0 || time - shownAt < MIN_SHOWN_MS) return true
  return time - (load.idleSince ?? time) < HIDE_AFTER_IDLE_MS
}
