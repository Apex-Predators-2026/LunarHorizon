// Routes, in the URL hash so the static build needs no server routing:
//   (none) / #        the landing page
//   #app/planner      Mission Planner (the 3D navigator); plain #app (older links, the demo tour) too
//   #app/compare      Scenario Comparison, optionally with a section: #app/compare/cmp-metrics
//   #app/atlas        Feasibility Atlas (landing dates x mission durations)
// Switching views pushes a history entry (Back / Forward move between them, refresh keeps the view);
// jumping to a comparison section only replaces the entry (no Back step per click, refresh keeps it).

export type AppView = 'planner' | 'compare' | 'atlas'

export type Route =
  | { page: 'landing' }
  | { page: 'mango' }
  | { page: 'glass' }
  | { page: 'app'; view: AppView; section: string | null }

const SECTION = /^cmp-[a-z0-9-]+$/

export function parseRoute(hash: string): Route {
  if (hash === '#mango') return { page: 'mango' }
  if (hash === '#glass') return { page: 'glass' }
  // A comparison section on its own (links from before these routes existed).
  if (SECTION.test(hash.slice(1))) return { page: 'app', view: 'compare', section: hash.slice(1) }
  const [root, view, section] = hash.slice(1).split('/')
  if (root !== 'app') return { page: 'landing' }
  if (view === 'compare') return { page: 'app', view: 'compare', section: section && SECTION.test(section) ? section : null }
  if (view === 'atlas') return { page: 'app', view: 'atlas', section: null }
  return { page: 'app', view: 'planner', section: null }
}

export function routeHash(view: AppView, section?: string | null): string {
  if (view === 'compare') return `#app/compare${section ? `/${section}` : ''}`
  return view === 'atlas' ? '#app/atlas' : '#app/planner'
}

/** Switch view (a new history entry); nothing happens if it is the view already shown. */
export function goToView(view: AppView) {
  const now = parseRoute(window.location.hash)
  if (now.page === 'app' && now.view === view) return
  window.location.hash = routeHash(view)
}

/** Remember the comparison section in the URL without a history step or a hashchange. */
export function rememberSection(section: string | null) {
  const url = `${window.location.pathname}${window.location.search}${routeHash('compare', section)}`
  window.history.replaceState(window.history.state, '', url)
}
