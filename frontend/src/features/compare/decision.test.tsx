// Decision explanations (Phase 5). Real fixture (canonical engine, same requirements, 7-day missions from
// 2027-01-15): A Peak Near Shackleton FAIL · B Malapert PASS #1 · C Connecting Ridge PASS #2 · D no data ·
// E Malapert 3-day PASS in separate group G2. Other cases are built from these with only the verdict changed.
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import fixture from './__fixtures__/compare-response.json'
import { type Entry } from './analysis'
import { buildDecision, findPair, tradeoff, tradeoffSentence, withLabels } from './decision'
import { makeScenario } from './scenario'
import { SummaryPanel } from './SummaryPanel'
import type { CompareResponse, CompareResult, PairEvidence, RankingGroup, RankingInfo } from './types'

const res = fixture as unknown as CompareResponse
const byKey = Object.fromEntries(res.results.map((r) => [r.key, r])) as Record<string, CompareResult>
const SITE = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }

function entry(key: string, label = key): Entry {
  const r = byKey[key]
  const scenario = { ...makeScenario({ site: SITE, landing_utc: '2027-01-15T00:00:00Z' }, []), label, id: `s-${label}` }
  const result = r.status === 'ok' ? r : null
  return { scenario, state: { state: 'done', result: r }, result, offsetHours: 0, ranking: r.ranking }
}

/** Same data, different verdict: for PASS/FAIL/UNKNOWN combinations the fixture does not contain. */
function as(e: Entry, eligibility: RankingInfo['eligibility'], key: string, rank: number | null = null): Entry {
  const a = e.result!.assessment!
  const constraints = a.constraints.map((c, i) =>
    eligibility === 'pass' ? (c.status === 'not_applicable' ? c : { ...c, status: 'pass' as const })
      : i === 0 ? { ...c, status: eligibility === 'fail' ? ('fail' as const) : ('unknown' as const) } : c)
  const ranking: RankingInfo = {
    ...e.ranking!, eligibility, rank, group: 'G1',
    score: eligibility === 'unknown' ? null : e.ranking!.score,
    score_status: eligibility === 'unknown' ? 'eligibility_unknown' : e.ranking!.score_status,
  }
  const result = { ...e.result!, key, ranking, assessment: { ...a, constraints } }
  return { ...e, scenario: { ...e.scenario, id: `s-${key}`, label: key }, result, state: { state: 'done', result }, ranking }
}

const group = (keys: string[], ranked: string[], id = 'G1', primary = true): RankingGroup =>
  ({ id, primary, keys, ranked_keys: ranked, data_basis: 'real_terrain_aware', policy: 'strict', method_version: 'm', separate_reason: null })

const pair = (sel: string, comp: string, over: Partial<PairEvidence> = {}): PairEvidence => ({
  selected: sel, competitor: comp, selected_id: `id_${sel}`, competitor_id: `id_${comp}`, comparable: true, comparability_issues: [],
  higher: sel, deciding_criterion: 'score_lower_bound', deciding_detail: '', policy_tie_break: false,
  score_difference: { status: 'selected_higher', lower: 1, upper: 2, both_exact: true, statement: '' },
  components: [], limitations: [], explanation: `id_${sel} ranks above id_${comp}.`, ...over,
})

describe('decision explanations', () => {
  it('two PASS: prefers canonical rank 1 and says why, with the measured trade-offs', () => {
    const e = ['A', 'B', 'C'].map((k) => entry(k))
    const d = buildDecision(e, res.ranking_groups.filter((g) => g.id === 'G1'), res.pairwise).groups[0]
    expect(d.kind).toBe('recommended')
    expect(d.recommended!.scenario.label).toBe('B')
    expect(d.headline).toMatch(/Scenario B is preferred under the selected requirements/)
    expect(d.evidence.join(' ')).toMatch(/higher than Scenario C.s everywhere within the recorded bounds \(by \d+\.\d points\)/)
    expect(d.engineText).toContain('Scenario B') // engine ids replaced by letters
    expect(d.engineText).not.toContain('rescue_')
    // Trade-off numbers are the engine's own metrics.
    const bc = d.tradeoffs.find((t) => t.b.scenario.label === 'C')!
    const disk = (k: string) => (byKey[k].assessment!.metrics.mean_solar_disk_fraction.value! * 100).toFixed(1)
    expect(tradeoffSentence(bc)).toContain(`${disk('B')}% vs ${disk('C')}% mean visible solar disk`)
    expect(d.requirements.find((r) => r.entry.scenario.label === 'A')!.text).toMatch(/fails minimum mean visible solar-disk fraction/)
  })

  it('PASS vs FAIL: the passing plan is the only option; the failure is explained, not ranked', () => {
    const d = buildDecision([entry('A'), entry('B')], [group(['B', 'A'], ['B'])], res.pairwise).groups[0]
    expect(d.kind).toBe('single_pass')
    expect(d.recommended!.scenario.label).toBe('B')
    expect(d.evidence.join(' ')).toMatch(/passes every requirement and Scenario A does not; the score plays no part/)
  })

  it('PASS vs UNKNOWN: preferred only on the existing evidence; UNKNOWN is not called a failure', () => {
    const b = entry('B'), u = as(entry('C'), 'unknown', 'U')
    const d = buildDecision([b, u], [group(['B', 'U'], ['B'])], []).groups[0]
    expect(d.kind).toBe('single_pass')
    expect(d.uncertainty[0]).toMatch(/Scenario U cannot be decided from the available data/)
    const line = d.requirements.find((r) => r.entry === u)!.text
    expect(line).toMatch(/cannot decide/)
    expect(line).not.toMatch(/fails/)
  })

  it('FAIL vs UNKNOWN: no conclusion, no recommendation', () => {
    const d = buildDecision([entry('A'), as(entry('C'), 'unknown', 'U')], [group(['U', 'A'], [])], []).groups[0]
    expect(d.kind).toBe('insufficient')
    expect(d.recommended).toBeNull()
    expect(d.headline).toMatch(/evidence is not sufficient for a recommendation/)
  })

  it('two UNKNOWN: no false winner', () => {
    const d = buildDecision([as(entry('B'), 'unknown', 'U'), as(entry('C'), 'unknown', 'V')], [group(['U', 'V'], [])], []).groups[0]
    expect(d.kind).toBe('insufficient')
    expect(d.recommended).toBeNull()
    expect(d.evidence).toEqual([])
  })

  it('both FAIL: violations explained, nothing recommended', () => {
    const d = buildDecision([entry('A'), as(entry('C'), 'fail', 'F')], [group(['F', 'A'], [])], []).groups[0]
    expect(d.kind).toBe('none_pass')
    expect(d.recommended).toBeNull()
    expect(d.headline).toMatch(/none is recommended/)
    expect(d.evidence.join(' ')).not.toMatch(/preferred/)
  })

  it('a PASS alone in a separate group is not presented as a comparison winner', () => {
    const rep = buildDecision(['B', 'C', 'E'].map((k) => entry(k)), res.ranking_groups, res.pairwise)
    const g2 = rep.groups.find((g) => g.group.id === 'G2')!
    expect(g2.kind).toBe('lone')
    expect(g2.headline).toMatch(/no other scenario can be ranked against it/)
    expect(rep.notes.join(' ')).toMatch(/Group G2 is not comparable with G1/)
  })

  it('overlapping score ranges are reported as not proven', () => {
    const b = as(entry('B'), 'pass', 'P', 1), c = as(entry('C'), 'pass', 'Q', 2)
    const p = pair('P', 'Q', { score_difference: { status: 'not_established', lower: -0.4, upper: 0.9, both_exact: false, statement: '' } })
    const d = buildDecision([b, c], [group(['P', 'Q'], ['P', 'Q'])], [p]).groups[0]
    expect(d.evidence.join(' ')).toMatch(/score ranges overlap .* does not prove that Scenario P is more desirable/)
  })

  it('a tie-break order is not presented as a measured difference', () => {
    const b = as(entry('B'), 'pass', 'P', 1), c = as(entry('C'), 'pass', 'Q', 2)
    const p = pair('P', 'Q', { deciding_criterion: 'overall_risk', policy_tie_break: true })
    const d = buildDecision([b, c], [group(['P', 'Q'], ['P', 'Q'])], [p]).groups[0]
    expect(d.evidence.join(' ')).toMatch(/decided by a ranking tie-break \(overall risk\), not by a measured difference/)
  })

  it('a missing score is never treated as 0 in the evidence', () => {
    const b = as(entry('B'), 'pass', 'P', 1), c = as(entry('C'), 'pass', 'Q', 2)
    const p = pair('P', 'Q', { deciding_criterion: 'scored_before_unscored',
      score_difference: { status: 'unavailable', lower: null, upper: null, both_exact: false, statement: '' } })
    const d = buildDecision([b, c], [group(['P', 'Q'], ['P', 'Q'])], [p]).groups[0]
    expect(d.evidence.join(' ')).toMatch(/has no exact score; a missing score is not treated as 0/)
  })

  it('unassessed scenarios take no part in the decision', () => {
    const rep = buildDecision(['B', 'C', 'D'].map((k) => entry(k)), res.ranking_groups.filter((g) => g.id === 'G1'), res.pairwise)
    expect(rep.unassessed.map((e) => e.scenario.label)).toEqual(['D'])
    expect(rep.notes.join(' ')).toMatch(/Scenario D has no canonical assessment/)
  })

  it('trade-offs only report meaningful differences and say when there are none', () => {
    const b = entry('B')
    const t = tradeoff(b, { ...b, scenario: { ...b.scenario, label: 'Z' } })
    expect(t.similar).toBe(true)
    expect(tradeoffSentence(t)).toMatch(/no meaningful difference/)
  })

  it('withLabels replaces the longest ids first', () => {
    const e = [as(entry('B'), 'pass', 'P', 1), as(entry('B'), 'pass', 'Q', 2)]
    const p = pair('P', 'Q', { selected_id: 'rescue_x', competitor_id: 'rescue_x-2' })
    expect(withLabels('rescue_x-2 and rescue_x', e, [p])).toBe('Scenario Q and Scenario P')
    expect(findPair([p], e[1], e[0])).toBe(p)
  })

  it('renders the four blocks', () => {
    const e = ['A', 'B', 'C'].map((k) => entry(k))
    const html = renderToString(<SummaryPanel entries={e} groups={res.ranking_groups.filter((g) => g.id === 'G1')} pairs={res.pairwise} />)
    for (const t of ['Preferred option', '1 · Requirements', '2 · Ranking evidence', '3 · Measured trade-offs', 'Engine explanation (verbatim)', 'Per-metric highlights']) {
      expect(html).toContain(t)
    }
  })
})
