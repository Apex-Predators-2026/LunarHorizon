// Which main view the guided mission is on. The URL hash stays the source of truth (appRoute.ts: Back / Forward and
// refresh keep the view); this small store mirrors it so the story's non-React code and its card can read and change
// the view. It listens to `hashchange` itself, so App.tsx needs no extra wiring.
import { create } from 'zustand'

import { goToView, parseRoute, type AppView } from '../../appRoute'

export type View = AppView

/** The app view in the URL right now; 'planner' when the landing page (or no DOM) is showing. */
export function currentView(): View {
  if (typeof window === 'undefined') return 'planner'
  const r = parseRoute(window.location.hash)
  return r.page === 'app' ? r.view : 'planner'
}

export const useNav = create<{ view: View; setView: (v: View) => void }>((set) => ({
  view: currentView(),
  setView: (view) => {
    set({ view })
    if (typeof window !== 'undefined') goToView(view) // pushes a history entry; a no-op when already shown (and without a DOM)
  },
}))

/** Move the user to a view (also leaves the landing page). */
export const goTo = (v: View) => useNav.getState().setView(v)

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const v = currentView()
    if (useNav.getState().view !== v) useNav.setState({ view: v })
  })
}
