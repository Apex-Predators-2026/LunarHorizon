// GitHub Pages lets browsers cache the page for up to 10 minutes, so right after a deploy a visitor can get the
// previous version. The build writes version.json (see vite.config.ts); on start and whenever the tab becomes
// visible again, the app compares it with its own build id and reloads once if a newer build is published.

declare const __BUILD_ID__: string

const RELOADED_KEY = 'lunar-horizon.reloaded-for'

/** True when the published build differs from this one and the app hasn't already reloaded for it. */
export function shouldReload(publishedId: string | null | undefined, ownId: string, alreadyReloadedFor: string | null): boolean {
  return !!publishedId && publishedId !== ownId && alreadyReloadedFor !== publishedId
}

async function check() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return
    const { id } = (await res.json()) as { id?: string }
    let reloadedFor: string | null = null
    try {
      reloadedFor = sessionStorage.getItem(RELOADED_KEY)
    } catch {
      // storage blocked: the id check alone still avoids reloading for this build
    }
    if (!shouldReload(id, __BUILD_ID__, reloadedFor)) return
    try {
      sessionStorage.setItem(RELOADED_KEY, id!)
    } catch {
      return // can't remember the reload: don't risk a loop
    }
    window.location.reload()
  } catch {
    // offline or no version.json (dev server): keep the running version
  }
}

export function watchForNewBuild() {
  if (import.meta.env.DEV || typeof window === 'undefined') return
  void check()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
}
