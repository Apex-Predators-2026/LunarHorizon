// Phase 6: requirement evidence on the timeline, and Mission Rescue -> comparison.
import { describe, expect, it } from 'vitest'

import rescueFixture from '../rescue/__fixtures__/rescue-response.json'
import type { RescueResponse } from '../rescue/types'
import fixture from './__fixtures__/compare-response.json'
import { violationWindows, type Entry } from './analysis'
import { describeChange, rescueImportPlan, rescueSteps, type RescueContext } from './rescueFlow'
import { makeScenario } from './scenario'
import type { CompareResponse, CompareResult, RankingInfo } from './types'

const res = fixture as unknown as CompareResponse
const rescue = rescueFixture as unknown as RescueResponse
const byKey = Object.fromEntries(res.results.map((r) => [r.key, r])) as Record<string, CompareResult>
const SITE = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }

function entry(key: string, label = key): Entry {
  const r = byKey[key]
  const scenario = { ...makeScenario({ site: SITE, landing_utc: '2027-01-15T00:00:00Z' }, []), label, id: `s-${label}` }
  return { scenario, state: { state: 'done', result: r }, result: r.status === 'ok' ? r : null, offsetHours: 0, ranking: r.ranking }
}

/** The same scenario with one requirement's verdict changed (its evidence window kept). */
function withVerdict(e: Entry, constraintId: string, status: 'fail' | 'unknown', eligibility: RankingInfo['eligibility'], label: string): Entry {
  const a = e.result!.assessment!
  const constraints = a.constraints.map((c) => (c.id === constraintId ? { ...c, status } : c))
  const ranking = { ...e.ranking!, eligibility, rank: null }
  const result = { ...e.result!, key: label, ranking, assessment: { ...a, constraints } }
  return { ...e, scenario: { ...e.scenario, id: `s-${label}`, label }, result, state: { state: 'done', result }, ranking }
}

describe('requirement evidence on the timeline', () => {
  it('passed requirements are not drawn as violations', () => {
    expect(violationWindows(entry('B').result)).toEqual([])
  })

  it('a failed requirement shows the window the engine cites, on the right lane', () => {
    const e = withVerdict(entry('A'), 'max_continuous_darkness', 'fail', 'fail', 'X')
    const cited = e.result!.assessment!.constraints.find((c) => c.id === 'max_continuous_darkness')!.evidence_windows[0]
    const [v] = violationWindows(e.result)
    expect(v.status).toBe('fail')
    expect(v.lane).toBe('sun')
    expect([v.start_hour, v.end_hour]).toEqual([cited.start_hour, cited.end_hour])
    expect(v.text).toMatch(/^Fails Maximum continuous power-darkness: .* power dark window.*\(required ≤ 100 h/)
  })

  it('an undecided requirement is marked as undecided, not failed', () => {
    const e = withVerdict(entry('A'), 'min_initial_earth_visibility', 'unknown', 'unknown', 'Y')
    const [v] = violationWindows(e.result)
    expect(v.status).toBe('unknown')
    expect(v.lane).toBe('earth')
    expect(v.text).toMatch(/^Cannot decide/)
  })
})

describe('Mission Rescue import', () => {
  it('imports the original plan, the changed plan and the top alternatives, up to four', () => {
    const plan = rescueImportPlan(rescue)
    expect(plan.includesOriginal).toBe(true) // the delay produced a different plan
    expect(plan.roles.map((r) => r.role)).toEqual(['original', 'changed', 'alternative', 'alternative'])
    expect(plan.scenarios[0]).toEqual(rescue.original.scenario)
    expect(plan.scenarios[1]).toEqual(rescue.changed.scenario)
    expect(plan.roles[1].rescueVerdict).toBe('fail')
    expect(plan.roles[2]).toMatchObject({ rank: 1, kind: rescue.alternatives[0].kind, headline: rescue.alternatives[0].headline })
    expect(plan.names[2]).toMatch(/^Rescue #1/)
  })

  it('leaves the original out when the change did not alter the plan', () => {
    const same = { ...rescue, changed: { ...rescue.changed, scenario: rescue.original.scenario } }
    const plan = rescueImportPlan(same)
    expect(plan.includesOriginal).toBe(false)
    expect(plan.roles[0].role).toBe('changed')
    expect(plan.scenarios).toHaveLength(Math.min(4, 1 + rescue.alternatives.length))
  })

  it('describes what changed in plain language', () => {
    expect(describeChange({ launch_delay_days: 14, reason: 'Slip' })).toEqual(['Launch delayed by 14 days', 'Reason: Slip'])
    expect(describeChange({ requirement_overrides: { battery_hours: 60 } })[0]).toMatch(/battery hours = 60/)
    expect(describeChange({})).toEqual(['No change entered: Rescue checked the current plan as it is'])
  })
})

describe('rescue story', () => {
  const ctxFor = (roles: RescueContext['roles']): RescueContext =>
    ({ importedAt: '2027-01-01T00:00:00Z', status: 'rescued', summary: '', change: ['Launch delayed by 10 days'], roles })

  it('calls an alternative a fix only when it passes here, and names what it fixes', () => {
    const changed = entry('A') // fails mean visible solar disk
    const fix = entry('B') // passes, same group
    const ctx = ctxFor({ [changed.scenario.id]: { role: 'changed', rescueVerdict: 'fail' }, [fix.scenario.id]: { role: 'alternative', rank: 1, rescueVerdict: 'pass' } })
    const s = rescueSteps(ctx, [changed, fix])
    expect(s.changedProblems!.failed).toEqual(['Minimum mean visible solar-disk fraction'])
    const [alt] = s.alternatives
    expect(alt.outcome).toBe('confirmed')
    expect(alt.fixes).toEqual(['Minimum mean visible solar-disk fraction'])
    expect(alt.disagreesWithRescue).toBe(false)
  })

  it('an undecided alternative is a potential option, not a confirmed fix', () => {
    const changed = entry('A')
    const maybe = withVerdict(entry('C'), 'min_initial_earth_visibility', 'unknown', 'unknown', 'M')
    const s = rescueSteps(ctxFor({ [changed.scenario.id]: { role: 'changed' }, [maybe.scenario.id]: { role: 'alternative', rank: 1, rescueVerdict: 'pass' } }), [changed, maybe])
    expect(s.alternatives[0].outcome).toBe('undecided')
    expect(s.alternatives[0].disagreesWithRescue).toBe(true) // Rescue said pass; the re-assessment cannot decide
    expect(s.alternatives[0].remaining).toEqual(['Minimum continuous Earth line of sight after landing'])
  })

  it('an alternative that still fails is not a fix, and a pass in another group is flagged as not comparable', () => {
    const changed = entry('C')
    const fails = entry('A')
    const other = entry('E') // passes, but 3-day mission: separate group
    const s = rescueSteps(ctxFor({
      [changed.scenario.id]: { role: 'changed' },
      [fails.scenario.id]: { role: 'alternative', rank: 1 },
      [other.scenario.id]: { role: 'alternative', rank: 2 },
    }), [changed, fails, other])
    expect(s.alternatives.map((a) => a.outcome)).toEqual(['still_fails', 'passes_separately'])
  })
})
