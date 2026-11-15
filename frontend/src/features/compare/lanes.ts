// Geometry of the synchronized availability lanes (SyncTimeline), kept apart from the component for tests.
import type { TimelineColumns } from './types'

export const LANE = 20 // lane height in px

/**
 * Area path of the visible solar-disk fraction inside a lane. Each sample covers [t, t + step) (sample-and-hold, as
 * the engine reads it), clipped to the mission [0, duration]. Unknown samples draw nothing (the unknown hatch marks
 * them); a visible sliver whose disk share rounds to 0 still shows as a thin line, not as darkness.
 */
export function sunPath(tl: TimelineColumns, offset: number, x: (v: number) => number, view: [number, number], top: number, durationH: number) {
  const parts: string[] = []
  for (let i = 0; i < tl.hour.length; i++) {
    const a = Math.max(0, tl.hour[i])
    const b = Math.min(durationH, tl.hour[i] + tl.step_hours, tl.hour[i + 1] ?? Infinity)
    if (b <= a || offset + b < view[0] || offset + a > view[1]) continue
    let frac = tl.sun_visible_fraction[i]
    if (frac === null) continue // unknown: no sunlight is drawn and none is implied
    if (frac === 0 && tl.sun_visible?.[i] === true) frac = 0.03 // a sliver: visible, below the data's rounding
    if (frac <= 0) continue
    const y = top + LANE - frac * LANE
    const x0 = x(offset + a).toFixed(1), x1 = x(offset + b).toFixed(1)
    parts.push(`M${x0},${top + LANE} L${x0},${y.toFixed(1)} L${x1},${y.toFixed(1)} L${x1},${top + LANE} Z`)
  }
  return parts.join(' ')
}
