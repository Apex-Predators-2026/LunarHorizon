// Which surface data the 3D view is showing: the LOLA terrain close up, the LRO photo mosaic zoomed out
// (tileImagery.ts fades between them by altitude). TileTree publishes the mix in whole percent; only the
// coverage badge (CoverageBadge.tsx) listens.
import { create } from 'zustand'

export const useCoverage = create<{ mixPct: number }>(() => ({ mixPct: 0 }))

export interface CoverageLabel {
  title: string
  detail: string
  tip: string
}

const TERRAIN_TIP =
  'Close up the surface is NASA LOLA elevation data (Moon Trek), lit by the Sun at the selected time: the shadows are real for that moment.'
const IMAGERY_TIP =
  'Zoomed out the surface is the LRO Wide Angle Camera photo mosaic (Moon Trek), shaded by the Sun at the selected time. The photos have their own shadows from when they were taken; nothing is calculated from them.'

/** What the badge says at a given mix (0 = terrain only, 100 = imagery only). */
export function coverageLabel(mixPct: number): CoverageLabel {
  if (mixPct <= 0) return { title: 'LOLA terrain', detail: 'live sunlight & shadows', tip: TERRAIN_TIP }
  if (mixPct >= 100) return { title: 'LRO photo mosaic', detail: 'zoomed-out view', tip: IMAGERY_TIP }
  return {
    title: 'LOLA terrain → LRO photo mosaic',
    detail: `${mixPct}% photo · zoom out for more`,
    tip: `${TERRAIN_TIP} Zooming out fades it into the LRO photo mosaic.`,
  }
}
