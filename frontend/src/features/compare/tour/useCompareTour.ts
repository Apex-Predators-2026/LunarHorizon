// State of the Scenario Comparison tour. Completion / dismissal is remembered in localStorage so the offer is not
// shown on every visit; the tour itself can always be restarted from the "How to compare missions" button.
import { create } from 'zustand'

export const COMPARE_TOUR_KEY = 'lunar-compare-tour'

interface Prefs {
  completed: boolean
  dismissed: boolean
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

export function readTourPrefs(s: Pick<Storage, 'getItem'> | null = storage()): Prefs {
  try {
    const raw = s?.getItem(COMPARE_TOUR_KEY)
    const p = raw ? (JSON.parse(raw) as Partial<Prefs>) : {}
    return { completed: Boolean(p.completed), dismissed: Boolean(p.dismissed) }
  } catch {
    return { completed: false, dismissed: false }
  }
}

function writeTourPrefs(p: Prefs) {
  try {
    storage()?.setItem(COMPARE_TOUR_KEY, JSON.stringify(p))
  } catch {
    // private mode / full storage: the tour still works for this visit
  }
}

export interface CompareTourState {
  open: boolean
  index: number // position within the steps that are available on the page right now
  completed: boolean
  dismissed: boolean
  start: () => void
  next: (available: number) => void
  back: () => void
  skip: () => void
  finish: () => void
  dismissOffer: () => void
}

const initial = readTourPrefs()

export const useCompareTour = create<CompareTourState>((set, get) => ({
  open: false,
  index: 0,
  completed: initial.completed,
  dismissed: initial.dismissed,
  start: () => set({ open: true, index: 0 }),
  next: (available) => {
    const { index } = get()
    if (index + 1 >= available) get().finish()
    else set({ index: index + 1 })
  },
  back: () => set({ index: Math.max(0, get().index - 1) }),
  // Skipping counts as "seen": the offer does not come back, the button still restarts the tour.
  skip: () => {
    set({ open: false, dismissed: true })
    writeTourPrefs({ completed: get().completed, dismissed: true })
  },
  finish: () => {
    set({ open: false, completed: true, dismissed: true })
    writeTourPrefs({ completed: true, dismissed: true })
  },
  dismissOffer: () => {
    set({ dismissed: true })
    writeTourPrefs({ completed: get().completed, dismissed: true })
  },
}))
