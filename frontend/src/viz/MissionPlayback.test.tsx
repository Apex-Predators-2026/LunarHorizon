// Tests for 3D mission playback headroom, samePlan requirements comparison, and PlansPanel headroom badges.
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In Node SSR tests (renderToString), Zustand reads getInitialState instead of updated store state;
// bridge selector reads to getState() so tests can exercise live store updates cleanly.
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

import { PlanCard, PlansPanel } from '../features/plans/PlansPanel'
import { usePlansStore, type Plan } from '../features/plans/usePlansStore'
import { useRescueStore } from '../features/rescue'
import type { RescueResponse } from '../features/rescue/types'
import { useAppStore } from '../store'
import { DEFAULT_REQUIREMENTS, type Scenario, type TimelineStep, type ViabilityResult } from '../types'
import { missionTrack } from './mission'
import { MissionPanel } from './MissionPlayback'
import { HOUR_MS, toIsoMinute } from './timeline'
import { samePlan, verdictFor, type MissionPlayback } from './useMissionPlayback'

const T0 = Date.UTC(2027, 3, 10, 0, 0, 0)

function makeSteps(hours: number, isDark: (h: number) => boolean, isBlackout: (h: number) => boolean): TimelineStep[] {
  return Array.from({ length: hours }, (_, i) => ({
    time_utc: toIsoMinute(T0 + i * HOUR_MS),
    sun: { azimuth_deg: 0, elevation_deg: 1, horizon_deg: 0, visible_fraction: isDark(i) ? 0 : 1 },
    earth: { azimuth_deg: 0, elevation_deg: 1, horizon_deg: 0, visible: !isBlackout(i), margin_deg: 1 },
  }))
}

const makeScenario = (darkMax = 48, extraName = 'Connecting Ridge'): Scenario => ({
  site: { id: 'connecting-ridge', name: extraName, lat: -89.5, lon: 222.5 },
  landing_utc: toIsoMinute(T0),
  duration_days: 7,
  requirements: {
    ...DEFAULT_REQUIREMENTS,
    battery_hours: darkMax,
    max_comms_gap_hours: 72,
    min_sunlight_fraction: 0.4,
    min_earth_visibility_fraction: 0.4,
    min_initial_sun_hours: 6,
    min_initial_comms_hours: 6,
  },
})

const makeViability = (scenario: Scenario, darkGap: number): ViabilityResult => ({
  scenario,
  passes: darkGap <= scenario.requirements.battery_hours,
  eligibility: darkGap <= scenario.requirements.battery_hours ? 'pass' : 'fail',
  score: 0.78,
  metrics: {
    sunlight_fraction: 0.72,
    equivalent_sun_hours: 120,
    longest_dark_gap_hours: darkGap,
    earth_visibility_fraction: 0.68,
    longest_comms_gap_hours: 12,
    initial_sun_hours: 24,
    initial_comms_hours: 18,
    hours_to_first_sunset: 24,
    hours_to_first_earthset: 18,
    mean_sun_clearance_deg: 0.8,
    mean_earth_clearance_deg: 1.5,
    mean_solar_elevation_deg: 0.4,
  },
  violations:
    darkGap > scenario.requirements.battery_hours
      ? [
          {
            constraint: 'battery_hours',
            required: scenario.requirements.battery_hours,
            actual: darkGap,
            unit: 'h',
            shortfall: darkGap - scenario.requirements.battery_hours,
            relative_shortfall: (darkGap - scenario.requirements.battery_hours) / scenario.requirements.battery_hours,
            message: 'Longest dark gap exceeds battery survival limit',
            is_unknown: false,
          },
        ]
      : [],
  headroom: undefined,
  source: 'viability',
  data_source: 'NASA LOLA/JPL Horizons',
})

beforeEach(() => {
  // React renderToString invokes Zustand's getServerSnapshot (getInitialState); mirror live store state for SSR tests.
  vi.spyOn(useAppStore, 'getInitialState').mockImplementation(() => useAppStore.getState())
  vi.spyOn(usePlansStore, 'getInitialState').mockImplementation(() => usePlansStore.getState())
  vi.spyOn(useRescueStore, 'getInitialState').mockImplementation(() => useRescueStore.getState())
  useRescueStore.setState({ original: null, selected: null, rescue: null, compromise: null })
  usePlansStore.setState({ plans: [], activeId: null, compareIds: [] })
  useAppStore.setState({ siteId: 'connecting-ridge', timeUtc: toIsoMinute(T0), playing: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('samePlan and verdictFor requirements regression', () => {
  it('treats plans with different battery_hours or requirement thresholds as different plans', () => {
    const planA = makeScenario(48)
    const planB = makeScenario(24)
    expect(samePlan(planA, planA)).toBe(true)
    expect(samePlan(planA, planB)).toBe(false)
    expect(
      samePlan(planA, {
        ...planA,
        requirements: { ...planA.requirements, min_sunlight_fraction: 0.65 },
      }),
    ).toBe(false)

    const verdictA = makeViability(planA, 36)
    const rescueStub = {
      status: 'still_viable',
      summary: 'ok',
      original: verdictA,
      changed: verdictA,
      alternatives: [],
      near_misses: [],
      loosening: [],
      stats: {
        candidates_evaluated: 1,
        locations_considered: 1,
        passing: 1,
        synthetic_candidates_excluded: 0,
        undecided: 0,
        date_range_start: toIsoMinute(T0),
        date_range_end: toIsoMinute(T0 + 168 * HOUR_MS),
      },
      data_source: 'NASA',
      assumptions: [],
    } satisfies RescueResponse

    // Exact match returns cached PASS verdict; changing battery_hours must NOT reuse stale PASS verdict.
    expect(verdictFor(planA, rescueStub, null)).toBe(verdictA)
    expect(verdictFor(planB, rescueStub, null)).toBeNull()
  })
})

describe('MissionPanel operational headroom', () => {
  const makePlayback = (plan: Scenario, track: ReturnType<typeof missionTrack>, verdict: ViabilityResult | null): MissionPlayback => ({
    available: true,
    reason: 'ok',
    run: { plan, track, error: null, acknowledged: 0 },
    start: () => {},
    stop: () => {},
    next: () => {},
    strip: null,
    verdict,
  })

  it('shows qualified Pass · limited darkness and PassHeadroom details when backend verdict is loaded', () => {
    const plan = makeScenario(48)
    // 169 steps (0..168h): initial sun 24h (sunset T+24), then 47h dark (47 <= 48h -> +1h limited), initial Earth 18h (Earthset T+18)
    const steps = makeSteps(
      169,
      (h) => h >= 24 && h < 71,
      (h) => h >= 18 && h < 30,
    )
    const track = missionTrack(steps, plan)
    useAppStore.setState({ timeUtc: toIsoMinute(T0 + 10 * HOUR_MS) })

    const limitedHtml = renderToString(<MissionPanel mission={makePlayback(plan, track, makeViability(plan, 47))} />)
    expect(limitedHtml).not.toContain('Viability engine: PASS')
    expect(limitedHtml).toContain('Pass · limited darkness')
    expect(limitedHtml).toContain('Darkness headroom')
    expect(limitedHtml).toContain('Closest requirement to limit')
    expect(limitedHtml).toContain('first sunset T+24 h')
    expect(limitedHtml).toContain('first Earthset T+18 h')
    expect(limitedHtml).toContain('Model screening result based on solar illumination')

    const comfortableHtml = renderToString(<MissionPanel mission={makePlayback(plan, track, makeViability(plan, 13))} />)
    expect(comfortableHtml).toContain('Pass · comfortable')
  })

  it('never manufactures a PASS or headroom from the observed track when the engine has not answered (verdict is null)', () => {
    const plan = makeScenario(48)
    const steps = makeSteps(
      169,
      (h) => h >= 24 && h < 71,
      (h) => h >= 18 && h < 30,
    )
    const track = missionTrack(steps, plan)
    useAppStore.setState({ timeUtc: toIsoMinute(track.end) })

    const html = renderToString(<MissionPanel mission={makePlayback(plan, track, null)} />)
    // Before: "Mission over: passes declared model limits" + "Pass · limited darkness" were derived on the client.
    expect(html).not.toContain('passes declared model limits')
    expect(html).not.toContain('Pass ·')
    expect(html).not.toContain('Darkness headroom')
    expect(html).toContain('Not assessed')
  })
})

describe('PlansPanel operational headroom badges', () => {
  it('distinguishes comfortable vs borderline PASS plans with PassHeadroomBadge and tightest margin', () => {
    const comfortablePlan: Plan = {
      id: 'p-comfort',
      name: 'Comfortable Ridge',
      scenario: makeScenario(48, 'Connecting Ridge'),
    }
    const limitedScenario = makeScenario(48, 'Peak Near Shackleton')
    limitedScenario.site.id = 'peak-near-shackleton'
    const limitedPlan: Plan = {
      id: 'p-limited',
      name: 'Borderline Peak',
      scenario: limitedScenario,
    }

    const comfortVerdict = makeViability(comfortablePlan.scenario, 13)
    const comfortHtml = renderToString(
      <ul>
        <PlanCard plan={comfortablePlan} verdict={comfortVerdict} onEdit={() => {}} onRun={() => {}} />
      </ul>,
    )
    expect(comfortHtml).toContain('Pass · comfortable')
    expect(comfortHtml).toContain('Screening only')

    // A plan with no engine verdict for this exact plan shows no PASS of its own (it used to derive "Pass · limited
    // darkness" from a timeline track, and "Pass · comfortable" from an empty one).
    const limitedHtml = renderToString(
      <ul>
        <PlanCard plan={limitedPlan} onEdit={() => {}} onRun={() => {}} />
      </ul>,
    )
    expect(limitedHtml).not.toContain('Pass ·')
    expect(limitedHtml).not.toContain('Screening only')
    expect(limitedHtml).toContain('plan-not-assessed')
  })

  it('renders cached rescue verdicts on PlansPanel cards from useRescueStore', () => {
    const sc = makeScenario(48, 'Connecting Ridge')
    const verdict = makeViability(sc, 47)
    usePlansStore.setState({
      plans: [{ id: 'p1', name: 'Tight Baseline', scenario: sc }],
      activeId: 'p1',
      compareIds: [],
    })
    useRescueStore.setState({
      rescue: {
        status: 'still_viable',
        summary: 'ok',
        original: verdict,
        changed: verdict,
        alternatives: [],
        near_misses: [],
        loosening: [],
        stats: {
          candidates_evaluated: 1,
          locations_considered: 1,
          passing: 1,
          synthetic_candidates_excluded: 0,
          undecided: 0,
          date_range_start: toIsoMinute(T0),
          date_range_end: toIsoMinute(T0 + 168 * HOUR_MS),
        },
        data_source: 'NASA',
        assumptions: [],
      },
    })
    const html = renderToString(<PlansPanel onCompare={() => {}} />)
    expect(html).toContain('Tight Baseline')
    expect(html).toContain('Pass · limited darkness')
    expect(html).toContain('limited · +1 h dark')
  })
})
