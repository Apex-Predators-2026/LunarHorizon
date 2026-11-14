import { describe, expect, it } from 'vitest'
import { advanceLoad, HIDE_AFTER_IDLE_MS, initialLoad, loadingBarUp, MIN_SHOWN_MS, SLOW_TILE_MS, type TerrainLoad } from './terrainLoad'

const load = (o: Partial<TerrainLoad>): TerrainLoad => ({ ...initialLoad, drawn: 10, ...o })

describe('terrain loading state', () => {
  it('records when loading went idle, and returns the same state when nothing changed', () => {
    const busy = advanceLoad(initialLoad, { drawn: 5, pending: 3, finished: 1, waitingSince: 100 }, 200)
    expect(busy.idleSince).toBeNull()
    const idle = advanceLoad(busy, { drawn: 5, pending: 0, finished: 4, waitingSince: null }, 300)
    expect(idle.idleSince).toBe(300)
    expect(advanceLoad(idle, { drawn: 5, pending: 0, finished: 4, waitingSince: null }, 400)).toBe(idle) // no re-render
  })
})

describe('the "Loading terrain" bar', () => {
  it('stays quiet while tiles answer quickly (zooming over cached terrain)', () => {
    expect(loadingBarUp(load({ pending: 40, waitingSince: 1000 }), null, 1000 + SLOW_TILE_MS - 1)).toBe(false)
  })

  it('appears once a request has waited a while (slow data)', () => {
    expect(loadingBarUp(load({ pending: 3, waitingSince: 1000 }), null, 1000 + SLOW_TILE_MS)).toBe(true)
  })

  it('stays up while loading continues, even if each request is quick by then', () => {
    expect(loadingBarUp(load({ pending: 5, waitingSince: 9990 }), 1000, 10_000)).toBe(true)
  })

  it('never flashes: shown at least MIN_SHOWN_MS, hidden only after a settled idle', () => {
    const idle = load({ pending: 0, idleSince: 1100 })
    expect(loadingBarUp(idle, 1000, 1000 + MIN_SHOWN_MS - 1)).toBe(true)
    const idleLong = load({ pending: 0, idleSince: 5000 })
    expect(loadingBarUp(idleLong, 1000, 5000 + HIDE_AFTER_IDLE_MS - 1)).toBe(true) // a pause between zoom steps
    expect(loadingBarUp(idleLong, 1000, 5000 + HIDE_AFTER_IDLE_MS)).toBe(false)
  })

  it('leaves the first load to the "Loading the Moon" message', () => {
    expect(loadingBarUp(load({ drawn: 0, pending: 6, waitingSince: 0 }), null, 5000)).toBe(false)
  })
})
