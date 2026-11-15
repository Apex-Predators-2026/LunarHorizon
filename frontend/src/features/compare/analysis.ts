// Comparison logic: metric table, best-of, ranking, baseline deltas, trade-off index, conditions at a
// time and the written summary. Pure functions over backend results; no React, no fetching.
//
// Nothing here computes Sun/Earth geometry, viability or rank. Eligibility (PASS / FAIL / UNKNOWN), scores and
// the ranking come from the canonical viability engine through the backend (compare/ranking.py) and are only
// displayed. A missing score is never treated as 0, and UNKNOWN is never treated as FAIL.
import {
  NARROW_MARGIN_FRACTION,
  SAMPLE_RESOLUTION_H,
  SCREENING_NOTE,
  resolveHeadroom,
} from '../../lib/headroom'
import {
  verdictOf,
  type CanonicalMarginItem,
  type Eligibility,
  type MarginMetricValue,
  type MarginStatus,
  type OperationalHeadroom,
} from '../../types'
import type { CanonicalMetric, ComparisonScenario, CompareResult, ConstraintItem, RankingGroup, RankingInfo, ResultState, TimelineColumns } from './types'
import {
  MEANINGFUL,
  comparisonPool,
  contenderOf,
  exact,
  isMeaningfulDiff,
  pickBest,
  type BestOutcome,
  type Contender,
  type MetricUnit,
} from './pool'

export { MEANINGFUL }

export interface Entry {
  scenario: ComparisonScenario
  state: ResultState | undefined
  result: CompareResult | null // set only when state is done AND status is ok
  offsetHours: number // where this scenario's landing sits on the shared time axis
  /** Canonical ranking info, only when it belongs to the currently selected set (null while re-ranking). */
  ranking: RankingInfo | null
}

/** Canonical eligibility: from the ranking, else from the viability result; null = not assessed. */
export function eligibilityOf(e: Entry): Eligibility | null {
  if (e.ranking) return e.ranking.eligibility
  const v = e.result?.viability
  return v ? verdictOf(v) : null
}

function mergeAssessmentMargins(
  hr: OperationalHeadroom,
  margins: CanonicalMarginItem[] | undefined,
): OperationalHeadroom {
  if (!margins?.length) return hr
  const byId = new Map(margins.map((m) => [m.id, m]))
  const constraints = hr.constraints.map((c) => byId.get(c.id) ?? c)
  for (const m of margins) {
    if (!constraints.some((c) => c.id === m.id)) constraints.push(m)
  }
  const darkness = byId.get('max_continuous_darkness') ?? hr.darkness
  const communication_blackout = byId.get('max_communication_blackout') ?? hr.communication_blackout
  return { ...hr, darkness, communication_blackout, constraints }
}

/** Resolve canonical operational headroom from assessment/viability, falling back to client derivation when absent. */
export function headroomOfResult(r: CompareResult | null | undefined): OperationalHeadroom | null {
  if (!r) return null
  if (r.assessment?.headroom) return mergeAssessmentMargins(r.assessment.headroom, r.assessment.margins)
  if (r.viability?.headroom) return mergeAssessmentMargins(r.viability.headroom, r.assessment?.margins)
  if (r.viability) return mergeAssessmentMargins(resolveHeadroom(r.viability), r.assessment?.margins)
  return null
}

/** Entry-aware headroom lookup that honours synthetic ranking overrides in tests when canonical headroom is absent. */
export function headroomOfEntry(e: Entry): OperationalHeadroom | null {
  const r = e.result
  if (!r) return null
  if (r.assessment?.headroom) return mergeAssessmentMargins(r.assessment.headroom, r.assessment.margins)
  if (r.viability?.headroom) return mergeAssessmentMargins(r.viability.headroom, r.assessment?.margins)
  if (r.viability) {
    if (e.ranking && e.ranking.eligibility !== verdictOf(r.viability)) {
      return mergeAssessmentMargins(
        resolveHeadroom({
          ...r.viability,
          eligibility: e.ranking.eligibility,
          passes: e.ranking.eligibility === 'pass',
        }),
        r.assessment?.margins,
      )
    }
    return mergeAssessmentMargins(resolveHeadroom(r.viability), r.assessment?.margins)
  }
  return null
}

export const isLimitedHeadroom = (hr: OperationalHeadroom | null | undefined): boolean =>
  hr?.status === 'limited' || hr?.status === 'at_threshold'

export function qualifiedPassClause(hr: OperationalHeadroom): string {
  const base = hr.qualified_verdict.charAt(0).toLowerCase() + hr.qualified_verdict.slice(1)
  const closest = hr.closest_constraint ? ` (closest requirement to limit: ${hr.closest_constraint.summary_text})` : ''
  return `${base}${closest}`
}

export const ELIGIBILITY_LABEL: Record<Eligibility, string> = {
  pass: 'Passes',
  fail: 'Fails',
  unknown: 'Cannot be decided',
}

/** Score as the engine reports it. Never prints a bound alone and never prints 0 for a missing score. */
export function scoreText(r: RankingInfo | null | undefined, fallback?: number | null): string {
  if (!r) return fallback === null || fallback === undefined ? '—' : fallback.toFixed(1)
  switch (r.score_status) {
    case 'known':
      return r.score === null ? '—' : r.score.toFixed(1)
    case 'bounded':
      return r.score_lower !== null && r.score_upper !== null
        ? `between ${r.score_lower.toFixed(1)} and ${r.score_upper.toFixed(1)}`
        : 'bounded (range unavailable)'
    case 'eligibility_unknown':
      return 'not scored: eligibility unknown'
    case 'no_scorable_components':
      return 'not scored: no active score component'
    default:
      return r.score === null ? '—' : r.score.toFixed(1)
  }
}

/** A canonical metric by key (backend compare/evidence.py METRIC_FIELDS), or null when not reported. */
export const cm = (r: CompareResult | null | undefined, key: string): CanonicalMetric | null => r?.assessment?.metrics[key] ?? null

/** Exact value of a canonical metric, or null when it is bounded or unavailable (never a guessed number). */
export const knownValue = (m: CanonicalMetric | null): number | null => (m && m.status === 'known' ? m.value : null)

/**
 * A requirement margin from a canonical metric: `sign` = +1 for "at least" requirements (value - required),
 * -1 for "at most" limits (limit - value). Bounded metrics give a margin range; unavailable gives none.
 */
export function marginOf(m: CanonicalMetric | null, required: number, sign: 1 | -1, scale = 1):
  { value: number | null; lower: number | null; upper: number | null; status: CanonicalMetric['status'] | 'missing' } {
  if (!m) return { value: null, lower: null, upper: null, status: 'missing' }
  const f = (v: number) => sign * (v * scale - required * scale)
  if (m.status === 'known' && m.value !== null) return { value: f(m.value), lower: null, upper: null, status: 'known' }
  if (m.status === 'bounded' && m.lower !== null && m.upper !== null) {
    const a = f(m.lower), b = f(m.upper)
    return { value: null, lower: Math.min(a, b), upper: Math.max(a, b), status: 'bounded' }
  }
  return { value: null, lower: null, upper: null, status: m.status }
}

/** Text for a canonical value or margin that is not an exact number. Null when it is exact. */
export function inexactText(x: { status: string; lower: number | null; upper: number | null; reason?: string | null }, unit: MetricDef['unit']): string | null {
  if (x.status === 'known') return null
  if (x.status === 'bounded' && x.lower !== null && x.upper !== null) return `between ${fmtMetric(x.lower, unit)} and ${fmtMetric(x.upper, unit)}`
  if (x.status === 'not_applicable') return 'not applicable'
  if (x.status === 'missing') return '—'
  return 'unavailable'
}

/**
 * The engine states durations in seconds (e.g. "evaluated duration (1.2096e+06 s vs 432000 s)"). Show them in
 * days or hours; only the unit changes, never the value or the claim.
 */
export function humanizeSeconds(text: string): string {
  return text.replace(/(\d+(?:\.\d+)?(?:e[+-]?\d+)?) s\b/gi, (_, n: string) => {
    const sec = Number(n)
    if (!Number.isFinite(sec)) return `${n} s`
    const h = sec / 3600
    return h >= 48 ? `${+(h / 24).toFixed(2)} d` : `${+h.toFixed(2)} h`
  })
}

/** Number of distinct canonical ranking groups among the entries. */
export const groupCountOf = (entries: Entry[]) => new Set(entries.map((e) => e.ranking?.group).filter(Boolean)).size

/**
 * Rank text scoped to its group, e.g. "#1 of 3", or "only passing option in separate group G2" when nothing
 * else in its group passed (a "#1 of 1" would suggest it beat alternatives). Null without a rank.
 */
export function rankText(r: RankingInfo | null | undefined, groupCount: number): string | null {
  if (!r || r.rank === null) return null
  const base = r.ranked_in_group > 1 ? `#${r.rank} of ${r.ranked_in_group}` : 'only passing option'
  return groupCount > 1 && r.group !== 'G1' ? `${base} in separate group ${r.group}` : base
}

export type Better = 'higher' | 'lower' | null
export type Provenance = 'measured' | 'derived' | 'idealized' | 'viability' | 'config'

export interface MetricDef {
  id: string
  group: 'solar' | 'power' | 'earth' | 'mission'
  label: string
  unit: MetricUnit
  better: Better
  provenance: Provenance
  get: (r: CompareResult, s: ComparisonScenario) => number | null
  /** Optional text override (e.g. a bounded score), shown instead of fmtMetric(get(...)). */
  text?: (r: CompareResult, s: ComparisonScenario) => string | null
  /**
   * How this metric competes for "best" (pool.ts): an exact value, a proven range, or none. Default: get()'s exact
   * value, else none. Metrics with engine bounds say so here, so a bound can block a lead it might hide.
   */
  contender?: (r: CompareResult, s: ComparisonScenario) => Contender
  hint?: string
}

/** A margin (marginOf) as a contender: exact, its proven range, or none. */
const marginContender = (x: ReturnType<typeof marginOf>): Contender =>
  x.status === 'known' ? exact(x.value) : x.status === 'bounded' && x.lower !== null && x.upper !== null ? { kind: 'range', lower: x.lower, upper: x.upper } : { kind: 'none' }

const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : v * 100)

function initialWindowMetric(r: CompareResult, kind: 'sunlight' | 'earth'): CanonicalMetric | null {
  const key = kind === 'sunlight' ? 'initial_sunlight_h' : 'initial_earth_h'
  const m = cm(r, key)
  if (m) return m
  const raw = kind === 'sunlight' ? r.viability?.metrics.initial_sun_hours : r.viability?.metrics.initial_comms_hours
  if (raw === undefined || raw === null) return null
  return { status: 'known', unit: 'h', value: raw, lower: null, upper: null, reason: null }
}

function firstEndMetric(r: CompareResult, kind: 'sunlight' | 'earth'): CanonicalMetric | null {
  const key = kind === 'sunlight' ? 'time_to_first_sunset_h' : 'time_to_first_earthset_h'
  const m = cm(r, key)
  if (m) return m
  const hr = headroomOfResult(r)
  const hrEnd = kind === 'sunlight' ? hr?.initial_sunlight.first_end_hours : hr?.initial_earth.first_end_hours
  if (hrEnd) {
    return {
      status: hrEnd.status,
      unit: hrEnd.unit,
      value: hrEnd.value ?? null,
      lower: hrEnd.lower ?? null,
      upper: hrEnd.upper ?? null,
      reason: hrEnd.reason ?? null,
    }
  }
  const raw = kind === 'sunlight' ? r.viability?.metrics.hours_to_first_sunset : r.viability?.metrics.hours_to_first_earthset
  if (raw === undefined) return null
  if (raw === null) return { status: 'not_applicable', unit: 'h', value: null, lower: null, upper: null, reason: null }
  return { status: 'known', unit: 'h', value: raw, lower: null, upper: null, reason: null }
}

function firstEndText(r: CompareResult, kind: 'sunlight' | 'earth'): string | null {
  const m = firstEndMetric(r, kind)
  if (!m) return null
  if (m.status === 'known') return null
  if (m.status === 'not_applicable') {
    const initVal = knownValue(initialWindowMetric(r, kind))
    if (kind === 'sunlight') return initVal !== null && initVal <= 0 ? 'Starts dark (no sunset)' : 'Stays lit (no sunset)'
    return initVal !== null && initVal <= 0 ? 'Starts without contact (no Earthset)' : 'Stays in contact (no Earthset)'
  }
  return inexactText(m, 'h')
}

export const METRICS: MetricDef[] = [
  // ---- solar (from Horizons + LOLA timelines)
  { id: 'sunlit_hours', group: 'solar', label: 'Total sunlight', unit: 'h', better: 'higher', provenance: 'derived',
    get: (r) => r.solar?.sunlit_hours ?? null, hint: 'Hours with any part of the solar disk above the local terrain.' },
  { id: 'sunlit_pct', group: 'solar', label: 'Mission illuminated', unit: '%', better: 'higher', provenance: 'derived',
    get: (r) => pct(r.solar?.sunlit_fraction) },
  { id: 'mean_disk', group: 'solar', label: 'Mean visible solar disk', unit: '%', better: 'higher', provenance: 'derived',
    get: (r) => pct(r.solar?.mean_visible_fraction), hint: 'Average share of the Sun’s disk above the terrain (partial Sun counts partially).' },
  { id: 'sun_el_mean', group: 'solar', label: 'Average solar elevation', unit: 'deg', better: null, provenance: 'measured',
    get: (r) => r.solar?.mean_elevation_deg ?? null },
  { id: 'sun_el_max', group: 'solar', label: 'Maximum solar elevation', unit: 'deg', better: null, provenance: 'measured',
    get: (r) => r.solar?.max_elevation_deg ?? null },
  { id: 'sun_el_min_lit', group: 'solar', label: 'Minimum solar elevation while lit', unit: 'deg', better: null,
    provenance: 'measured', get: (r) => r.solar?.min_elevation_lit_deg ?? null },
  { id: 'sun_clear', group: 'solar', label: 'Mean Sun clearance above terrain (lit)', unit: 'deg', better: 'higher',
    provenance: 'derived', get: (r) => r.solar?.mean_clearance_lit_deg ?? null,
    hint: 'How far the Sun sits above the local terrain horizon. Small values mean terrain is close to blocking it.' },
  { id: 'dark_longest', group: 'solar', label: 'Longest continuous darkness', unit: 'h', better: 'lower', provenance: 'derived',
    get: (r) => r.solar?.longest_dark_hours ?? null, hint: 'Geometric: no part of the solar disk visible.' },
  { id: 'sun_windows', group: 'solar', label: 'Sunlight windows', unit: 'count', better: null, provenance: 'derived',
    get: (r) => r.solar?.windows_count ?? null },
  { id: 'initial_sun_hours', group: 'solar', label: 'Initial illumination (from landing)', unit: 'h', better: 'higher', provenance: 'derived',
    get: (r) => knownValue(initialWindowMetric(r, 'sunlight')),
    contender: (r) => contenderOf(initialWindowMetric(r, 'sunlight')),
    text: (r) => {
      const m = initialWindowMetric(r, 'sunlight')
      return m ? inexactText(m, 'h') : null
    },
    hint: 'Continuous power-lit duration right after landing.' },
  { id: 'time_to_first_sunset_h', group: 'solar', label: 'Time to first sunset', unit: 'h', better: 'higher', provenance: 'derived',
    get: (r) => knownValue(firstEndMetric(r, 'sunlight')),
    contender: (r) => contenderOf(firstEndMetric(r, 'sunlight')),
    text: (r) => firstEndText(r, 'sunlight'),
    hint: 'Hours after landing until the first lit-to-dark transition (first sunset).' },
  // ---- idealised power
  { id: 'incidence', group: 'power', label: 'Mean incidence factor', unit: 'factor', better: 'higher', provenance: 'idealized',
    get: (r) => r.power?.mean_incidence_factor ?? null, hint: 'visible disk × max(0, cos θ). 1 = full Sun on the panel face.' },
  { id: 'eq_hours', group: 'power', label: 'Equivalent full-power hours', unit: 'h', better: 'higher', provenance: 'idealized',
    get: (r) => r.power?.equivalent_full_power_hours ?? null },
  { id: 'p_mean', group: 'power', label: 'Idealised mean power ceiling', unit: 'W', better: 'higher', provenance: 'idealized',
    get: (r) => r.power?.idealized_mean_power_w ?? null },
  { id: 'e_ratio', group: 'power', label: 'Idealised energy ÷ load', unit: 'x', better: 'higher', provenance: 'idealized',
    get: (r) => r.power?.idealized_energy_to_load_ratio ?? null, hint: 'Above 1 means the ideal ceiling covers the load; real output is lower.' },
  { id: 'endurance', group: 'power', label: 'Battery endurance (capacity ÷ load)', unit: 'h', better: null, provenance: 'config',
    get: (r) => r.power?.battery_endurance_hours ?? null },
  // ---- Earth (geometric line of sight)
  { id: 'earth_hours', group: 'earth', label: 'Earth visibility', unit: 'h', better: 'higher', provenance: 'derived',
    get: (r) => r.earth?.visible_hours ?? null },
  { id: 'earth_pct', group: 'earth', label: 'Mission with Earth in view', unit: '%', better: 'higher', provenance: 'derived',
    get: (r) => pct(r.earth?.visible_fraction) },
  { id: 'blackout_longest', group: 'earth', label: 'Longest communication blackout', unit: 'h', better: 'lower',
    provenance: 'derived', get: (r) => r.earth?.longest_blackout_hours ?? null },
  { id: 'earth_windows', group: 'earth', label: 'Communication windows', unit: 'count', better: null, provenance: 'derived',
    get: (r) => r.earth?.windows_count ?? null },
  { id: 'earth_el_mean', group: 'earth', label: 'Mean Earth elevation (visible)', unit: 'deg', better: 'higher',
    provenance: 'measured', get: (r) => r.earth?.mean_elevation_visible_deg ?? null },
  { id: 'earth_el_min', group: 'earth', label: 'Minimum Earth elevation (visible)', unit: 'deg', better: 'higher',
    provenance: 'measured', get: (r) => r.earth?.min_elevation_visible_deg ?? null },
  { id: 'earth_margin_min', group: 'earth', label: 'Minimum Earth margin above terrain', unit: 'deg', better: 'higher',
    provenance: 'derived', get: (r) => r.earth?.min_margin_visible_deg ?? null,
    hint: 'Smallest clearance between Earth and the terrain while in view. Near 0° = marginal line of sight.' },
  { id: 'initial_comms_hours', group: 'earth', label: 'Initial Earth contact (from landing)', unit: 'h', better: 'higher', provenance: 'derived',
    get: (r) => knownValue(initialWindowMetric(r, 'earth')),
    contender: (r) => contenderOf(initialWindowMetric(r, 'earth')),
    text: (r) => {
      const m = initialWindowMetric(r, 'earth')
      return m ? inexactText(m, 'h') : null
    },
    hint: 'Continuous Earth line-of-sight duration right after landing.' },
  { id: 'time_to_first_earthset_h', group: 'earth', label: 'Time to first Earthset', unit: 'h', better: 'higher', provenance: 'derived',
    get: (r) => knownValue(firstEndMetric(r, 'earth')),
    contender: (r) => contenderOf(firstEndMetric(r, 'earth')),
    text: (r) => firstEndText(r, 'earth'),
    hint: 'Hours after landing until the first Earth line-of-sight loss (first Earthset).' },
  // ---- mission performance (team viability evaluator)
  // Score: the canonical ranking already orders by it (with bounds and tie-breaks), so it is not marked "best" here.
  { id: 'score', group: 'mission', label: 'Desirability score', unit: 'score', better: null, provenance: 'viability',
    get: (r) => r.ranking?.score ?? r.viability?.score ?? null, text: (r) => scoreText(r.ranking, r.viability?.score),
    hint: 'Relative index of illumination and line-of-sight geometry under the engine’s weights. Not a probability of success.' },
  { id: 'violations', group: 'mission', label: 'Failed requirements', unit: 'count', better: 'lower', provenance: 'viability',
    get: (r) => (r.viability ? r.viability.violations.filter((v) => !v.is_unknown).length : null) },
  { id: 'undecided', group: 'mission', label: 'Undecided requirements (missing data)', unit: 'count', better: 'lower',
    provenance: 'viability', get: (r) => (r.viability ? r.viability.violations.filter((v) => v.is_unknown).length : null),
    hint: 'Requirements the engine could not decide from the data. Not failures.' },
  // Margins use the engine's own metric states: an exact margin when the metric is known, a margin range when it is
  // only bounded, and "unavailable" otherwise. (The shared ViabilityResult reports unknown metrics at their worst
  // bound; those numbers are never shown here as measurements.)
  { id: 'solar_margin', group: 'mission', label: 'Solar margin', unit: 'pts', better: 'higher', provenance: 'viability',
    get: (r, s) => marginOf(cm(r, 'mean_solar_disk_fraction'), s.requirements.min_sunlight_fraction, 1, 100).value,
    contender: (r, s) => marginContender(marginOf(cm(r, 'mean_solar_disk_fraction'), s.requirements.min_sunlight_fraction, 1, 100)),
    text: (r, s) => inexactText(marginOf(cm(r, 'mean_solar_disk_fraction'), s.requirements.min_sunlight_fraction, 1, 100), 'pts'),
    hint: 'Mean visible solar disk minus the required minimum.' },
  { id: 'battery_margin', group: 'mission', label: 'Battery margin', unit: 'h', better: 'higher', provenance: 'viability',
    get: (r, s) => marginOf(cm(r, 'longest_power_darkness_h'), s.requirements.battery_hours, -1).value,
    contender: (r, s) => marginContender(marginOf(cm(r, 'longest_power_darkness_h'), s.requirements.battery_hours, -1)),
    text: (r, s) => inexactText(marginOf(cm(r, 'longest_power_darkness_h'), s.requirements.battery_hours, -1), 'h'),
    hint: 'Max acceptable darkness minus the longest power gap (Sun below the panel threshold).' },
  { id: 'comms_margin', group: 'mission', label: 'Communication margin', unit: 'h', better: 'higher', provenance: 'viability',
    get: (r, s) => marginOf(cm(r, 'longest_blackout_h'), s.requirements.max_comms_gap_hours, -1).value,
    contender: (r, s) => marginContender(marginOf(cm(r, 'longest_blackout_h'), s.requirements.max_comms_gap_hours, -1)),
    text: (r, s) => inexactText(marginOf(cm(r, 'longest_blackout_h'), s.requirements.max_comms_gap_hours, -1), 'h'),
    hint: 'Max acceptable blackout minus the longest blackout.' },
  { id: 'earth_margin', group: 'mission', label: 'Earth-visibility margin', unit: 'pts', better: 'higher', provenance: 'viability',
    get: (r, s) => marginOf(cm(r, 'earth_visible_percent'), s.requirements.min_earth_visibility_fraction * 100, 1).value,
    contender: (r, s) => marginContender(marginOf(cm(r, 'earth_visible_percent'), s.requirements.min_earth_visibility_fraction * 100, 1)),
    text: (r, s) => inexactText(marginOf(cm(r, 'earth_visible_percent'), s.requirements.min_earth_visibility_fraction * 100, 1), 'pts') },
  { id: 'coverage', group: 'mission', label: 'Data coverage (Sun / Earth)', unit: '%', better: null, provenance: 'viability',
    get: (r) => (r.assessment ? Math.min(r.assessment.sun_coverage_percent, r.assessment.earth_coverage_percent) : null),
    text: (r) => (r.assessment ? `${r.assessment.sun_coverage_percent.toFixed(1)}% / ${r.assessment.earth_coverage_percent.toFixed(1)}%` : null),
    hint: 'Share of the mission with a known Sun / Earth state. Below 100% the engine reports bounds, not exact values.' },
  { id: 'risk', group: 'mission', label: 'Overall risk', unit: 'count', better: null, provenance: 'viability',
    get: () => null, text: (r) => r.assessment?.overall_risk ?? null,
    hint: 'Rule-based risk level from the viability engine (low, moderate, high, unknown). Not a probability.' },
]

export const METRIC_BY_ID = Object.fromEntries(METRICS.map((m) => [m.id, m])) as Record<string, MetricDef>

export function fmtMetric(v: number | null | undefined, unit: MetricDef['unit']): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  switch (unit) {
    case 'h':
      return Math.abs(v) >= 72 ? `${Math.round(v)} h (${(v / 24).toFixed(1)} d)` : `${Math.round(v * 10) / 10} h`
    case '%':
      return `${v.toFixed(1)}%`
    case 'deg':
      return `${v.toFixed(2)}°`
    case 'W':
      return `${Math.round(v)} W`
    case 'x':
      return `${v.toFixed(2)}×`
    case 'pts':
      return `${v >= 0 ? '+' : ''}${v.toFixed(1)} pts`
    case 'score':
      return v.toFixed(1)
    case 'factor':
      return v.toFixed(3)
    default:
      return String(Math.round(v))
  }
}

export function fmtDeltaValue(d: number, unit: MetricDef['unit']): string {
  if (Math.abs(d) < 1e-9) return 'no change'
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±'
  const a = Math.abs(d)
  switch (unit) {
    case 'h':
      return `${sign}${Math.round(a * 10) / 10} h`
    case '%':
    case 'pts':
      return `${sign}${a.toFixed(1)} pts`
    case 'deg':
      return `${sign}${a.toFixed(2)}°`
    case 'W':
      return `${sign}${Math.round(a)} W`
    case 'x':
      return `${sign}${a.toFixed(2)}×`
    case 'factor':
      return `${sign}${a.toFixed(3)}`
    default:
      return `${sign}${a.toFixed(a < 10 ? 1 : 0)}`
  }
}

// ---------------------------------------------------------------- which results compare fairly

export const okEntries = (entries: Entry[]) => entries.filter((e) => e.result)

/**
 * The scenarios that may be compared with each other: real results only when any exist, otherwise demonstration
 * results only (never mixed; team rule from docs/interfaces.md). Same pool as every "best" mark (pool.ts).
 */
export const comparableEntries = (entries: Entry[]): Entry[] => comparisonPool(entries).members

export const isMeaningful = (m: MetricDef, a: number, b: number) => isMeaningfulDiff(m.unit, a, b)

/** How one scenario competes on a metric (MetricDef.contender, else get()'s exact value). */
export const metricContender = (m: MetricDef, e: Entry): Contender =>
  !e.result ? { kind: 'none' } : m.contender ? m.contender(e.result, e.scenario) : exact(m.get(e.result, e.scenario))

/** The fair "best" outcome for a metric (pool.ts rules), with the reason when there is none. */
export const bestOutcome = (entries: Entry[], m: MetricDef): BestOutcome =>
  pickBest(comparisonPool(entries), (e) => metricContender(m, e), m.better, m.unit)

/**
 * Scenario(s) fairly best on a metric (pool.ts): real and demonstration results never compete; every pool member
 * counts (an unavailable value means no winner); a bound blocks a lead it could hide; the lead must be meaningful.
 */
export const bestIds = (entries: Entry[], m: MetricDef): Set<string> => bestOutcome(entries, m).ids

export interface Delta {
  value: number
  better: boolean | null // null = no preferred direction, no change, or a difference too small to matter
  meaningful: boolean
}

export function deltaVsBaseline(m: MetricDef, e: Entry, base: Entry | undefined): Delta | null {
  if (!base || base.scenario.id === e.scenario.id || !e.result || !base.result) return null
  const a = m.get(e.result, e.scenario)
  const b = m.get(base.result, base.scenario)
  if (a === null || b === null) return null
  const d = a - b
  const meaningful = isMeaningful(m, a, b)
  if (Math.abs(d) < 1e-9 || !m.better || !meaningful) return { value: d, better: null, meaningful }
  return { value: d, better: m.better === 'higher' ? d > 0 : d < 0, meaningful }
}

// ---------------------------------------------------------------- mission requirements (engine verdicts)

export type ReqStatus = ConstraintItem['status']

export interface ResolvedConstraintMargin {
  margin: MarginMetricValue
  marginClass: MarginStatus
  narrowReason: string | null
}

function round4(n: number): number {
  const x = Number(n.toFixed(4))
  return x === 0 ? 0 : x
}

function classifyFallbackMarginValues(
  least: number,
  most: number,
  threshold: number,
  unit: string,
  status: ConstraintItem['status'],
): { marginClass: MarginStatus; narrowReason: string | null } {
  if (most < 0 || status === 'fail') return { marginClass: 'negative', narrowReason: null }
  if (least < 0 || status === 'unknown') return { marginClass: 'uncertain', narrowReason: null }
  if (least === 0) {
    return { marginClass: 'at_threshold', narrowReason: 'Zero margin remaining at the requirement boundary.' }
  }
  const rel = threshold > 0 ? least / threshold : null
  const reasons: string[] = []
  if (rel !== null && rel <= NARROW_MARGIN_FRACTION) {
    reasons.push(`Headroom is ${(rel * 100).toFixed(1)}% of the limit (<= ${(NARROW_MARGIN_FRACTION * 100).toFixed(0)}%).`)
  }
  if (unit === 'h' && least < SAMPLE_RESOLUTION_H) {
    reasons.push(`Remaining margin is smaller than the ${SAMPLE_RESOLUTION_H} h sampling interval.`)
  }
  if (reasons.length > 0) return { marginClass: 'narrow', narrowReason: reasons.join(' ') }
  return { marginClass: 'comfortable', narrowReason: null }
}

export function findCanonicalMargin(r: CompareResult | null | undefined, id: string): CanonicalMarginItem | null {
  if (!r) return null
  return (
    r.assessment?.margins?.find((m) => m.id === id) ??
    r.assessment?.headroom?.constraints?.find((m) => m.id === id) ??
    r.viability?.headroom?.constraints?.find((m) => m.id === id) ??
    null
  )
}

/** Canonical margin for a constraint, falling back cleanly to requirement arithmetic when assessment.margins is absent. */
export function constraintMargin(r: CompareResult | null | undefined, c: ConstraintItem): ResolvedConstraintMargin {
  const canonical = findCanonicalMargin(r, c.id)
  if (canonical) {
    return {
      margin: canonical.margin,
      marginClass: canonical.margin_class,
      narrowReason: canonical.narrow_reason ?? null,
    }
  }
  const unit = c.measured.unit
  if (
    c.status === 'not_applicable' ||
    c.measured.status === 'not_applicable' ||
    c.threshold === null ||
    c.threshold === undefined ||
    !c.comparison
  ) {
    return { margin: { status: 'not_applicable', unit }, marginClass: 'not_applicable', narrowReason: null }
  }
  if (c.measured.status === 'unavailable') {
    return {
      margin: { status: 'unavailable', unit, reason: c.measured.reason },
      marginClass: c.unknown_reason === 'unsupported' ? 'unsupported' : 'uncertain',
      narrowReason: null,
    }
  }
  const t = c.threshold
  if (c.measured.status === 'bounded' && c.measured.lower !== null && c.measured.upper !== null) {
    const a = c.comparison === 'at_most' ? t - c.measured.upper : c.measured.lower - t
    const b = c.comparison === 'at_most' ? t - c.measured.lower : c.measured.upper - t
    const lo = round4(Math.min(a, b))
    const hi = round4(Math.max(a, b))
    return {
      margin: { status: 'bounded', unit, value: null, lower: lo, upper: hi, reason: c.measured.reason },
      ...classifyFallbackMarginValues(lo, hi, t, unit, c.status),
    }
  }
  if (c.measured.status === 'known' && c.measured.value !== null) {
    const raw = c.comparison === 'at_most' ? t - c.measured.value : c.measured.value - t
    const val = round4(raw)
    return {
      margin: { status: 'known', unit, value: val },
      ...classifyFallbackMarginValues(val, val, t, unit, c.status),
    }
  }
  return {
    margin: { status: 'unavailable', unit, reason: c.measured.reason },
    marginClass: 'uncertain',
    narrowReason: null,
  }
}

export function constraintMarginById(r: CompareResult | null | undefined, id: string): ResolvedConstraintMargin | null {
  const c = r?.assessment?.constraints.find((x) => x.id === id)
  if (c) return constraintMargin(r, c)
  const m = findCanonicalMargin(r, id) ?? headroomOfResult(r)?.constraints.find((x) => x.id === id) ?? null
  return m ? { margin: m.margin, marginClass: m.margin_class, narrowReason: m.narrow_reason ?? null } : null
}

export interface RequirementCell {
  status: ReqStatus
  measured: string // engine's measured value in display units (exact, range or unavailable)
  threshold: string | null // e.g. "≤ 100 h"
  message: string
  margin: MarginMetricValue
  marginClass: MarginStatus
  narrowReason: string | null
}

export interface RequirementRow {
  id: string
  name: string
  cells: Record<string, RequirementCell | null> // by scenario id; null = no assessment for that scenario
}

/** Display a canonical measurement in its unit; fractions are shown as percentages. */
export function measuredText(m: CanonicalMetric): string {
  const asPct = m.unit === 'fraction'
  const unit: MetricDef['unit'] = asPct || m.unit === '%' ? '%' : m.unit === 'h' ? 'h' : 'deg'
  const k = asPct ? 100 : 1
  if (m.status === 'known' && m.value !== null) return fmtMetric(m.value * k, unit)
  if (m.status === 'bounded' && m.lower !== null && m.upper !== null) return `between ${fmtMetric(m.lower * k, unit)} and ${fmtMetric(m.upper * k, unit)}`
  return m.status === 'not_applicable' ? 'not applicable' : 'unavailable'
}

function thresholdText(c: ConstraintItem): string | null {
  if (c.threshold === null) return null
  const op = c.comparison === 'at_most' ? '≤' : '≥'
  return `${op} ${measuredText({ ...c.measured, status: 'known', value: c.threshold, lower: null, upper: null })}`
}

/**
 * Every mission requirement the engine checked for any compared scenario, with each scenario's verdict. Rows that
 * are not applicable to any scenario are left out. Statuses and values are the engine's, never recomputed here.
 */
export function requirementMatrix(entries: Entry[]): RequirementRow[] {
  const rows = new Map<string, RequirementRow>()
  for (const e of entries) {
    for (const c of e.result?.assessment?.constraints ?? []) {
      if (!rows.has(c.id)) rows.set(c.id, { id: c.id, name: c.name ?? c.id, cells: {} })
    }
  }
  for (const row of rows.values()) {
    for (const e of entries) {
      const c = e.result?.assessment?.constraints.find((x) => x.id === row.id)
      row.cells[e.scenario.id] = c
        ? {
            status: c.status,
            measured: measuredText(c.measured),
            threshold: thresholdText(c),
            message: c.message,
            ...constraintMargin(e.result, c),
          }
        : null
    }
  }
  return [...rows.values()].filter((r) => Object.values(r.cells).some((c) => c && c.status !== 'not_applicable'))
}

export interface RequirementSummary {
  applicable: number
  passed: number
  failed: { id: string; name: string }[]
  undecided: { id: string; name: string }[]
}

export function requirementSummary(e: Entry): RequirementSummary | null {
  const cs = e.result?.assessment?.constraints
  if (!cs) return null
  const app = cs.filter((c) => c.status !== 'not_applicable')
  const pick = (st: ReqStatus) => app.filter((c) => c.status === st).map((c) => ({ id: c.id, name: c.name ?? c.id }))
  return { applicable: app.length, passed: pick('pass').length, failed: pick('fail'), undecided: pick('unknown') }
}

// ---------------------------------------------------------------- requirement evidence on the timeline

export interface ViolationWindow {
  constraintId: string
  name: string
  status: 'fail' | 'unknown'
  lane: 'sun' | 'earth'
  start_hour: number
  end_hour: number
  duration_hours: number
  start_utc: string
  end_utc: string
  text: string // e.g. "Fails Maximum continuous power-darkness: 107 h window (required ≤ 100 h)"
}

/**
 * Windows the engine cites as evidence for a failed or undecided requirement, placed on the Sun or Earth lane.
 * Taken verbatim from the canonical assessment; nothing is detected or measured here.
 */
export function violationWindows(r: CompareResult | null | undefined): ViolationWindow[] {
  const out: ViolationWindow[] = []
  for (const c of r?.assessment?.constraints ?? []) {
    if (c.status !== 'fail' && c.status !== 'unknown') continue
    const threshold = thresholdText(c)
    for (const w of c.evidence_windows) {
      const lane = /earth|communication/.test(w.kind) ? 'earth' : 'sun'
      const name = c.name ?? c.id
      const verb = c.status === 'fail' ? 'Fails' : 'Cannot decide'
      out.push({
        constraintId: c.id, name, status: c.status, lane, start_hour: w.start_hour, end_hour: w.end_hour,
        duration_hours: w.duration_hours, start_utc: w.start_utc, end_utc: w.end_utc,
        text: `${verb} ${name}: ${fmtMetric(w.duration_hours, 'h')} ${w.kind.replace(/_/g, ' ')} window${w.clipped_at_start ? ' (already in progress at landing)' : ''}${threshold ? ` (required ${threshold})` : ''}`,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------- canonical ranking (viability engine)

export interface GroupView {
  group: RankingGroup
  ranked: Entry[] // PASS, in canonical rank order
  unknown: Entry[] // eligibility UNKNOWN: never ranked
  failed: Entry[] // eligibility FAIL: never ranked
}

/**
 * The backend's canonical ranking mapped onto the displayed entries. Nothing is re-sorted or re-ranked here:
 * group membership and order come from the response. Entries without an assessment are returned separately.
 */
export function canonicalRanking(entries: Entry[], groups: RankingGroup[]): { groups: GroupView[]; unassessed: Entry[] } {
  const byKey = new Map(entries.filter((e) => e.result && e.ranking).map((e) => [e.result!.key, e]))
  const seen = new Set<Entry>()
  const views = groups.map((group) => {
    const members = group.keys.map((k) => byKey.get(k)).filter((e): e is Entry => !!e)
    members.forEach((e) => seen.add(e))
    return {
      group,
      ranked: members.filter((e) => e.ranking!.rank !== null),
      unknown: members.filter((e) => e.ranking!.eligibility === 'unknown'),
      failed: members.filter((e) => e.ranking!.eligibility === 'fail'),
    }
  })
  return { groups: views, unassessed: entries.filter((e) => !seen.has(e)) }
}

// ---------------------------------------------------------------- trade-off (user preferences)

export interface Weights {
  solar: number
  comms: number
  science: number
  safety: number
}

export const WEIGHT_PRESETS: Record<string, { label: string; weights: Weights }> = {
  balanced: { label: 'Balanced', weights: { solar: 1, comms: 1, science: 1, safety: 1 } },
  engineering: { label: 'Engineering first', weights: { solar: 3, comms: 3, science: 0.5, safety: 3 } },
  science: { label: 'Science first', weights: { solar: 1, comms: 1, science: 4, safety: 1.5 } },
  power: { label: 'Power-constrained', weights: { solar: 4, comms: 1, science: 0.5, safety: 2 } },
}

export const CRITERIA = [
  { key: 'solar', label: 'Solar availability', basis: 'Mean visible solar disk (Horizons + LOLA)' },
  { key: 'comms', label: 'Earth communication', basis: 'Share of mission with Earth in line of sight' },
  { key: 'science', label: 'Science site value', basis: 'Demonstration estimate: proximity to the nearest catalog PSR' },
  { key: 'safety', label: 'Operational safety', basis: 'How the longest power gap and blackout fit the lander’s limits' },
] as const

export type CriterionKey = (typeof CRITERIA)[number]['key']

/** Outage index: 1 with no outage, 0.5 at exactly the limit, 0 at twice the limit or more. */
export const outageIndex = (gapHours: number, limitHours: number) =>
  limitHours > 0 ? Math.min(1, Math.max(0, 1 - gapHours / (2 * limitHours))) : 0

/** Same definition Mission Rescue's compromise uses: 1 − distance to PSR edge ÷ max traverse. */
export const scienceIndex = (distanceKm: number, traverseKm: number) =>
  traverseKm > 0 ? Math.max(0, 1 - distanceKm / traverseKm) : 0

export interface TradeoffRow {
  entry: Entry
  /** Canonical eligibility. Only PASS rows can be preference-ranked: weights explain, they never make an option feasible. */
  eligibility: Eligibility | null
  /** For rows that aren't feasible: the requirements that fail (or can't be decided), by name. */
  blockers: string[]
  scores: Record<CriterionKey, number | null> // null = the measurement behind it is not exactly known
  raw: Record<CriterionKey, string>
  weighted: number | null // null when any weighted criterion is unknown: such rows are never ranked
  contributions: Record<CriterionKey, number | null>
  rank: number | null // preference rank among feasible (PASS) rows with complete data; null otherwise
  missing: string[] // criteria that could not be computed, with the reason
}

/** Feasible = the viability engine says it meets every requirement. */
export const isFeasible = (r: TradeoffRow) => r.eligibility === 'pass'

/** The requirements standing between an option and feasibility, by name (empty for PASS). */
function blockersOf(e: Entry, eligibility: Eligibility | null): string[] {
  if (eligibility === 'pass') return []
  const req = requirementSummary(e)
  if (eligibility === 'fail') return req?.failed.map((c) => c.name) ?? []
  if (!req || eligibility === null) return ['not assessed']
  return req.undecided.map((c) => `${c.name} (can't be decided)`)
}

export function computeTradeoff(entries: Entry[], w: Weights, traverseKm: number): TradeoffRow[] {
  const total = w.solar + w.comms + w.science + w.safety
  const rows: TradeoffRow[] = comparableEntries(entries)
    .filter((e) => e.result!.assessment)
    .map((entry) => {
      const r = entry.result!
      const req = entry.scenario.requirements
      const disk = cm(r, 'mean_solar_disk_fraction'), earth = cm(r, 'earth_visible_percent')
      const dark = cm(r, 'longest_power_darkness_h'), black = cm(r, 'longest_blackout_h')
      const psrKm = r.science_context?.distance_to_psr_edge_km ?? null
      const kd = knownValue(dark), kb = knownValue(black), ks = knownValue(disk), ke = knownValue(earth)
      const scores: Record<CriterionKey, number | null> = {
        solar: ks,
        comms: ke === null ? null : ke / 100,
        science: psrKm === null ? null : scienceIndex(psrKm, traverseKm),
        safety: kd === null || kb === null ? null : (outageIndex(kd, req.battery_hours) + outageIndex(kb, req.max_comms_gap_hours)) / 2,
      }
      const describe = (m: CanonicalMetric | null, unit: MetricDef['unit']) =>
        m ? (inexactText(m, unit) ?? fmtMetric(m.value, unit)) : 'unavailable'
      const raw: Record<CriterionKey, string> = {
        solar: `${disk && ks !== null ? (ks * 100).toFixed(1) + '%' : describe(disk && { ...disk, lower: disk.lower !== null ? disk.lower * 100 : null, upper: disk.upper !== null ? disk.upper * 100 : null }, '%')} mean disk`,
        comms: `${ke !== null ? ke.toFixed(1) + '%' : describe(earth, '%')} Earth in view`,
        science: psrKm !== null ? `${psrKm.toFixed(1)} km to ${r.science_context!.nearest_psr_name}` : 'unavailable',
        safety: `dark ${describe(dark, 'h')} / ${req.battery_hours} h · blackout ${describe(black, 'h')} / ${req.max_comms_gap_hours} h`,
      }
      const missing = CRITERIA.filter((c) => w[c.key] > 0 && scores[c.key] === null).map((c) => `${c.label}: measurement not exactly known (${raw[c.key]})`)
      const contributions = Object.fromEntries(
        CRITERIA.map((c) => [c.key, scores[c.key] === null ? null : total > 0 ? (w[c.key] * scores[c.key]!) / total : 0]),
      ) as Record<CriterionKey, number | null>
      const weighted = missing.length ? null : CRITERIA.reduce((acc, c) => acc + (contributions[c.key] ?? 0), 0)
      const eligibility = eligibilityOf(entry)
      return { entry, eligibility, blockers: blockersOf(entry, eligibility), scores, raw, weighted, contributions, rank: null, missing }
    })
  // Feasible rows first, then the others; within each, complete rows (by weighted value) before incomplete ones.
  // Only feasible, complete rows get a preference rank: the others are listed to show why they are attractive
  // or not, never as a recommendation.
  const tier = (r: TradeoffRow) => (isFeasible(r) ? 0 : 2) + (r.weighted === null ? 1 : 0)
  rows.sort((a, b) => tier(a) - tier(b) || (b.weighted ?? 0) - (a.weighted ?? 0))
  let n = 0
  for (const r of rows) r.rank = isFeasible(r) && r.weighted !== null ? ++n : null
  return rows
}

// ---------------------------------------------------------------- the shared time axis

export type Align = 'met' | 'utc'

// The backend evaluates every mission on the hourly data grid (backend/app/timegrid.py): landing rounded to the
// nearest whole UTC hour (half rounds up), length to whole hours. The charts' data start at that evaluated
// landing, so the shared axis must use the same times, or elapsed and UTC labels drift from the data.
const HOUR = 3_600_000
/** Evaluated landing time (ms): nearest whole UTC hour, half rounds up. */
export const gridLandingMs = (s: Pick<ComparisonScenario, 'landing_utc'>) =>
  Math.floor((new Date(s.landing_utc).getTime() + HOUR / 2) / HOUR) * HOUR
/** Evaluated mission length in hours: whole hours, at least one. */
export const gridHours = (s: Pick<ComparisonScenario, 'duration_days'>) => Math.max(1, Math.round(s.duration_days * 24))

export function axisOffsets(scenarios: ComparisonScenario[], align: Align): Record<string, number> {
  if (align === 'met' || !scenarios.length) return Object.fromEntries(scenarios.map((s) => [s.id, 0]))
  const t0 = Math.min(...scenarios.map(gridLandingMs))
  return Object.fromEntries(scenarios.map((s) => [s.id, (gridLandingMs(s) - t0) / HOUR]))
}

export function fullDomain(entries: Entry[]): [number, number] {
  if (!entries.length) return [0, 24]
  const lo = Math.min(...entries.map((e) => e.offsetHours))
  const hi = Math.max(...entries.map((e) => e.offsetHours + gridHours(e.scenario)))
  return [lo, hi > lo ? hi : lo + 24]
}

export function axisOrigin(scenarios: ComparisonScenario[]): number {
  return scenarios.length ? Math.min(...scenarios.map(gridLandingMs)) : 0
}

/** Tick label for an axis value. */
export function fmtAxis(x: number, align: Align, originMs: number, span: number): string {
  if (align === 'met') return span > 96 ? `T+${(x / 24).toFixed(x % 24 === 0 ? 0 : 1)} d` : `T+${Math.round(x)} h`
  const d = new Date(originMs + x * 3_600_000)
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...(span > 300 * 24 ? { year: 'numeric' } : {}) })
  return span > 96 ? day : `${day} ${d.toISOString().slice(11, 16)}`
}

// ---------------------------------------------------------------- conditions at a moment

export interface Conditions {
  index: number
  met: number
  time_utc: string
  sunEl: number | null
  sunAz: number | null
  sunHorizon: number | null
  sunFraction: number | null // null = unknown at this sample
  incidence: number | null
  earthEl: number | null
  earthAz: number | null
  earthHorizon: number | null
  earthVisible: boolean | null // null = unknown at this sample
  sunReason: string
  earthReason: string
}

export function sampleIndex(tl: TimelineColumns, met: number): number | null {
  if (!tl.hour.length || met < 0) return null
  const last = tl.hour[tl.hour.length - 1]
  if (met > last + tl.step_hours) return null
  return Math.min(tl.hour.length - 1, Math.max(0, Math.round(met / tl.step_hours)))
}

const deg = (v: number) => `${v.toFixed(2)}°`

export function conditionsAt(e: Entry, x: number): Conditions | null {
  const tl = e.result?.timeline
  if (!tl) return null
  const met = x - e.offsetHours
  if (met < 0 || met > e.scenario.duration_days * 24) return null
  const i = sampleIndex(tl, met)
  if (i === null) return null
  const sunEl = tl.sun_elevation_deg[i], sunHorizon = tl.sun_horizon_deg[i], f = tl.sun_visible_fraction[i]
  const earthEl = tl.earth_elevation_deg[i], earthHorizon = tl.earth_horizon_deg[i], vis = tl.earth_visible[i]
  let sunReason: string
  if (f === null || sunEl === null || sunHorizon === null) sunReason = 'Unknown: no terrain or ephemeris data for the Sun at this time'
  else if (f >= 0.999) sunReason = `Full Sun: Sun centre ${deg(sunEl - sunHorizon)} above the terrain horizon`
  else if (f > 0) sunReason = `Partial Sun: ${Math.round(f * 100)}% of the disk clears the terrain (horizon ${deg(sunHorizon)})`
  else if (sunHorizon > sunEl) sunReason = `Dark: terrain at ${deg(sunHorizon)} hides the Sun at ${deg(sunEl)}`
  else sunReason = `Dark: Sun at ${deg(sunEl)} is below the horizon`
  let earthReason: string
  if (vis === null || earthEl === null || earthHorizon === null) earthReason = 'Unknown: no terrain or ephemeris data for Earth at this time'
  else if (vis) earthReason = `Earth in line of sight, ${deg(earthEl - earthHorizon)} above the terrain`
  else if (earthEl > 0) earthReason = `Blocked: terrain at ${deg(earthHorizon)} hides Earth at ${deg(earthEl)}`
  else earthReason = `Below horizon: Earth at ${deg(earthEl)}, terrain ${deg(earthHorizon)}`
  return {
    index: i, met: tl.hour[i], time_utc: tl.time_utc[i], sunEl, sunAz: tl.sun_azimuth_deg[i], sunHorizon, sunFraction: f,
    incidence: tl.incidence_factor[i], earthEl, earthAz: tl.earth_azimuth_deg[i], earthHorizon, earthVisible: vis,
    sunReason, earthReason,
  }
}

// ---------------------------------------------------------------- chart rows

export type Row = { x: number } & Record<string, number | null>

/** Merge several scenarios' samples onto one x grid for multi-series line charts. */
export function mergeSeries(
  entries: Entry[],
  value: (tl: TimelineColumns, i: number) => number | null,
  domain: [number, number],
  maxRows = 900,
): Row[] {
  const map = new Map<number, Row>()
  for (const e of entries) {
    const tl = e.result?.timeline
    if (!tl) continue
    const pad = tl.step_hours
    for (let i = 0; i < tl.hour.length; i++) {
      const x = Math.round((e.offsetHours + tl.hour[i]) * 1000) / 1000
      if (x < domain[0] - pad || x > domain[1] + pad) continue
      let row = map.get(x)
      if (!row) {
        row = { x } as Row
        map.set(x, row)
      }
      row[e.scenario.id] = value(tl, i)
    }
  }
  const rows = [...map.values()].sort((a, b) => a.x - b.x)
  if (rows.length <= maxRows) return rows
  const k = Math.ceil(rows.length / maxRows)
  return rows.filter((_, i) => i % k === 0)
}

// ---------------------------------------------------------------- written summary

export interface ScenarioHighlights {
  entry: Entry
  strengths: string[]
  cautions: string[] // passing scenarios with narrow or at-threshold headroom
  weaknesses: string[] // measured disadvantages and proven requirement failures
  uncertain: string[] // requirements that cannot be decided (missing data): never failures
}

export interface Summary {
  bests: { label: string; ids: string[]; detail: string }[]
  highlights: ScenarioHighlights[]
  overall: string[]
  caveats: string[]
}

const lbl = (e: Entry) => `Scenario ${e.scenario.label}`

function pick(list: Entry[], f: (e: Entry) => number | null | undefined, better: 'higher' | 'lower') {
  const vals = list.map((e) => ({ e, v: f(e) })).filter((x): x is { e: Entry; v: number } => x.v !== null && x.v !== undefined)
  if (vals.length < 2) return null
  vals.sort((a, b) => (better === 'higher' ? b.v - a.v : a.v - b.v))
  return { best: vals[0], second: vals[1], worst: vals[vals.length - 1], all: vals }
}

/** Differences smaller than these are reported as ties rather than strengths/weaknesses. */
const SIGNIFICANT_FRACTION = 0.02
const significantHours = (best: number, worst: number) => worst - best >= Math.max(6, 0.1 * worst)

const h = (v: number) => (v >= 72 ? `${Math.round(v)} h (${(v / 24).toFixed(1)} days)` : `${Math.round(v)} h`)
const p = (v: number) => `${(v * 100).toFixed(1)}%`

export function buildSummary(entries: Entry[]): Summary {
  // The shared comparison pool (pool.ts): one data kind; every member counts when choosing a "best".
  const pool = comparisonPool(entries)
  // Narrative numbers come from scenarios whose both bodies' statistics exist and whose longest gaps are known.
  const list = pool.members.filter((e) => e.result!.solar && e.result!.earth &&
    e.result!.solar.longest_dark_hours != null && e.result!.earth.longest_blackout_hours != null)
  const caveats: string[] = []
  // Non-null: `list` below keeps only scenarios whose longest-gap values are known.
  const darkOf = (r: CompareResult): number => r.solar!.longest_dark_hours as number
  const blackOf = (r: CompareResult): number => r.earth!.longest_blackout_hours as number
  const unavailable = pool.outside.filter((x) => x.reason === 'no_data').map((x) => x.entry)
  if (unavailable.length) caveats.push(`${unavailable.map(lbl).join(', ')} ${unavailable.length > 1 ? 'have' : 'has'} no scientific data for the chosen site/dates and ${unavailable.length > 1 ? 'are' : 'is'} not included.`)
  const demoOut = pool.outside.filter((x) => x.reason === 'other_data_kind').map((x) => x.entry)
  if (demoOut.length) caveats.push(`${demoOut.map(lbl).join(', ')} use demonstration data and are not compared with real-data scenarios.`)
  // Real scenarios still in the pool but without complete statistics: they block "best" / "worst" claims (rule 2).
  const incomplete = pool.members.filter((e) => !list.includes(e))
  if (incomplete.length) caveats.push(`${incomplete.map(lbl).join(', ')} ${incomplete.length > 1 ? 'have' : 'has'} withheld or unavailable Sun/Earth statistics (incomplete data), so no scenario is called best or worst on those measures.`)
  if (pool.dataKind === 'demonstration') caveats.push('All compared scenarios use demonstration data: the statements below illustrate the tool, not the real Moon.')
  caveats.push('Earth visibility is geometric line of sight; it does not guarantee a working radio link.')
  caveats.push(SCREENING_NOTE)

  const empty: Summary = { bests: [], highlights: [], overall: [], caveats }
  if (pool.members.length < 2) {
    if (pool.members.length === 1) empty.overall.push('Add at least one more scenario with data to generate a comparison.')
    return empty
  }

  // Extremes over the scenarios with complete statistics; only used when `complete` (then that is the whole pool).
  const solar = pick(list, (e) => e.result!.solar!.mean_visible_fraction, 'higher')
  const comms = pick(list, (e) => e.result!.earth!.visible_fraction, 'higher')
  const dark = pick(list, (e) => darkOf(e.result!), 'lower')
  const black = pick(list, (e) => blackOf(e.result!), 'lower')

  // "Best" per measure under the shared rules: over the whole pool (a member without the statistic means no
  // winner), with the same meaningful-lead thresholds as the table and the headlines.
  const pctOf = (v: number | null | undefined) => (v === null || v === undefined ? null : v * 100)
  const solarO = pickBest(pool, (e) => exact(pctOf(e.result!.solar?.mean_visible_fraction)), 'higher', '%')
  const commsO = pickBest(pool, (e) => exact(pctOf(e.result!.earth?.visible_fraction)), 'higher', '%')
  const darkO = pickBest(pool, (e) => exact(e.result!.solar?.longest_dark_hours), 'lower', 'h')
  const blackO = pickBest(pool, (e) => exact(e.result!.earth?.longest_blackout_hours), 'lower', 'h')
  // Comparative words (best, worst, leads, similar) only when every pool member has every statistic.
  const complete = !pool.pending && incomplete.length === 0 && !!solar && !!comms && !!dark && !!black
  const winnersOf = (o: BestOutcome) => pool.members.filter((e) => o.ids.has(e.scenario.id))
  // For the narrative: the fair winner(s), else the group that is similar to the leader.
  const topOf = (o: BestOutcome) => (o.reason === 'winner' ? winnersOf(o) : o.similar)
  const bestSolar = topOf(solarO), bestComms = topOf(commsO)

  const bests: Summary['bests'] = []
  // Detail from the winner's own value (a winner always has an exact one).
  const add = (label: string, o: BestOutcome, detail: (r: CompareResult) => string) => {
    if (o.reason === 'winner') bests.push({ label, ids: [...o.ids], detail: detail(winnersOf(o)[0].result!) })
  }
  add('Best solar performance', solarO, (r) => `${p(r.solar!.mean_visible_fraction)} mean visible solar disk`)
  add('Best Earth communication', commsO, (r) => `Earth in view ${p(r.earth!.visible_fraction)} of the mission`)
  add('Shortest darkness', darkO, (r) => `longest darkness ${h(r.solar!.longest_dark_hours as number)}`)
  add('Shortest blackout', blackO, (r) => `longest blackout ${h(r.earth!.longest_blackout_hours as number)}`)
  // Top canonical rank: only rank 1 of the primary group, and only when it was ranked against other PASS scenarios.
  const top = pool.members.find((e) => e.ranking?.rank === 1 && e.ranking.group === 'G1' && e.ranking.ranked_in_group > 1)
  if (top) {
    bests.push({ label: 'Top canonical rank', ids: [top.scenario.id],
      detail: `#1 of ${top.ranking!.ranked_in_group} passing; score ${scoreText(top.ranking)}` })
  }

  const highlights: ScenarioHighlights[] = pool.members.map((e) => {
    const r = e.result!
    const hr = headroomOfEntry(e)
    const strengths: string[] = [], cautions: string[] = [], weaknesses: string[] = []
    const id = e.scenario.id
    if (solarO.ids.has(id)) strengths.push('Greatest solar availability')
    if (commsO.ids.has(id)) strengths.push('Longest Earth visibility')
    if (darkO.ids.has(id)) strengths.push('Shortest continuous darkness')
    if (blackO.ids.has(id)) strengths.push('Shortest communication blackout')
    if (eligibilityOf(e) === 'pass') {
      if (isLimitedHeadroom(hr) && hr) {
        cautions.push(hr.qualified_verdict)
        if (hr.closest_constraint) cautions.push(`Closest requirement to limit: ${hr.closest_constraint.summary_text}`)
      } else {
        strengths.push('Meets every mission requirement')
      }
    }
    // Only call something a weakness when the gap to the best is meaningful, and only when every pool member has the
    // statistic (an unknown one might be worse still).
    if (complete && solar && comms && dark && black) {
      if (solar.worst.e === e && solar.best.v - solar.worst.v >= SIGNIFICANT_FRACTION) weaknesses.push(`Least solar availability (${p(r.solar!.mean_visible_fraction)})`)
      if (comms.worst.e === e && comms.best.v - comms.worst.v >= SIGNIFICANT_FRACTION) weaknesses.push(`Least Earth visibility (${p(r.earth!.visible_fraction)})`)
      if (dark.worst.e === e && significantHours(dark.best.v, dark.worst.v)) weaknesses.push(`Longest darkness (${h(darkOf(r))})`)
      if (black.worst.e === e && significantHours(black.best.v, black.worst.v)) weaknesses.push(`Longest blackout (${h(blackOf(r))})`)
    }
    const uncertain: string[] = []
    for (const v of r.viability?.violations ?? []) (v.is_unknown ? uncertain : weaknesses).push(v.message)
    return { entry: e, strengths, cautions, weaknesses, uncertain }
  })

  // ---- overall narrative, only from numbers above
  const overall: string[] = []
  // No "leads / greatest / similar" claims over a pool with missing statistics (see the caveat).
  if (complete && solar && comms) {
    const S = solar.best.e, C = comms.best.e
    const sameSolarComms = bestSolar.length === 1 && bestComms.length === 1 && S === C
    if (sameSolarComms) {
      overall.push(`${lbl(S)} leads on both power and communication: ${p(solar.best.v)} mean visible solar disk (next best ${p(solar.second.v)}) and Earth in view ${p(comms.best.v)} of the mission (next best ${p(comms.second.v)}).`)
    } else {
      if (bestSolar.length === 1) {
        const darkS = darkOf(S.result!)
        const other = bestComms.length === 1 ? C : solar.second.e
        const darkO = darkOf(other.result!)
        const darkCmp = darkS < darkO - 0.5 ? `, with a shorter continuous darkness (${h(darkS)} vs ${h(darkO)} for ${lbl(other)})`
          : darkS > darkO + 0.5 ? `, although its longest darkness is longer (${h(darkS)} vs ${h(darkO)} for ${lbl(other)})` : ''
        overall.push(`${lbl(S)} provides the greatest solar availability (${p(solar.best.v)} mean visible solar disk vs ${p(solar.second.v)} for the next best)${darkCmp}.`)
      } else {
        overall.push(`Solar availability is similar across ${bestSolar.map(lbl).join(' and ')} (${p(solar.best.v)}).`)
      }
      if (bestComms.length === 1 && C !== S) {
        overall.push(`However, ${lbl(C)} has longer geometric Earth visibility (${p(comms.best.v)} vs ${p(S.result!.earth!.visible_fraction)} for ${lbl(S)}; longest blackout ${h(blackOf(C.result!))} vs ${h(blackOf(S.result!))}).`)
        if (bestSolar.length === 1) overall.push(`${lbl(S)} may therefore suit power-constrained operations, while ${lbl(C)} offers a communication advantage.`)
      } else if (bestComms.length > 1) {
        overall.push(`Earth visibility is similar for ${bestComms.map(lbl).join(' and ')} (${p(comms.best.v)}).`)
      }
    }
  }

  // ---- why: only mechanisms the data shows directly
  const sameSite = new Set(list.map((e) => e.scenario.site.id)).size === 1
  const sameStart = new Set(list.map((e) => e.scenario.landing_utc)).size === 1
  if (complete && sameSite && !sameStart) {
    const el = pick(list, (e) => e.result!.solar!.mean_elevation_deg, 'higher')!
    overall.push(`All scenarios use the same site, so the differences come from where the Sun and Earth are on those dates, not from the terrain: mean solar elevation ranges from ${el.worst.v.toFixed(2)}° (${lbl(el.worst.e)}) to ${el.best.v.toFixed(2)}° (${lbl(el.best.e)}).`)
  } else if (sameStart && !sameSite) {
    overall.push('All scenarios share the same landing time, so the Sun and Earth sit in almost the same part of the sky for each; the differences come mainly from each site’s local terrain horizon.')
  }
  const clear = pick(list, (e) => e.result!.solar!.mean_clearance_lit_deg, 'higher')
  if (clear && clear.best.v - clear.worst.v > 0.5) {
    overall.push(`While lit, the Sun stays on average ${clear.best.v.toFixed(2)}° above the local terrain at ${lbl(clear.best.e)} but only ${clear.worst.v.toFixed(2)}° at ${lbl(clear.worst.e)}, so at ${lbl(clear.worst.e)} small changes in the Sun’s height are enough for the terrain to block it.`)
  }
  // Verdict statements cover every pool member, statistics or not.
  const assessed = pool.members.filter((e) => eligibilityOf(e) !== null)
  const passing = assessed.filter((e) => eligibilityOf(e) === 'pass')
  const unknown = assessed.filter((e) => eligibilityOf(e) === 'unknown')
  if (assessed.length) {
    const limitedPassing = passing.filter((e) => isLimitedHeadroom(headroomOfEntry(e)))
    const comfortablePassing = passing.filter((e) => !isLimitedHeadroom(headroomOfEntry(e)))
    if (passing.length === 0 && unknown.length === 0) overall.push('No compared scenario passes every mission requirement, so none is ranked as a recommendation; see each scenario’s failed requirements below.')
    else if (passing.length && (passing.length < assessed.length || limitedPassing.length > 0)) {
      if (limitedPassing.length === 0) {
        overall.push(`${passing.map(lbl).join(', ')} ${passing.length > 1 ? 'pass' : 'passes'} every requirement according to the canonical viability engine.`)
      } else {
        if (comfortablePassing.length > 0) {
          overall.push(`${comfortablePassing.map(lbl).join(', ')} ${comfortablePassing.length > 1 ? 'pass' : 'passes'} every requirement with comfortable margin according to the canonical viability engine.`)
        }
        for (const lp of limitedPassing) {
          const hr = headroomOfEntry(lp)!
          overall.push(`${lbl(lp)} ${qualifiedPassClause(hr)}.`)
        }
      }
    }
    if (unknown.length) overall.push(`${unknown.map(lbl).join(', ')} cannot be decided from the available data (UNKNOWN): neither passing nor failing, and not ranked.`)
  }
  const groupIds = new Set(pool.members.map((e) => e.ranking?.group).filter(Boolean))
  if (groupIds.size > 1) caveats.push(`These scenarios fall into ${groupIds.size} separate ranking groups (different data basis, requirements or mission duration). Canonical ranks only compare scenarios inside the same group.`)
  return { bests, highlights, overall, caveats }
}
