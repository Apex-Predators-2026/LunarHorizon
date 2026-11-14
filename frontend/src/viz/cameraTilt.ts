// The top-down view toggle (map toolbar button, or the U key as in Google Earth): GlobeControls swings the
// camera to look straight down at the middle of the view, and back to the tilt it had. GlobeControls
// reports whether the view is top-down right now (also after a drag or a camera preset), so the button
// always shows the real state.
import { create } from 'zustand'

/** Views closer than this to straight down count as top-down (the button shows as on). */
export const TOP_DOWN_WITHIN_RAD = (3 * Math.PI) / 180

export const useCameraTilt = create<{ topDown: boolean; requests: number }>(() => ({ topDown: false, requests: 0 }))

/** Ask GlobeControls to switch between top-down and tilted. */
export const toggleTopDown = () => useCameraTilt.setState((s) => ({ requests: s.requests + 1 }))
