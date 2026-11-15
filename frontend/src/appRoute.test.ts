import { afterEach, describe, expect, it, vi } from 'vitest'
import { goToView, parseRoute, rememberSection, routeHash } from './appRoute'

describe('app routes (URL hash)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads every page and view', () => {
    expect(parseRoute('')).toEqual({ page: 'landing' })
    expect(parseRoute('#')).toEqual({ page: 'landing' })
    expect(parseRoute('#mango')).toEqual({ page: 'mango' })
    expect(parseRoute('#app')).toEqual({ page: 'app', view: 'planner', section: null }) // older links
    expect(parseRoute('#app/planner')).toEqual({ page: 'app', view: 'planner', section: null })
    expect(parseRoute('#app/compare')).toEqual({ page: 'app', view: 'compare', section: null })
    expect(parseRoute('#app/compare/cmp-metrics')).toEqual({ page: 'app', view: 'compare', section: 'cmp-metrics' })
    expect(parseRoute('#app/nonsense')).toEqual({ page: 'app', view: 'planner', section: null })
  })

  it('a comparison section link is the comparison, not the landing page (the bug)', () => {
    expect(parseRoute('#cmp-timeline')).toEqual({ page: 'app', view: 'compare', section: 'cmp-timeline' })
  })

  it('round-trips', () => {
    for (const [view, section] of [['planner', null], ['compare', null], ['compare', 'cmp-summary']] as const) {
      const r = parseRoute(routeHash(view, section))
      expect(r).toEqual({ page: 'app', view, section })
    }
  })

  it('switching view adds a history entry; remembering a section does not', () => {
    // A minimal browser history (the tests run without a DOM).
    const entries = ['/#app/planner']
    const location = {
      pathname: '/',
      search: '',
      get hash() {
        return entries[entries.length - 1].slice(1)
      },
      set hash(h: string) {
        entries.push(`/#${h.replace(/^#/, '')}`)
      },
    }
    const history = { state: null, replaceState: (_s: unknown, _t: string, url: string) => (entries[entries.length - 1] = url) }
    vi.stubGlobal('window', { location, history })
    goToView('compare')
    expect(location.hash).toBe('#app/compare')
    expect(entries).toHaveLength(2)
    goToView('compare') // already there: no new entry
    expect(entries).toHaveLength(2)
    rememberSection('cmp-metrics')
    expect(location.hash).toBe('#app/compare/cmp-metrics')
    expect(entries).toHaveLength(2)
    goToView('planner')
    expect(entries).toEqual(['/#app/planner', '/#app/compare/cmp-metrics', '/#app/planner'])
  })
})
