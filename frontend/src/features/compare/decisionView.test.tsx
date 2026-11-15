// First-screen decision of the comparison over the real fixture (canonical engine, 7-day missions from 2027-01-15):
// A Peak Near Shackleton FAIL · B Malapert PASS #1 · C Connecting Ridge PASS #2 · D no data · E Malapert 3-day
// PASS in separate group G2. Other states are built from these with only the verdict or evidence changed.
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import fixture from './__fixtures__/compare-response.json'
import { type Entry } from './analysis'
import { buildDecision } from './decision'
import { DecisionOverview } from './DecisionOverview'
import { comparability, decisiveCell, DECISIVE_ROWS, deltaText, keyConstraint, overallState, preferenceStrength, rankLine, rolesOf } from './decisionView'
import { makeScenario } from './scenario'
import type { CompareResponse, CompareResult, PairEvidence, RankingGroup, RankingInfo } from './types'
import { useCompareStore } from './useCompareStore'

const res = fixture as unknown as CompareResponse
const byKey = Object.fromEntries(res.results.map((r) => [r.key, r])) as Record<string, CompareResult>
const SITE = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }
const plain = (h: string) => h.replace(/<!-- -->/g, '')

function entry(key: string, over: Partial<Entry['scenario']> = {}): Entry {
  const r = byKey[key]
  const scenario = { ...makeScenario({ site: SITE, landing_utc: '2027-01-15T00:00:00Z' }, []), label: key, id: `s-${key}`, ...over }
  return { scenario, state: { state: 'done', result: r }, result: r.status === 'ok' ? r : null, offsetHours: 0, ranking: r.ranking }
}

function as(e: Entry, eligibility: RankingInfo['eligibility'], key: string, rank: number | null = null): Entry {
  const a = e.result!.assessment!
  const constraints = a.constraints.map((c, i) =>
    eligibility === 'pass' ? (c.status === 'not_applicable' ? c : { ...c, status: 'pass' as const })
      : i === 0 ? { ...c, status: eligibility === 'fail' ? ('fail' as const) : ('unknown' as const) } : c)
  const ranking: RankingInfo = { ...e.ranking!, eligibility, rank, group: 'G1', score: eligibility === 'unknown' ? null : e.ranking!.score,
    score_status: eligibility === 'unknown' ? 'eligibility_unknown' : e.ranking!.score_status }
  const result = { ...e.result!, key, ranking, assessment: { ...a, constraints } }
  return { ...e, scenario: { ...e.scenario, id: `s-${key}`, label: key }, result, state: { state: 'done', result }, ranking }
}

const group = (keys: string[], ranked: string[], id = 'G1', primary = true): RankingGroup =>
  ({ id, primary, keys, ranked_keys: ranked, data_basis: 'real_terrain_aware', policy: 'strict', method_version: 'm', separate_reason: null })
const G1 = res.ranking_groups.filter((g) => g.id === 'G1')

beforeEach(() => useCompareStore.setState({ baselineId: null, rescueContext: null }))

describe('decision state of the selection', () => {
  it('nothing is decided while any plan is loading or the ranking is stale', () => {
    const e = ['A', 'B', 'C'].map((k) => entry(k))
    expect(overallState(e, G1, res.pairwise, false).kind).toBe('loading')
    expect(overallState([{ ...e[0], state: { state: 'loading' }, result: null, ranking: null }, e[1]], G1, res.pairwise, true).kind).toBe('loading')
    expect(overallState([], [], [], true).kind).toBe('empty')
    const html = plain(renderToString(<DecisionOverview entries={e} groups={G1} pairs={res.pairwise} rankingCurrent={false} notes={[]} />))
    expect(html).toContain('No recommendation is shown until every plan has a current result')
    expect(html).not.toContain('Recommended')
  })

  it('backend down for every plan: an error, not a decision', () => {
    const e = ['A', 'B'].map((k) => ({ ...entry(k), state: { state: 'error' as const, message: 'Backend unavailable (fetch)' }, result: null, ranking: null }))
    const st = overallState(e, [], [], false)
    expect(st).toEqual({ kind: 'error', message: 'Backend unavailable (fetch)' })
  })

  it('mixed PASS / FAIL / UNKNOWN with an established score lead: recommended, with roles in the wording', () => {
    const e = ['A', 'B', 'C', 'D'].map((k) => entry(k))
    const d = buildDecision(e, G1, res.pairwise).groups[0]
    expect(d.kind).toBe('recommended')
    expect(preferenceStrength(d, res.pairwise)).toBe('established')
    // Server rendering reads the store's initial state.
    Object.assign(useCompareStore.getInitialState(), { rescueContext: { importedAt: '2026-11-15T00:00:00Z', status: 'rescued', summary: '', change: [], roles: { 's-A': { role: 'changed' }, 's-B': { role: 'alternative', rank: 1 }, 's-C': { role: 'alternative', rank: 2 }, 's-D': { role: 'original' } } } })
    const html = plain(renderToString(<DecisionOverview entries={e} groups={G1} pairs={res.pairwise} rankingCurrent notes={[]} />))
    Object.assign(useCompareStore.getInitialState(), { rescueContext: null })
    expect(html).toContain('data-kind="recommended"')
    expect(html).toContain('Scenario B (recovery · Rescue #1)')
    expect(html).toContain('Scenario A (after the change) fails')
    expect(html).toContain('13.2 pp short of the limit') // the decisive requirement, with its margin
    expect(html).toContain('Open B in Planner') // the next action
  })

  it('overlapping score bounds: the canonical order stands but the preference is reported as not established', () => {
    const e = ['B', 'C'].map((k) => entry(k))
    const pairs: PairEvidence[] = res.pairwise.map((p) => ({ ...p, score_difference: { ...p.score_difference, status: 'not_established' } }))
    const d = buildDecision(e, G1, pairs).groups[0]
    expect(d.kind).toBe('recommended')
    expect(preferenceStrength(d, pairs)).toBe('not_established')
    const html = plain(renderToString(<DecisionOverview entries={e} groups={G1} pairs={pairs} rankingCurrent notes={[]} />))
    expect(html).toContain('Several pass: preference not established')
    expect(html).toContain('does not establish that the first-ranked plan is more desirable')
  })

  it('only one passing plan, all failed, all unknown', () => {
    const a = entry('A'), b = entry('B')
    const one = buildDecision([a, as(b, 'pass', 'B', 1)], [group(['B', 'A'], ['B'])], []).groups[0]
    expect(one.kind).toBe('single_pass')
    const none = buildDecision([a, as(b, 'fail', 'Bf')], [group(['A', 'Bf'], [])], []).groups[0]
    expect(none.kind).toBe('none_pass')
    const unk = buildDecision([as(a, 'unknown', 'Au'), as(b, 'unknown', 'Bu')], [group(['Au', 'Bu'], [])], []).groups[0]
    expect(unk.kind).toBe('insufficient')
    const html = plain(renderToString(<DecisionOverview entries={[as(a, 'unknown', 'Au'), as(b, 'unknown', 'Bu')]} groups={[group(['Au', 'Bu'], [])]} pairs={[]} rankingCurrent notes={[]} />))
    expect(html).toContain('No conclusion: the data cannot decide')
    expect(html).not.toContain('Recommended')
  })

  it('separate comparability groups: one brief per group, no preference across groups', () => {
    const e = ['B', 'C', 'E'].map((k) => entry(k))
    const html = plain(renderToString(<DecisionOverview entries={e} groups={res.ranking_groups} pairs={res.pairwise} rankingCurrent notes={[]} />))
    expect((html.match(/data-testid="decision-brief"/g) ?? []).length).toBe(2)
    expect(html).toContain('Group G2')
    expect(html).toContain('no preference is stated across groups')
  })
})

describe('cards and decisive metrics', () => {
  it('rank lines never say "#1 of 1" and explain why a plan is not ranked', () => {
    const e = ['A', 'B', 'C', 'D', 'E'].map((k) => entry(k))
    expect(rankLine(e[1], 2)).toBe('Rank 1 of 2 passing in group G1')
    expect(rankLine(e[0], 1)).toBe('Not ranked: fails a requirement')
    expect(rankLine(e[4], 2)).toMatch(/^Only passing plan in group G2/)
    expect(rankLine({ ...e[1], state: { state: 'loading' } }, 1)).toBe('Assessing…')
  })

  it('key constraint: the failure, else the tightest real margin (never a switched-off zero limit)', () => {
    const a = keyConstraint(entry('A'))!
    expect(a.kind).toBe('fail')
    expect(a.text).toMatch(/short of the limit|over the limit/)
    const c = keyConstraint(entry('C'))!
    expect(c.kind).toBe('tightest')
    expect(c.text).not.toContain('≥ 0 h')
  })

  it('baseline changes keep units apart: hours as h, shares as percentage points; bounds stay bounds', () => {
    const [b, c] = ['B', 'C'].map((k) => entry(k))
    const earth = DECISIVE_ROWS.find((r) => r.id === 'disk')!
    const black = DECISIVE_ROWS.find((r) => r.id === 'blackout')!
    expect(decisiveCell(earth, c, b).delta?.text).toMatch(/pp$/)
    expect(decisiveCell(black, c, b).delta?.text).toMatch(/h$|no meaningful change/)
    expect(decisiveCell(earth, b, b).delta).toBeNull() // the baseline itself
    expect(deltaText(-28.57, 'percent')).toBe('−28.6 pp')
    expect(deltaText(96, 'hours')).toBe('+96 h')
    const geo = DECISIVE_ROWS.map((r) => r.metric)
    expect(geo).toContain('longest_power_darkness_h')
    expect(geo).toContain('longest_without_sun_h') // geometric darkness is its own row
  })

  it('different requirements or durations: descriptive differences, not a fair ranking', () => {
    const b = entry('B'), e = entry('E', { duration_days: 3 })
    expect(comparability([b, e]).note).toMatch(/different mission durations.*do not establish a fair ranking/)
    expect(comparability([b, entry('C')]).note).toBeNull()
  })

  it('roles only while the Mission Rescue import is intact', () => {
    const e = ['A', 'B'].map((k) => entry(k))
    const ctx = { importedAt: '', status: 'rescued' as const, summary: '', change: [], roles: { 's-A': { role: 'original' as const }, 's-Z': { role: 'changed' as const } } }
    expect(rolesOf(ctx, e)).toEqual({}) // s-Z was removed from the selection
    expect(rolesOf({ ...ctx, roles: { 's-A': { role: 'original' } } }, e)['s-A'].label).toBe('Original plan')
  })
})
