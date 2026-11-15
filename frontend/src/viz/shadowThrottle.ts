// Cascaded shadows redraw four shadow maps (each re-renders every terrain tile), so redrawing them on every
// frame of a fast zoom or orbit is the heaviest thing the scene does. The maps are fixed in world space, so
// they stay valid for a moment while the camera moves: redraw at most every SHADOW_EVERY_MS, and once more
// when the camera stops.
export const SHADOW_EVERY_MS = 66

export type ShadowDecision = 'redraw' | 'wait' | 'idle'

/**
 * @param changed  the camera (or the Sun, or the cascade ranges) changed since the last redraw
 * @param sinceMs  time since the last redraw
 * `wait` = changed but too soon: come back after the throttle (the caller schedules one timer).
 */
export function shadowDecision(changed: boolean, sinceMs: number, everyMs = SHADOW_EVERY_MS): ShadowDecision {
  if (!changed) return 'idle'
  return sinceMs >= everyMs ? 'redraw' : 'wait'
}

export const waitMs = (sinceMs: number, everyMs = SHADOW_EVERY_MS): number => Math.max(1, everyMs - sinceMs + 1)

/** The single 4096 px shadow map around the lander: redrawn when the drawn tile set changes, at most this often. */
export const TILE_SHADOW_EVERY_MS = 150
