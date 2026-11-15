// The time strip explains an all-dark window: shadow is a result, not missing data.
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// renderToString reads Zustand's initial state; bridge selector reads to getState() (same shim as MissionPlayback.test).
vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand')>()
  type StoreFn = ((selector?: (s: unknown) => unknown) => unknown) & { getState: () => unknown }
  const makeBound = (fn: unknown) => {
    const useBound = (actual.create as unknown as (f: unknown) => StoreFn)(fn)
    const hook = (selector?: (s: unknown) => unknown) => (selector ? selector(useBound.getState()) : useBound.getState())
    return Object.assign(hook, useBound)
  }
  return {
    ...actual,
    create: ((initializer?: unknown) =>
      typeof initializer === 'function' ? makeBound(initializer) : makeBound) as unknown as typeof actual.create,
  }
})

import type { SiteInfo, TimelineStep } from '../types'
import { TimeBar } from './TimeBar'
import { HOUR_MS, toIsoMinute } from './timeline'

const T0 = Date.UTC(2027, 0, 1)

function steps(n: number, sun: (i: number) => number | null): TimelineStep[] {
  return Array.from({ length: n }, (_, i) => {
    const f = sun(i)
    return {
      time_utc: toIsoMinute(T0 + i * HOUR_MS),
      sun: { azimuth_deg: 0, elevation_deg: 1, horizon_deg: 0, visible_fraction: f, visible: f === null ? null : f > 0 },
      earth: { azimuth_deg: 0, elevation_deg: 1, horizon_deg: 0, visible: true, margin_deg: 1 },
    } as TimelineStep
  })
}

function render(s: TimelineStep[]) {
  const site = {
    id: 'test', name: 'Test', kind: 'artemis', lat: -89.5, lon: 0, ground_height_m: 0, observer_height_m: 2,
    data_start_utc: toIsoMinute(T0), data_stop_utc: toIsoMinute(T0 + 400 * HOUR_MS),
  } as unknown as SiteInfo
  return renderToString(
    <TimeBar site={site} steps={s} win={[T0, T0 + s.length * HOUR_MS]} windowDays={7} onWindowDays={() => {}} loading={false} />,
  )
}

describe('TimeBar no-sunlight note', () => {
  it('explains a window with no lit hour as shadow, not missing data', () => {
    expect(render(steps(48, () => 0))).toContain('no-sunlight-note')
  })
  it('is absent when any hour is lit', () => {
    expect(render(steps(48, (i) => (i === 10 ? 1 : 0)))).not.toContain('no-sunlight-note')
  })
  it('is absent when the sun is unknown everywhere (unknown is not darkness)', () => {
    expect(render(steps(48, () => null))).not.toContain('no-sunlight-note')
  })
})
