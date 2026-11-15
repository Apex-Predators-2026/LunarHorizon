// What the first screen of the comparison says, as pure functions over the displayed entries. Nothing here decides
// eligibility, ranks or scores: verdicts and ranks are the canonical engine's (via the backend), the recommendation
// is decision.ts's buildDecision, and the strength of a preference is the engine's pairwise evidence. This module
// only chooses what to show first and how to word it.
import { cm, eligibilityOf, fmtMetric, requirementSummary, type Entry } from './analysis'
import { buildDecision, findPair, type DecisionReport, type GroupDecision } from './decision'
import type { RescueContext } from './rescueFlow'
import type { CanonicalMetric, ConstraintItem, PairEvidence, RankingGroup } from './types'

// ---------------------------------------------------------------- roles (Mission Rescue / guided mission imports)

export interface RoleInfo {
  role: 'original' | 'changed' | 'alternative'
  label: string // "Original plan", "After the change", "Recovery (Rescue #1)"
}

/** Story roles of the selected scenarios, when the selection is an intact Mission Rescue import. */
export function rolesOf(ctx: RescueContext | null, entries: Entry[]): Record<string, RoleInfo> {
  if (!ctx) return {}
  const ids = new Set(entries.map((e) => e.scenario.id))
  if (Object.keys(ctx.roles).some((id) => !ids.has(id))) return {} // the import was changed: no story roles
  const out: Record<string, RoleInfo> = {}
  for (const [id, r] of Object.entries(ctx.roles)) {
    out[id] = {
      role: r.role,
      label: r.role === 'original' ? 'Original plan' : r.role === 'changed' ? 'After the change' : `Recovery${r.rank ? ` · Rescue #${r.rank}` : ''}`,
    }
  }
  return out
}

// ---------------------------------------------------------------- the constraint that matters most for a scenario

export interface KeyConstraint {
  kind: 'fail' | 'unknown' | 'tightest'
  constraint: ConstraintItem
  text: string // "Longest blackout 118 h, limit ≤ 96 h: 22 h over"
}

const unitOf = (m: CanonicalMetric): 'h' | '%' | 'deg' => (m.unit === 'h' ? 'h' : m.unit === 'fraction' || m.unit === '%' ? '%' : 'deg')
const scaleOf = (m: CanonicalMetric) => (m.unit === 'fraction' ? 100 : 1)

/** A value for a sentence: hours stay plain hours ("118 h"), so no nested "(4.9 d)" parentheses. */
const plain = (v: number, u: 'h' | '%' | 'deg') => (u === 'h' ? `${Math.round(v * 10) / 10} h` : fmtMetric(v, u))

function valueText(m: CanonicalMetric): string {
  const k = scaleOf(m), u = unitOf(m)
  if (m.status === 'known' && m.value !== null) return plain(m.value * k, u)
  if (m.status === 'bounded' && m.lower !== null && m.upper !== null) return `between ${plain(m.lower * k, u)} and ${plain(m.upper * k, u)}`
  return 'unavailable'
}

export function limitText(c: ConstraintItem): string | null {
  if (c.threshold === null) return null
  return `${c.comparison === 'at_most' ? '≤' : '≥'} ${plain(c.threshold * scaleOf(c.measured), unitOf(c.measured))}`
}

/** Headroom inside the limit (positive) or excess over it (negative), exact values only, in display units. */
export function headroomOf(c: ConstraintItem): { value: number; unit: 'h' | 'pp' | 'deg'; relative: number | null; atMost: boolean } | null {
  const m = c.measured
  if (c.threshold === null || m.status !== 'known' || m.value === null) return null
  const k = scaleOf(m)
  const atMost = c.comparison === 'at_most'
  const raw = (atMost ? c.threshold - m.value : m.value - c.threshold) * k
  const ref = Math.abs(c.threshold * k)
  const u = unitOf(m)
  // A zero threshold (e.g. "at least 0 h") is effectively switched off: it has no meaningful relative margin.
  return { value: raw, unit: u === '%' ? 'pp' : u, relative: ref > 0 ? raw / ref : null, atMost }
}

const headroomWords = (h: NonNullable<ReturnType<typeof headroomOf>>) => {
  const v = h.unit === 'h' ? plain(Math.abs(h.value), 'h') : h.unit === 'pp' ? `${Math.abs(h.value).toFixed(1)} pp` : `${Math.abs(h.value).toFixed(2)}°`
  if (h.value >= 0) return `${v} to spare`
  return h.atMost ? `${v} over the limit` : `${v} short of the limit`
}

/** The failed (else undecided) requirement, or for a passing plan the requirement with the least relative headroom. */
export function keyConstraint(e: Entry): KeyConstraint | null {
  const cs = (e.result?.assessment?.constraints ?? []).filter((c) => c.status !== 'not_applicable')
  const describe = (c: ConstraintItem) => {
    const lim = limitText(c)
    const h = headroomOf(c)
    return `${c.name ?? c.id}: ${valueText(c.measured)}${lim ? ` (limit ${lim})` : ''}${h ? `, ${headroomWords(h)}` : ''}`
  }
  const failed = cs.find((c) => c.status === 'fail')
  if (failed) return { kind: 'fail', constraint: failed, text: describe(failed) }
  const unknown = cs.find((c) => c.status === 'unknown')
  if (unknown) return { kind: 'unknown', constraint: unknown, text: `${unknown.name ?? unknown.id}: cannot be decided (${valueText(unknown.measured)})` }
  const withRoom = cs.map((c) => ({ c, h: headroomOf(c) }))
    .filter((x): x is { c: ConstraintItem; h: NonNullable<ReturnType<typeof headroomOf>> & { relative: number } } => !!x.h && x.h.relative !== null)
  if (!withRoom.length) return null
  const t = withRoom.reduce((a, b) => (b.h.relative < a.h.relative ? b : a))
  return { kind: 'tightest', constraint: t.c, text: describe(t.c) }
}

/** "Rank 1 of 2 passing", "Only passing plan in its group", or why it is not ranked. Never "#1 of 1". */
export function rankLine(e: Entry, groupCount: number): string {
  const r = e.ranking
  const el = eligibilityOf(e)
  if (!e.state || e.state.state === 'loading') return 'Assessing…'
  if (!r) return el ? 'Ranking updating…' : 'Not assessed'
  if (r.rank === null) return el === 'fail' ? 'Not ranked: fails a requirement' : el === 'unknown' ? 'Not ranked: cannot be decided' : 'Not ranked'
  const where = groupCount > 1 && r.group ? ` in group ${r.group}` : ''
  return r.ranked_in_group > 1 ? `Rank ${r.rank} of ${r.ranked_in_group} passing${where}` : `Only passing plan${where ? where : ' in its group'}`
}

// ---------------------------------------------------------------- the decision state of the whole selection

export type Overall =
  | { kind: 'empty' }
  | { kind: 'loading'; count: number }
  | { kind: 'error'; message: string }
  | { kind: 'decided'; report: DecisionReport }

export function overallState(entries: Entry[], groups: RankingGroup[], pairs: PairEvidence[], rankingCurrent: boolean): Overall {
  if (!entries.length) return { kind: 'empty' }
  const err = entries.find((e) => e.state?.state === 'error')
  if (err && err.state?.state === 'error' && entries.every((e) => e.state?.state === 'error')) return { kind: 'error', message: err.state.message }
  if (!rankingCurrent || entries.some((e) => !e.state || e.state.state === 'loading')) return { kind: 'loading', count: entries.length }
  return { kind: 'decided', report: buildDecision(entries, groups, pairs) }
}

export type Strength = 'established' | 'not_established' | 'tie_break' | 'eligibility' | 'none'

/** How firmly the engine's pairwise evidence separates the recommended plan from the runner-up. */
export function preferenceStrength(d: GroupDecision, pairs: PairEvidence[]): Strength {
  if (d.kind !== 'recommended' || !d.recommended) return d.kind === 'single_pass' ? 'eligibility' : 'none'
  const views = [...d.requirements.map((r) => r.entry)]
  const runner = views.find((e) => e !== d.recommended && e.ranking?.rank === 2)
  const p = runner ? findPair(pairs, d.recommended, runner) : null
  if (!p) return 'not_established'
  if (p.policy_tie_break) return 'tie_break'
  const topSel = p.selected === d.recommended.result?.key
  const sd = p.score_difference.status
  if (sd === (topSel ? 'selected_higher' : 'competitor_higher')) return 'established'
  return 'not_established'
}

export const DECISION_LABEL: Record<GroupDecision['kind'] | 'unresolved', string> = {
  recommended: 'Recommended',
  unresolved: 'Several pass: preference not established',
  single_pass: 'Only one plan meets the requirements',
  lone: 'Passes, nothing comparable to choose between',
  insufficient: 'No conclusion: the data cannot decide',
  none_pass: 'No plan meets the requirements',
}

// ---------------------------------------------------------------- comparability of the selection

export interface Comparability {
  sameRequirements: boolean
  sameDuration: boolean
  sameDataKind: boolean
  note: string | null
}

export function comparability(entries: Entry[]): Comparability {
  const req = new Set(entries.map((e) => JSON.stringify(e.scenario.requirements)))
  const dur = new Set(entries.map((e) => e.scenario.duration_days))
  const kind = new Set(entries.map((e) => e.result?.data_kind).filter(Boolean))
  const parts: string[] = []
  if (req.size > 1) parts.push('different requirements')
  if (dur.size > 1) parts.push('different mission durations')
  if (kind.size > 1) parts.push('a mix of real and demonstration data')
  return {
    sameRequirements: req.size <= 1, sameDuration: dur.size <= 1, sameDataKind: kind.size <= 1,
    note: parts.length
      ? `These plans have ${parts.join(' and ')}. Differences between them are descriptive: they do not establish a fair ranking, so plans are only ranked against others with the same requirements, duration and data basis.`
      : null,
  }
}

// ---------------------------------------------------------------- decisive metrics with baseline changes

export interface DecisiveRowDef {
  id: string
  label: string
  hint: string
  metric: string // canonical metric key
  constraint?: string // the requirement it is checked against
  better: 'higher' | 'lower'
  kind: 'percent' | 'hours'
}

export const DECISIVE_ROWS: DecisiveRowDef[] = [
  { id: 'sunlight', label: 'Direct sunlight', hint: 'Share of the mission with any part of the solar disk above the terrain (geometric illumination, not electrical power)', metric: 'sunlight_percent', better: 'higher', kind: 'percent' },
  { id: 'disk', label: 'Mean visible solar disk', hint: 'Time-mean fraction of the solar disk above the terrain', metric: 'mean_solar_disk_fraction', constraint: 'min_mean_solar_disk_fraction', better: 'higher', kind: 'percent' },
  { id: 'earth', label: 'Earth in line of sight', hint: 'Share of the mission with the Earth centre above the terrain (geometric visibility, not a radio link budget)', metric: 'earth_visible_percent', constraint: 'min_earth_visibility_percent', better: 'higher', kind: 'percent' },
  { id: 'power_dark', label: 'Longest power darkness', hint: 'Longest period with less of the solar disk visible than the panel threshold: what the battery must bridge', metric: 'longest_power_darkness_h', constraint: 'max_continuous_darkness', better: 'lower', kind: 'hours' },
  { id: 'geo_dark', label: 'Longest without direct sunlight', hint: 'Longest period with no part of the solar disk visible (geometric darkness; shorter than or equal to power darkness)', metric: 'longest_without_sun_h', better: 'lower', kind: 'hours' },
  { id: 'blackout', label: 'Longest communication blackout', hint: 'Longest period with the Earth below the local terrain (direct-to-Earth line of sight lost)', metric: 'longest_blackout_h', constraint: 'max_communication_blackout', better: 'lower', kind: 'hours' },
]

export interface DecisiveCell {
  text: string // value, bounds or "unavailable"
  status: ConstraintItem['status'] | null // the related requirement's verdict
  limit: string | null
  delta: { text: string; better: boolean | null } | null // vs the baseline, exact values only
}

const pct = (m: CanonicalMetric | null): number | null => (m && m.status === 'known' && m.value !== null ? m.value * (m.unit === 'fraction' ? 100 : 1) : null)

function cellText(m: CanonicalMetric | null, kind: DecisiveRowDef['kind']): string {
  if (!m) return 'unavailable'
  const k = m.unit === 'fraction' ? 100 : 1
  const f = (v: number) => (kind === 'hours' ? fmtMetric(v, 'h') : `${(v * k).toFixed(1)}%`)
  if (m.status === 'known' && m.value !== null) return f(m.value)
  if (m.status === 'bounded' && m.lower !== null && m.upper !== null) return `${f(m.lower)} – ${f(m.upper)}`
  return m.status === 'not_applicable' ? 'n/a' : 'unavailable'
}

/** A labelled change against the baseline: hours as "h", percentages as percentage points ("pp"). */
export function deltaText(d: number, kind: DecisiveRowDef['kind']): string {
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±'
  const a = Math.abs(d)
  return kind === 'hours' ? `${sign}${a >= 10 ? Math.round(a) : a.toFixed(1)} h` : `${sign}${a.toFixed(1)} pp`
}

export function decisiveCell(row: DecisiveRowDef, e: Entry, base: Entry | null): DecisiveCell {
  const m = cm(e.result, row.metric)
  const c = row.constraint ? e.result?.assessment?.constraints.find((x) => x.id === row.constraint) : undefined
  let delta: DecisiveCell['delta'] = null
  if (base && base.scenario.id !== e.scenario.id) {
    const a = row.kind === 'percent' ? pct(m) : m?.status === 'known' ? m.value : null
    const bm = cm(base.result, row.metric)
    const b = row.kind === 'percent' ? pct(bm) : bm?.status === 'known' ? bm.value : null
    if (a !== null && b !== null) {
      const d = a - b
      const small = row.kind === 'hours' ? Math.abs(d) < 1 : Math.abs(d) < 0.5
      delta = { text: small ? 'no meaningful change' : deltaText(d, row.kind), better: small ? null : row.better === 'higher' ? d > 0 : d < 0 }
    }
  }
  return {
    text: cellText(m, row.kind),
    status: c && c.status !== 'not_applicable' ? c.status : null,
    limit: c ? limitText(c) : null,
    delta,
  }
}

/** Data coverage of the evaluated mission (the lower of Sun and Earth coverage), or null when not assessed. */
export function coverageOf(e: Entry): number | null {
  const a = e.result?.assessment
  return a ? Math.min(a.sun_coverage_percent, a.earth_coverage_percent) : null
}

export const requirementsLine = (e: Entry): string | null => {
  const r = requirementSummary(e)
  if (!r) return null
  return `${r.passed} of ${r.applicable} requirements met${r.failed.length ? ` · ${r.failed.length} failed` : ''}${r.undecided.length ? ` · ${r.undecided.length} cannot be decided` : ''}`
}
