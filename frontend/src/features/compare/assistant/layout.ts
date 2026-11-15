// Layout of the Mission Assistant panel: docked on the side (resizable), full screen, or minimized to a slim dock
// with Rover standing beside it. The size you drag it to is remembered; the layout itself starts on the side.
import { create } from 'zustand'

export type AssistantLayout = 'side' | 'full' | 'min'

export const SIDE_MIN_W = 340
export const SIDE_MIN_H = 360
export const SIDE_DEFAULT_W = 400
const KEY = 'lunar-assistant-size'

function readSize(): { w: number; h: number | null } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { w?: number; h?: number | null } | null
    if (v && typeof v.w === 'number') return { w: v.w, h: typeof v.h === 'number' ? v.h : null }
  } catch {
    /* no storage: use the default */
  }
  return { w: SIDE_DEFAULT_W, h: null }
}

interface LayoutState {
  layout: AssistantLayout
  w: number // width of the side panel (px)
  h: number | null // height of the side panel; null = as tall as the space allows
  setLayout: (l: AssistantLayout) => void
  setSize: (w: number, h: number | null) => void
}

export const useAssistantLayout = create<LayoutState>((set) => ({
  layout: 'side',
  ...readSize(),
  setLayout: (layout) => set({ layout }),
  setSize: (w, h) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ w, h }))
    } catch {
      /* ignore */
    }
    set({ w, h })
  },
}))
