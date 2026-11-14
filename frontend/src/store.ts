import { create } from 'zustand'

// Shared app state every member's components can read.
interface AppState {
  siteId: string | null
  timeUtc: string
  playing: boolean
  setSite: (id: string | null) => void
  setTime: (t: string) => void
  setPlaying: (p: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  siteId: null,
  timeUtc: new Date().toISOString(),
  playing: false,
  setSite: (siteId) => set({ siteId }),
  setTime: (timeUtc) => set({ timeUtc }),
  setPlaying: (playing) => set({ playing }),
}))
