import { create } from 'zustand'

export type SnackbarTone = 'info' | 'success' | 'error'

export interface SnackbarMessage {
  id: number
  text: string
  tone: SnackbarTone
}

interface SnackbarState {
  queue: SnackbarMessage[] // first = showing now (M3: one snackbar at a time, the rest wait)
  push: (text: string, tone?: SnackbarTone) => void
  shift: () => void
}

let nextId = 1

export const useSnackbarStore = create<SnackbarState>((set) => ({
  queue: [],
  push: (text, tone = 'info') =>
    set((s) => {
      // A repeat of what is already waiting/showing is dropped; a newer message replaces a pending one of the same kind.
      if (s.queue.some((m) => m.text === text)) return s
      return { queue: [...s.queue, { id: nextId++, text, tone }].slice(-4) }
    }),
  shift: () => set((s) => ({ queue: s.queue.slice(1) })),
}))

/** Show a snackbar from anywhere (components or callbacks). */
export const showSnackbar = (text: string, tone: SnackbarTone = 'info') => useSnackbarStore.getState().push(text, tone)
