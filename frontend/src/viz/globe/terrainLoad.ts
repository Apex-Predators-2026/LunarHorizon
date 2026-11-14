// Terrain loading progress for the loading bar (TerrainProgress.tsx). TileTree updates it; only the
// bar listens, so progress ticks don't re-render the rest of the scene.
import { create } from 'zustand'

export interface TerrainLoad {
  drawn: number // tiles on screen (0 = nothing yet: the first-load message)
  pending: number // tiles in flight or queued for the current view
  done: number // tiles finished in this loading burst
  total: number // tiles needed in this burst so far (done + pending)
}

export const useTerrainLoad = create<TerrainLoad>(() => ({ drawn: 0, pending: 0, done: 0, total: 0 }))

/** Fraction done in the current burst (1 when idle). */
export const loadProgress = (s: TerrainLoad) => (s.pending === 0 ? 1 : Math.min(1, s.done / Math.max(1, s.total)))
