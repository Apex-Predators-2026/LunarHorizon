import { create } from 'zustand'

import { TUTORIAL_STEPS, actStart, type TourAct, type TutorialActionKey } from './steps'

export const TUTORIAL_STORAGE_KEY = 'lunar-tutorial-prefs'

export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem?: (key: string) => void
}

interface StoredPrefs {
  dontShowAgain: boolean
  completed: boolean
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

let activeStorage: StorageLike | null = defaultStorage()
let advanceTimer: ReturnType<typeof setTimeout> | null = null

function clearAdvanceTimer() {
  if (advanceTimer !== null) {
    clearTimeout(advanceTimer)
    advanceTimer = null
  }
}

function readPrefs(storage: StorageLike | null): StoredPrefs {
  if (!storage) return { dontShowAgain: false, completed: false }
  try {
    const raw = storage.getItem(TUTORIAL_STORAGE_KEY)
    if (!raw) return { dontShowAgain: false, completed: false }
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>
    return {
      dontShowAgain: Boolean(parsed.dontShowAgain),
      completed: Boolean(parsed.completed),
    }
  } catch {
    return { dontShowAgain: false, completed: false }
  }
}

function writePrefs(storage: StorageLike | null, prefs: StoredPrefs) {
  if (!storage) return
  try {
    storage.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Private browsing or storage quota full: tutorial stays functional in memory.
  }
}

export interface TutorialState {
  open: boolean
  stepIndex: number
  actionDone: boolean
  offerDismissed: boolean
  dontShowAgain: boolean
  completed: boolean
  /** Incremented whenever a step needs UI prep synced into Scene/App/MiniMap/Sidebar. */
  prepNonce: number
  /** True while the current step is still working (e.g. a story stage); blocks Next/ArrowRight. Reset on every step change. */
  nextBlocked: boolean
  startTour: (startIndex?: number) => void
  nextStep: () => void
  prevStep: () => void
  goToStep: (index: number) => void
  /** Jumps to the first step of the given act. */
  goToAct: (act: TourAct) => void
  setNextBlocked: (blocked: boolean) => void
  skipTour: () => void
  dismissOffer: (persistDontShow?: boolean) => void
  recordInteraction: (action: TutorialActionKey) => void
  resetProgress: () => void
}

const initialPrefs = readPrefs(activeStorage)

export const useTutorialStore = create<TutorialState>((set, get) => ({
  open: false,
  stepIndex: 0,
  actionDone: false,
  offerDismissed: initialPrefs.dontShowAgain || initialPrefs.completed,
  dontShowAgain: initialPrefs.dontShowAgain,
  completed: initialPrefs.completed,
  prepNonce: 0,
  nextBlocked: false,

  startTour: (startIndex = 0) => {
    clearAdvanceTimer()
    const clamped = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, startIndex))
    set((s) => ({
      open: true,
      stepIndex: clamped,
      actionDone: false,
      nextBlocked: false,
      offerDismissed: true,
      prepNonce: s.prepNonce + 1,
    }))
  },

  nextStep: () => {
    clearAdvanceTimer()
    const { stepIndex, dontShowAgain } = get()
    if (stepIndex >= TUTORIAL_STEPS.length - 1) {
      writePrefs(activeStorage, { dontShowAgain, completed: true })
      set({
        open: false,
        stepIndex: 0,
        actionDone: false,
        nextBlocked: false,
        completed: true,
        offerDismissed: true,
      })
      return
    }
    set((s) => ({
      stepIndex: s.stepIndex + 1,
      actionDone: false,
      nextBlocked: false,
      prepNonce: s.prepNonce + 1,
    }))
  },

  prevStep: () => {
    clearAdvanceTimer()
    set((s) => ({
      stepIndex: Math.max(0, s.stepIndex - 1),
      actionDone: false,
      nextBlocked: false,
      prepNonce: s.prepNonce + 1,
    }))
  },

  goToStep: (index: number) => {
    clearAdvanceTimer()
    const clamped = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, index))
    set((s) => ({
      stepIndex: clamped,
      actionDone: false,
      nextBlocked: false,
      prepNonce: s.prepNonce + 1,
    }))
  },

  goToAct: (act: TourAct) => {
    get().goToStep(actStart(act))
  },

  setNextBlocked: (blocked: boolean) => {
    if (get().nextBlocked !== blocked) set({ nextBlocked: blocked })
  },

  skipTour: () => {
    clearAdvanceTimer()
    set({
      open: false,
      actionDone: false,
      nextBlocked: false,
      offerDismissed: true,
    })
  },

  dismissOffer: (persistDontShow = false) => {
    const nextDontShow = persistDontShow || get().dontShowAgain
    if (persistDontShow) {
      writePrefs(activeStorage, { dontShowAgain: true, completed: get().completed })
    }
    set({
      offerDismissed: true,
      dontShowAgain: nextDontShow,
    })
  },

  recordInteraction: (action: TutorialActionKey) => {
    const state = get()
    if (!state.open || state.actionDone) return
    const currentStep = TUTORIAL_STEPS[state.stepIndex]
    if (!currentStep || !currentStep.triggers.includes(action)) return

    set({ actionDone: true })
    clearAdvanceTimer()
    const stepAtTrigger = state.stepIndex
    if (stepAtTrigger >= TUTORIAL_STEPS.length - 1) {
      // Keep the final step open so the user can inspect Scenario Comparison / Plans and click Finish intentionally.
      return
    }
    advanceTimer = setTimeout(() => {
      advanceTimer = null
      const latest = get()
      if (latest.open && latest.stepIndex === stepAtTrigger) {
        latest.nextStep()
      }
    }, 850)
  },

  resetProgress: () => {
    clearAdvanceTimer()
    writePrefs(activeStorage, { dontShowAgain: false, completed: false })
    set({
      open: false,
      stepIndex: 0,
      actionDone: false,
      nextBlocked: false,
      offerDismissed: false,
      dontShowAgain: false,
      completed: false,
    })
  },
}))

/** Launches the Guided Tour automatically when `?tour=1` (or `?tour=true`) is present in search or hash query. */
export function initTutorialFromSearch(search?: string, hash?: string): boolean {
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '')
  const rawHash = hash ?? (typeof window !== 'undefined' ? window.location.hash : '')
  const hashQuery = rawHash.includes('?') ? rawHash.slice(rawHash.indexOf('?')) : ''

  for (const q of [query, hashQuery]) {
    if (!q) continue
    const params = new URLSearchParams(q)
    const raw = params.get('tour')
    if (raw === '1' || raw === 'true') {
      useTutorialStore.getState().startTour(0)
      return true
    }
  }
  return false
}

/** Test-only helper to swap storage backend and hydrate clean initial state. */
export function resetTutorialStoreForTests(storage?: StorageLike | null) {
  clearAdvanceTimer()
  activeStorage = storage === undefined ? defaultStorage() : storage
  const prefs = readPrefs(activeStorage)
  useTutorialStore.setState({
    open: false,
    stepIndex: 0,
    actionDone: false,
    offerDismissed: prefs.dontShowAgain || prefs.completed,
    dontShowAgain: prefs.dontShowAgain,
    completed: prefs.completed,
    prepNonce: 0,
    nextBlocked: false,
  })
}
