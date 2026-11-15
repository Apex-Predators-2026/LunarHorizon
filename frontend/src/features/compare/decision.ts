// Decision explanations (Phase 5). Pure functions: no React, no fetching, nothing recomputed.
//
// Four kinds of statement are kept apart on purpose:
//   1. Requirement satisfaction  - the engine's PASS / FAIL / UNKNOWN verdicts and failed requirements.
//   2. Canonical ranking evidence - the engine's own ranking and its pairwise evidence (compare_scenarios).
//   3. Measured trade-offs       - individual canonical metrics compared one by one (not the ranking).
//   4. Uncertainty               - what the evidence cannot establish.
// A recommendation is only made for a scenario that passes every requirement and holds rank 1 in its group.
import { SCREENING_NOTE } from '../../lib/headroom'
import {
  canonicalRanking,
  cm,
  eligibilityOf,
  headroomOfEntry,
  humanizeSeconds,
  isLimitedHeadroom,
  qualifiedPassClause,
  requirementSummary,
  type Entry,
  type GroupView,
} from './analysis'
import type { CanonicalMetric, PairEvidence, RankingGroup } from './types'

export type DecisionKind =
  | 'recommended' // >= 2 scenarios pass; rank 1 is preferred under the engine's ranking
  | 'single_pass' // exactly one passes; it is the only option that meets every requirement
  | 'lone' // one scenario in the group, and it passes: nothing comparable to choose between
  | 'insufficient' // nothing proven to pass, at least one cannot be decided: no conclusion possible
  | 'none_pass' // every scenario fails: no recommendation

export interface Tradeoff {
  a: Entry
  b: Entry
  aBetter: string[]
  bBetter: string[]
  similar: boolean // no meaningful measured difference on any compared metric
}

export interface GroupDecision {
  group: RankingGroup
  kind: DecisionKind
  recommended: Entry | null
  headline: string
  requirements: { entry: Entry; text: string }[] // per scenario: what it passes, fails or cannot decide
  evidence: string[] // canonical ranking evidence, restated
  engineText: string | null // the engine's own explanation for the deciding pair (ids replaced by letters)
  tradeoffs: Tradeoff[]
  uncertainty: string[]
}

export interface DecisionReport {
  groups: GroupDecision[]
  unassessed: Entry[]
  notes: string[] // cross-group and data notes
}

const L = (e: Entry) => `Scenario ${e.scenario.label}`
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** Replace the engine's internal scenario ids with the scenario letters the user sees. Nothing else changes. */
export function withLabels(text: string, entries: Entry[], pairs: PairEvidence[]): string {
  const byKey = new Map(entries.filter((e) => e.result).map((e) => [e.result!.key, e]))
  const ids = new Map<string, string>()
  for (const p of pairs) {
    const a = byKey.get(p.selected), b = byKey.get(p.competitor)
    if (a) ids.set(p.selected_id, L(a))
    if (b) ids.set(p.competitor_id, L(b))
  }
  // Longest ids first: a duplicate's id ("...-2") contains the original id.
  return [...ids.entries()].sort((x, y) => y[0].length - x[0].length).reduce((t, [id, lbl]) => t.split(id).join(lbl), text)
}

export function findPair(pairs: PairEvidence[], a: Entry, b: Entry): PairEvidence | null {
  const ka = a.result?.key, kb = b.result?.key
  return pairs.find((p) => (p.selected === ka && p.competitor === kb) || (p.selected === kb && p.competitor === ka)) ?? null
}

// ---------------------------------------------------------------- measured trade-offs

interface TradeMetric {
  key: string
  better: 'higher' | 'lower'
  noun: (better: boolean) => string
  fmt: (v: number) => string // the number with its unit
  what?: string // what is measured, written once after both numbers
  meaningful: (a: number, b: number) => boolean
}

const pct = (v: number) => `${v.toFixed(1)}%`
const hrs = (v: number) => (v >= 72 ? `${Math.round(v)} h (${(v / 24).toFixed(1)} d)` : `${Math.round(v)} h`)
const pts = (a: number, b: number) => Math.abs(a - b) >= 1
const hours = (a: number, b: number) => Math.abs(a - b) >= Math.max(2, 0.1 * Math.max(Math.abs(a), Math.abs(b)))

/** Canonical metrics used for trade-off sentences (engine values, exact only). */
const TRADE_METRICS: TradeMetric[] = [
  { key: 'mean_solar_disk_fraction', better: 'higher', noun: (b) => (b ? 'more sunlight' : 'less sunlight'),
    fmt: (v) => pct(v * 100), what: 'mean visible solar disk', meaningful: (a, b) => pts(a * 100, b * 100) },
  { key: 'longest_power_darkness_h', better: 'lower', noun: (b) => (b ? 'a shorter longest darkness' : 'a longer longest darkness'),
    fmt: hrs, meaningful: hours },
  { key: 'earth_visible_percent', better: 'higher', noun: (b) => (b ? 'more Earth visibility' : 'less Earth visibility'),
    fmt: pct, what: 'of the mission in line of sight', meaningful: pts },
  { key: 'longest_blackout_h', better: 'lower', noun: (b) => (b ? 'a shorter longest communication blackout' : 'a longer longest communication blackout'),
    fmt: hrs, meaningful: hours },
  { key: 'initial_sunlight_h', better: 'higher', noun: (b) => (b ? 'more sunlight right after landing' : 'less sunlight right after landing'),
    fmt: hrs, meaningful: hours },
  { key: 'mean_sun_clearance_deg', better: 'higher', noun: (b) => (b ? 'the Sun higher above the local terrain' : 'the Sun closer to the local terrain'),
    fmt: (v) => `${v.toFixed(2)}°`, what: 'mean Sun clearance', meaningful: (a, b) => Math.abs(a - b) >= 0.1 },
]

const exact = (m: CanonicalMetric | null) => (m && m.status === 'known' ? m.value : null)

export function tradeoff(a: Entry, b: Entry): Tradeoff {
  const aBetter: string[] = [], bBetter: string[] = []
  for (const t of TRADE_METRICS) {
    const va = exact(cm(a.result, t.key)), vb = exact(cm(b.result, t.key))
    if (va === null || vb === null || !t.meaningful(va, vb)) continue
    const aWins = t.better === 'higher' ? va > vb : va < vb
    const line = (w: number, l: number) => `${t.noun(true)} (${t.fmt(w)} vs ${t.fmt(l)}${t.what ? ` ${t.what}` : ''})`
    if (aWins) aBetter.push(line(va, vb))
    else bBetter.push(line(vb, va))
  }
  return { a, b, aBetter, bBetter, similar: !aBetter.length && !bBetter.length }
}

export function tradeoffSentence(t: Tradeoff): string {
  if (t.similar) return `${L(t.a)} and ${L(t.b)} show no meaningful difference on the measured metrics compared here.`
  const parts: string[] = []
  if (t.aBetter.length) parts.push(`${L(t.a)} has ${list(t.aBetter)}.`)
  if (t.bBetter.length) parts.push(`${t.aBetter.length ? 'In return, ' : ''}${L(t.b)} has ${list(t.bBetter)}.`)
  if (t.aBetter.length && !t.bBetter.length) parts.push(`${L(t.a)} is at least as good on every metric compared here.`)
  if (t.bBetter.length && !t.aBetter.length) parts.push(`${L(t.b)} is at least as good on every metric compared here.`)
  return parts.join(' ')
}

// ---------------------------------------------------------------- per-group decision

function requirementLine(e: Entry): string {
  const r = requirementSummary(e)
  const el = eligibilityOf(e)
  if (!r) return `${L(e)}: no canonical assessment.`
  if (el === 'pass') {
    const hr = headroomOfEntry(e)
    if (hr && isLimitedHeadroom(hr)) {
      return `${L(e)} ${qualifiedPassClause(hr)}.`
    }
    return `${L(e)} meets all ${r.applicable} applicable requirements.`
  }
  const parts: string[] = []
  if (r.failed.length) parts.push(`fails ${list(r.failed.map((f) => f.name.toLowerCase()))}`)
  if (r.undecided.length) parts.push(`${r.failed.length ? 'and ' : ''}cannot decide ${list(r.undecided.map((f) => f.name.toLowerCase()))} from the data`)
  return `${L(e)} ${parts.join(' ')}.`
}

function scoreEvidence(top: Entry, other: Entry, p: PairEvidence | null): string[] {
  if (!p) return [`No pairwise evidence is available for ${L(top)} and ${L(other)}.`]
  const out: string[] = []
  const topIsSelected = p.selected === top.result?.key
  const sd = p.score_difference
  let range: string | null = null
  if (sd.lower !== null && sd.upper !== null) {
    const [lo, hi] = topIsSelected ? [sd.lower, sd.upper] : [-sd.upper, -sd.lower]
    range = lo.toFixed(1) === hi.toFixed(1) ? lo.toFixed(1) : `${lo.toFixed(1)} to ${hi.toFixed(1)}`
  }
  const topHigher = sd.status === (topIsSelected ? 'selected_higher' : 'competitor_higher')
  if (p.deciding_criterion === 'eligibility') {
    const hr = headroomOfEntry(top)
    const passClause = hr && isLimitedHeadroom(hr) ? qualifiedPassClause(hr) : 'passes every requirement'
    out.push(`${L(top)} ranks above ${L(other)} because it ${passClause} and ${L(other)} does not; the score plays no part in that order.`)
  } else if (p.policy_tie_break) {
    out.push(`The order of ${L(top)} and ${L(other)} is decided by a ranking tie-break (${(p.deciding_criterion ?? '').replace(/_/g, ' ')}), not by a measured difference.`)
  } else if (topHigher) {
    out.push(`${L(top)}'s desirability score is higher than ${L(other)}'s everywhere within the recorded bounds${range ? ` (by ${range} points)` : ''}.`)
  } else if (sd.status === 'not_established') {
    out.push(`${L(top)} is placed first by the engine's conservative ordering, but the two score ranges overlap${range ? ` (difference ${range} points)` : ''}: the evidence does not prove that ${L(top)} is more desirable.`)
  } else if (sd.status === 'unavailable') {
    out.push(`No score difference can be stated because at least one of ${L(top)} and ${L(other)} has no exact score; a missing score is not treated as 0.`)
  }
  if (p.deciding_criterion !== 'eligibility') {
    const sel = topIsSelected ? 'selected' : 'competitor'
    const opp = topIsSelected ? 'competitor' : 'selected'
    const topParts = p.components.filter((c) => c.advantage === sel).map((c) => c.label)
    const otherParts = p.components.filter((c) => c.advantage === opp).map((c) => c.label)
    if (topParts.length) out.push(`Score components that favour ${L(top)}: ${list(topParts)}.`)
    if (otherParts.length) out.push(`Score components that favour ${L(other)}: ${list(otherParts)}.`)
  }
  return out
}

function uncertaintyFor(members: Entry[]): string[] {
  const out: string[] = []
  for (const e of members) {
    const a = e.result?.assessment
    if (!a) continue
    const cov = Math.min(a.sun_coverage_percent, a.earth_coverage_percent)
    if (cov < 100) out.push(`${L(e)}: data covers ${cov.toFixed(1)}% of the mission; values over the gaps are bounds, not measurements.`)
    const inexact = Object.entries(a.metrics).filter(([, m]) => m.status === 'bounded').length
    if (inexact) out.push(`${L(e)}: ${inexact} metric${inexact > 1 ? 's are' : ' is'} only bounded.`)
    if (e.ranking?.score_status === 'bounded') out.push(`${L(e)}: its score is only known as a range.`)
    if (a.is_synthetic) out.push(`${L(e)} uses DEMONSTRATION data: illustrative only, not real lunar conditions.`)
  }
  return out
}

function decideGroup(v: GroupView, entries: Entry[], pairs: PairEvidence[], multi: boolean): GroupDecision {
  const members = [...v.ranked, ...v.unknown, ...v.failed]
  const requirements = members.map((e) => ({ entry: e, text: requirementLine(e) }))
  const uncertainty = uncertaintyFor(members)
  const label = multi ? ` in group ${v.group.id}` : ''
  let kind: DecisionKind
  let recommended: Entry | null = null
  let headline: string
  const evidence: string[] = []
  let engineText: string | null = null
  let deciding: PairEvidence | null = null

  if (v.ranked.length >= 2) {
    kind = 'recommended'
    recommended = v.ranked[0]
    const runner = v.ranked[1]
    deciding = findPair(pairs, recommended, runner)
    const hr = headroomOfEntry(recommended)
    const limited = isLimitedHeadroom(hr)
    const passClause = hr && limited ? qualifiedPassClause(hr) : 'passes every requirement'
    headline = `${L(recommended)} is preferred under the selected requirements${label}: it ${passClause} and holds canonical rank 1 of ${v.ranked.length} passing scenarios.`
    evidence.push(...scoreEvidence(recommended, runner, deciding))
  } else if (v.ranked.length === 1 && members.length === 1) {
    kind = 'lone'
    recommended = v.ranked[0]
    const hr = headroomOfEntry(recommended)
    const limited = isLimitedHeadroom(hr)
    const passClause = hr && limited ? qualifiedPassClause(hr) : 'passes every requirement'
    headline = `${L(recommended)} ${passClause}${label}, but no other scenario can be ranked against it (different data basis, requirements or mission duration), so this is not a comparison.`
  } else if (v.ranked.length === 1) {
    kind = 'single_pass'
    recommended = v.ranked[0]
    const hr = headroomOfEntry(recommended)
    const limited = isLimitedHeadroom(hr)
    headline = hr && limited
      ? `${L(recommended)} is the only scenario${label} that ${qualifiedPassClause(hr)}.`
      : `${L(recommended)} is the only scenario${label} that passes every requirement, so it is the only option that meets them.`
    const next = [...v.unknown, ...v.failed][0]
    if (next) {
      deciding = findPair(pairs, recommended, next)
      evidence.push(...scoreEvidence(recommended, next, deciding))
    }
  } else if (v.unknown.length) {
    kind = 'insufficient'
    headline = `No scenario${label} is proven to pass every requirement, and ${list(v.unknown.map(L))} cannot be decided from the available data. The evidence is not sufficient for a recommendation.`
  } else {
    kind = 'none_pass'
    headline = `None of the scenarios${label} meets the selected requirements, so none is recommended.`
    const counts = v.failed.map((e) => ({ e, n: requirementSummary(e)?.failed.length ?? 0 }))
    const min = Math.min(...counts.map((c) => c.n))
    const fewest = counts.filter((c) => c.n === min)
    if (fewest.length === 1 && counts.length > 1) {
      evidence.push(`${L(fewest[0].e)} fails the fewest requirements (${min}). That is a fact about the violations, not a recommendation: it still fails.`)
    }
  }
  if (v.unknown.length && (kind === 'recommended' || kind === 'single_pass')) {
    uncertainty.unshift(`${list(v.unknown.map(L))} cannot be decided from the available data. With complete data ${v.unknown.length > 1 ? 'they' : 'it'} could pass or fail, so the preference holds only on the evidence that exists.`)
  }
  if (deciding) {
    engineText = withLabels(deciding.explanation, entries, pairs)
    for (const lim of deciding.limitations) uncertainty.push(withLabels(lim, entries, pairs))
  }
  // Measured trade-offs: the preferred scenario against each other scenario, else every pair in the group.
  const tradeoffs: Tradeoff[] = []
  if (recommended && members.length > 1) for (const o of members) if (o !== recommended) tradeoffs.push(tradeoff(recommended, o))
  if (!recommended) for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) tradeoffs.push(tradeoff(members[i], members[j]))
  return { group: v.group, kind, recommended, headline, requirements, evidence, engineText, tradeoffs: tradeoffs.slice(0, 6), uncertainty }
}

/** Evidence-backed decision for the compared scenarios, one per comparable group. */
export function buildDecision(entries: Entry[], groups: RankingGroup[], pairs: PairEvidence[]): DecisionReport {
  const { groups: views, unassessed } = canonicalRanking(entries, groups)
  const multi = views.length > 1
  const out = views.map((v) => decideGroup(v, entries, pairs, multi))
  const notes: string[] = []
  if (multi) {
    for (const v of views.slice(1)) {
      if (v.group.separate_reason) notes.push(`Group ${v.group.id} is not comparable with ${views[0].group.id} (${humanizeSeconds(v.group.separate_reason)}), so no scenario in it is ranked against ${views[0].group.id} and no preference is stated across groups.`)
    }
  }
  for (const e of unassessed) {
    if (eligibilityOf(e) === 'unknown') notes.push(`${L(e)} has no canonical assessment (no data for that site and date range); it cannot be decided and takes no part in the decision.`)
  }
  notes.push('Earth line of sight is geometric visibility, not a working radio link. The desirability score is a relative index under the engine’s weights, not a probability of mission success.')
  notes.push(SCREENING_NOTE)
  return { groups: out, unassessed, notes }
}
