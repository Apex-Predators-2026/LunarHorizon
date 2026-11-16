import { create } from 'zustand'

const DARK_KEY = 'lunar-dark-mode'
const ANNOUNCE_MS = 1100 // how long the "press Esc" notice shows before the interface disappears

const readDark = () => {
  try {
    return localStorage.getItem(DARK_KEY) === '1'
  } catch {
    return false
  }
}

interface UiPrefs {
  dark: boolean
  uiHidden: boolean // the interface is hidden (Esc brings it back)
  notice: boolean // show the "UI hidden, press Esc" notice
  setDark: (v: boolean) => void
  hideUi: () => void
  showUi: () => void
}

let timers: number[] = []
const clearTimers = () => {
  timers.forEach((t) => window.clearTimeout(t))
  timers = []
}

export const useUiPrefs = create<UiPrefs>((set) => ({
  dark: readDark(),
  uiHidden: false,
  notice: false,
  setDark: (dark) => {
    try {
      localStorage.setItem(DARK_KEY, dark ? '1' : '0')
    } catch {
      /* storage unavailable: the setting just lasts for this visit */
    }
    set({ dark })
  },
  // Tell the user how to get back first, then hide.
  hideUi: () => {
    clearTimers()
    set({ notice: true })
    timers.push(window.setTimeout(() => set({ uiHidden: true, notice: false }), ANNOUNCE_MS))
  },
  showUi: () => {
    clearTimers()
    set({ uiHidden: false, notice: false })
  },
}))
