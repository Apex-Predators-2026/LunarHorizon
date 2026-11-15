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
import { axisPlacement, missionTime } from './missionTime'
import type { CanonicalMetric, ComparisonScenario, CompareResult, ConstraintItem, RankingGroup, RankingInfo, ResultState, TimelineColumns } from './types'

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
  unit: 'h' | '%' | 'deg' | 'W' | 'x' | 'count' | 'pts' | 'score' | 'factor'
  better: Better
  provenance: Provenance
  get: (r: CompareResult, s: ComparisonScenario) => number | null
  /** Optional text override (e.g. a bounded score), shown instead of fmtMetric(get(...)). */
  text?: (r: CompareResult, s: ComparisonScenario) => string | null
  hint?: string
}

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
    text: (r) => {
      const m = initialWindowMetric(r, 'sunlight')
      return m ? inexactText(m, 'h') : null
    },
    hint: 'Continuous power-lit duration right after landing.' },
  { id: 'time_to_first_sunset_h', group: 'solar', label: 'Time to first sunset', unit: 'h', better: 'higher', provenance: 'derived',
    get: (r) => knownValue(firstEndMetric(r, 'sunlight')),
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
    text: (r) => {
      const m = initialWindowMetric(r, 'earth')
      return m ? inexactText(m, 'h') : null
    },
    hint: 'Continuous Earth line-of-sight duration right after landing.' },
  { id: 'time_to_first_earthset_h', group: 'earth', label: 'Time to first Earthset', unit: 'h', better: 'higher', provenance: 'derived',
    get: (r) => knownValue(firstEndMetric(r, 'earth')),
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
    text: (r, s) => inexactText(marginOf(cm(r, 'mean_solar_disk_fraction'), s.requirements.min_sunlight_fraction, 1, 100), 'pts'),
    hint: 'Mean visible solar disk minus the required minimum.' },
  { id: 'battery_margin', group: 'mission', label: 'Battery margin', unit: 'h', better: 'higher', provenance: 'viability',
    get: (r, s) => marginOf(cm(r, 'longest_power_darkness_h'), s.requirements.battery_hours, -1).value,
    text: (r, s) => inexactText(marginOf(cm(r, 'longest_power_darkness_h'), s.requirements.battery_hours, -1), 'h'),
    hint: 'Max acceptable darkness minus the longest power gap (Sun below the panel threshold).' },
  { id: 'comms_margin', group: 'mission', label: 'Communication margin', unit: 'h', better: 'higher', provenance: 'viability',
    get: (r, s) => marginOf(cm(r, 'longest_blackout_h'), s.requirements.max_comms_gap_hours, -1).value,
    text: (r, s) => inexactText(marginOf(cm(r, 'longest_blackout_h'), s.requirements.max_comms_gap_hours, -1), 'h'),
    hint: 'Max acceptable blackout minus the longest blackout.' },
  { id: 'earth_margin', group: 'mission', label: 'Earth-visibility margin', unit: 'pts', better: 'higher', provenance: 'viability',
    get: (r, s) => marginOf(cm(r, 'earth_visible_percent'), s.requirements.min_earth_visibility_fraction * 100, 1).value,
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

/** Real results are never ranked against demonstration ones (team rule from docs/interfaces.md). */
export function comparableEntries(entries: Entry[]): Entry[] {
  const ok = okEntries(entries)
  const real = ok.filter((e) => e.result!.data_kind === 'real')
  return real.length ? real : ok
}

/** Ids of the best scenario(s) for a metric among comparable results (ties within `tol` share). */
/**
 * Smallest difference worth calling a difference, per unit. Below it two values are "similar": no "best" mark
 * and no better/worse colour. These are display thresholds for readability, not scientific tolerances.
 */
export const MEANINGFUL: Record<MetricDef['unit'], (ref: number) => number> = {
  '%': () => 1, pts: () => 1, h: (ref) => Math.max(2, 0.1 * Math.abs(ref)), deg: () => 0.1, W: () => 10,
  x: () => 0.05, factor: () => 0.02, score: () => 1, count: () => 1,
}

export const isMeaningful = (m: MetricDef, a: number, b: number) =>
  Math.abs(a - b) >= MEANINGFUL[m.unit](Math.max(Math.abs(a), Math.abs(b))) - 1e-9

/**
 * Which scenarios may compete for a "best" mark, shared by every highlight (metrics table, At a glance, summary).
 *   real          two or more real-data results with the same duration and requirements;
 *   illustrative  only demonstration results (two or more, same duration and requirements): a "best" is labelled
 *                 illustrative, never a statement about the Moon;
 *   none          no fair pool: a single real result (demonstration results never compete with it), a selected
 *                 scenario without a result (it could be the best), or different durations / requirements.
 * A "best" is a descriptive lead on one measured quantity; it is never a feasibility recommendation.
 */
export interface BestPool {
  entries: Entry[]
  basis: 'real' | 'illustrative' | 'none'
  note: string | null
}

export function bestPool(entries: Entry[]): BestPool {
  const none = (note: string | null): BestPool => ({ entries: [], basis: 'none', note })
  // Not assessed yet, or the request failed: its value could be anything, so nobody is "best" meanwhile.
  const pendingOrFailed = entries.filter((e) => !e.result && e.state?.state !== 'done')
  // Assessed, but no data exists for that site and time: excluded, and the note says so.
  const noData = entries.filter((e) => !e.result && e.state?.state === 'done')
  const ok = okEntries(entries)
  const real = ok.filter((e) => e.result!.data_kind === 'real')
  const demo = ok.filter((e) => e.result!.data_kind !== 'real')
  const names = (es: Entry[]) => es.map((e) => `Scenario ${e.scenario.label}`).join(', ')
  if (pendingOrFailed.length && ok.length)
    return none(`No “best” is marked while ${names(pendingOrFailed)} ${pendingOrFailed.length > 1 ? 'have' : 'has'} no result yet: a missing value could be the best.`)
  const excluded = noData.length ? ` ${names(noData)} ${noData.length > 1 ? 'have' : 'has'} no data for the chosen site and time and ${noData.length > 1 ? 'are' : 'is'} not compared.` : ''
  let pool: Entry[]
  let basis: BestPool['basis']
  if (real.length >= 2) [pool, basis] = [real, 'real']
  else if (real.length === 1) return none(demo.length ? 'Only one scenario uses real data, so no “best” is marked: demonstration scenarios never compete with real ones.' : null)
  else if (demo.length >= 2) [pool, basis] = [demo, 'illustrative']
  else return none(null)
  const dur = new Set(pool.map((e) => e.scenario.duration_days)).size > 1
  const req = new Set(pool.map((e) => JSON.stringify(e.scenario.requirements))).size > 1
  if (dur || req)
    return none(`The compared plans have ${[dur && 'different mission durations', req && 'different requirements'].filter(Boolean).join(' and ')}: their values are descriptive and no “best” is marked.`)
  const note = (basis === 'illustrative' ? 'Demonstration data only: a “best” here is illustrative, not a statement about the real Moon.'
    : demo.length ? 'Demonstration scenarios are shown for illustration and do not compete with real-data ones.' : '') + excluded
  return { entries: pool, basis, note: note.trim() || null }
}

/** A candidate's value as an interval: exact values have lo = hi; null = no value. */
export type Candidate = { id: string; lo: number; hi: number } | { id: string; lo: null; hi: null }

/**
 * The winner(s) of a pool: proven ahead of every other candidate by a meaningful margin. A bounded candidate wins
 * only if its worst case beats every other candidate's best case; a missing value, or a single candidate, gives
 * no winner. Equal exact values share the mark only when they are together meaningfully ahead of the rest.
 */
export function bestOf(cands: Candidate[], better: 'higher' | 'lower', meaningful: (a: number, b: number) => boolean): Set<string> {
  if (cands.length < 2 || cands.some((c) => c.lo === null || !Number.isFinite(c.lo) || !Number.isFinite(c.hi))) return new Set()
  const cs = cands as { id: string; lo: number; hi: number }[]
  const worst = (c: { lo: number; hi: number }) => (better === 'higher' ? c.lo : c.hi) // least favourable end
  const bestCase = (c: { lo: number; hi: number }) => (better === 'higher' ? c.hi : c.lo)
  const ahead = (a: number, b: number) => (better === 'higher' ? a > b : a < b)
  const top = [...cs].sort((a, b) => (better === 'higher' ? worst(b) - worst(a) : worst(a) - worst(b)))[0]
  const tie = (c: { lo: number; hi: number }) => c.lo === c.hi && top.lo === top.hi && Math.abs(c.lo - top.lo) <= 1e-9
  const winners = cs.filter(tie).length ? cs.filter(tie) : [top]
  const rest = cs.filter((c) => !winners.includes(c))
  if (!rest.length) return new Set() // all equal: no winner
  const w = worst(top)
  return rest.every((c) => ahead(w, bestCase(c)) && meaningful(w, bestCase(c))) ? new Set(winners.map((c) => c.id)) : new Set()
}

/**
 * Scenario(s) with the best value for a metric among comparable results (bestPool). The table's values are exact
 * or null (bounded and unavailable values are written out instead), so any null in the pool gives no winner.
 */
export function bestIds(entries: Entry[], m: MetricDef): Set<string> {
  if (!m.better) return new Set()
  const cands: Candidate[] = bestPool(entries).entries.map((e) => {
    const v = m.get(e.result!, e.scenario)
    return v === null || !Number.isFinite(v) ? { id: e.scenario.id, lo: null, hi: null } : { id: e.scenario.id, lo: v, hi: v }
  })
  return bestOf(cands, m.better, (a, b) => isMeaningful(m, a, b))
}

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

// The backend evaluates every mission on the hourly data grid (backend/app/timegrid.py) and returns the window it
// evaluated. The charts' data start at that evaluated landing, so the shared axis uses the evaluated windows
// (missionTime.ts), never a re-derived rounding, or elapsed and UTC labels drift from the data. A scenario with no
// evaluation yet is placed provisionally (axisPlacement) until its result arrives.
const HOUR = 3_600_000

/** What the axis needs of a scenario: its inputs and its result state. */
export type AxisItem = Pick<Entry, 'scenario' | 'state'>

const placement = (e: AxisItem) => axisPlacement(missionTime(e))

export function axisOffsets(items: AxisItem[], align: Align): Record<string, number> {
  if (align === 'met' || !items.length) return Object.fromEntries(items.map((e) => [e.scenario.id, 0]))
  const t0 = axisOrigin(items)
  return Object.fromEntries(items.map((e) => [e.scenario.id, (placement(e).landingMs - t0) / HOUR]))
}

/** [start, end] of the mission on the shared axis (hours): the evaluated window. */
export const missionExtent = (e: Entry): [number, number] => [e.offsetHours, e.offsetHours + placement(e).hours]

export function fullDomain(entries: Entry[]): [number, number] {
  if (!entries.length) return [0, 24]
  const lo = Math.min(...entries.map((e) => e.offsetHours))
  const hi = Math.max(...entries.map((e) => missionExtent(e)[1]))
  return [lo, hi > lo ? hi : lo + 24]
}

/** Time (ms) of axis x = 0: the earliest evaluated landing. */
export function axisOrigin(items: AxisItem[]): number {
  return items.length ? Math.min(...items.map((e) => placement(e).landingMs)) : 0
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
  if (met < 0 || met > placement(e).hours) return null // the evaluated length, not the requested one
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
  const list = comparableEntries(entries)
  const pool = bestPool(entries)
  const caveats: string[] = []
  // null = the engine withheld the value (incomplete data); it is never read as zero.
  const darkOf = (r: CompareResult): number | null => r.solar?.longest_dark_hours ?? null
  const blackOf = (r: CompareResult): number | null => r.earth?.longest_blackout_hours ?? null
  const unavailable = entries.filter((e) => e.state?.state === 'done' && !e.result)
  if (unavailable.length) caveats.push(`${unavailable.map(lbl).join(', ')} ${unavailable.length > 1 ? 'have' : 'has'} no scientific data for the chosen site/dates and ${unavailable.length > 1 ? 'are' : 'is'} not included.`)
  const demoOut = okEntries(entries).filter((e) => !list.includes(e))
  if (demoOut.length) caveats.push(`${demoOut.map(lbl).join(', ')} use demonstration data and are not compared with real-data scenarios.`)
  if (list.length && list[0].result!.data_kind === 'demonstration') caveats.push('All compared scenarios use demonstration data: the statements below illustrate the tool, not the real Moon.')
  caveats.push('Earth visibility is geometric line of sight; it does not guarantee a working radio link.')
  caveats.push(SCREENING_NOTE)

  const empty: Summary = { bests: [], highlights: [], overall: [], caveats }
  if (list.length < 2) {
    if (list.length === 1) empty.overall.push('Add at least one more scenario with data to generate a comparison.')
    if (pool.note) caveats.unshift(pool.note)
    return empty
  }
  // "Best" statements compare only the fair pool (bestPool); with no fair pool none are made.
  const cmp = pool.entries
  if (pool.note && pool.basis === 'none') caveats.unshift(pool.note)

  const solar = pick(cmp, (e) => e.result!.solar?.mean_visible_fraction, 'higher')
  const comms = pick(cmp, (e) => e.result!.earth?.visible_fraction, 'higher')
  const dark = pick(cmp, (e) => e.result!.solar?.longest_dark_hours, 'lower')
  const black = pick(cmp, (e) => e.result!.earth?.longest_blackout_hours, 'lower')

  const tied = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
  const winners = (x: ReturnType<typeof pick>, tol: number) => (x ? x.all.filter((y) => tied(y.v, x.best.v, tol)).map((y) => y.e) : [])
  const bestSolar = winners(solar, 0.005), bestComms = winners(comms, 0.005)
  const bestDark = winners(dark, 0.5), bestBlack = winners(black, 0.5)

  const bests: Summary['bests'] = []
  const add = (label: string, es: Entry[], detail: string, all: number) => {
    if (es.length < all) bests.push({ label, ids: es.map((e) => e.scenario.id), detail })
  }
  if (solar) add('Best solar performance', bestSolar, `${p(solar.best.v)} mean visible solar disk`, cmp.length)
  if (comms) add('Best Earth communication', bestComms, `Earth in view ${p(comms.best.v)} of the mission`, cmp.length)
  if (dark) add('Shortest darkness', bestDark, `longest darkness ${h(dark.best.v)}`, cmp.length)
  if (black) add('Shortest blackout', bestBlack, `longest blackout ${h(black.best.v)}`, cmp.length)
  // Top canonical rank: only rank 1 of the primary group, and only when it was ranked against other PASS scenarios.
  const top = list.find((e) => e.ranking?.rank === 1 && e.ranking.group === 'G1' && e.ranking.ranked_in_group > 1)
  if (top) {
    bests.push({ label: 'Top canonical rank', ids: [top.scenario.id],
      detail: `#1 of ${top.ranking!.ranked_in_group} passing; score ${scoreText(top.ranking)}` })
  }

  const highlights: ScenarioHighlights[] = list.map((e) => {
    const r = e.result!
    const hr = headroomOfEntry(e)
    const strengths: string[] = [], cautions: string[] = [], weaknesses: string[] = []
    if (bestSolar.includes(e) && bestSolar.length < cmp.length) strengths.push('Greatest solar availability')
    if (bestComms.includes(e) && bestComms.length < cmp.length) strengths.push('Longest Earth visibility')
    if (bestDark.includes(e) && bestDark.length < cmp.length) strengths.push('Shortest continuous darkness')
    if (bestBlack.includes(e) && bestBlack.length < cmp.length) strengths.push('Shortest communication blackout')
    if (eligibilityOf(e) === 'pass') {
      if (isLimitedHeadroom(hr) && hr) {
        cautions.push(hr.qualified_verdict)
        if (hr.closest_constraint) cautions.push(`Closest requirement to limit: ${hr.closest_constraint.summary_text}`)
      } else {
        strengths.push('Meets every mission requirement')
      }
    }
    // Only call something a weakness when the gap to the best is meaningful.
    if (solar && solar.worst.e === e && solar.best.v - solar.worst.v >= SIGNIFICANT_FRACTION && r.solar) weaknesses.push(`Least solar availability (${p(r.solar.mean_visible_fraction)})`)
    if (comms && comms.worst.e === e && comms.best.v - comms.worst.v >= SIGNIFICANT_FRACTION && r.earth) weaknesses.push(`Least Earth visibility (${p(r.earth.visible_fraction)})`)
    if (dark && dark.worst.e === e && significantHours(dark.best.v, dark.worst.v)) weaknesses.push(`Longest darkness (${h(dark.worst.v)})`)
    if (black && black.worst.e === e && significantHours(black.best.v, black.worst.v)) weaknesses.push(`Longest blackout (${h(black.worst.v)})`)
    const uncertain: string[] = []
    for (const v of r.viability?.violations ?? []) (v.is_unknown ? uncertain : weaknesses).push(v.message)
    return { entry: e, strengths, cautions, weaknesses, uncertain }
  })

  // ---- overall narrative, only from numbers above
  const overall: string[] = []
  const blackText = (c: Entry, s: Entry) => {
    const bc = blackOf(c.result!), bs = blackOf(s.result!)
    return bc !== null && bs !== null ? `; longest blackout ${h(bc)} vs ${h(bs)}` : ''
  }
  if (!solar || !comms) {
    overall.push(pool.basis === 'none' && pool.note
      ? `No overall power-versus-communication comparison is made. ${pool.note}`
      : 'No overall power-versus-communication comparison is made: at least one scenario lacks a complete whole-mission value (see the caveats).')
  } else {
  const S = solar.best.e, C = comms.best.e
  const sameSolarComms = bestSolar.length === 1 && bestComms.length === 1 && S === C
  if (sameSolarComms) {
    overall.push(`${lbl(S)} leads on both power and communication: ${p(solar.best.v)} mean visible solar disk (next best ${p(solar.second.v)}) and Earth in view ${p(comms.best.v)} of the mission (next best ${p(comms.second.v)}).`)
  } else {
    if (bestSolar.length === 1) {
      const darkS = darkOf(S.result!)
      const other = bestComms.length === 1 ? C : solar.second.e
      const darkO = darkOf(other.result!)
      const darkCmp = darkS === null || darkO === null ? ''
        : darkS < darkO - 0.5 ? `, with a shorter continuous darkness (${h(darkS)} vs ${h(darkO)} for ${lbl(other)})`
        : darkS > darkO + 0.5 ? `, although its longest darkness is longer (${h(darkS)} vs ${h(darkO)} for ${lbl(other)})` : ''
      overall.push(`${lbl(S)} provides the greatest solar availability (${p(solar.best.v)} mean visible solar disk vs ${p(solar.second.v)} for the next best)${darkCmp}.`)
    } else {
      overall.push(`Solar availability is similar across ${bestSolar.map(lbl).join(' and ')} (${p(solar.best.v)}).`)
    }
    if (bestComms.length === 1 && C !== S) {
      overall.push(`However, ${lbl(C)} has longer geometric Earth visibility (${p(comms.best.v)} vs ${p(S.result!.earth?.visible_fraction ?? NaN)} for ${lbl(S)}${blackText(C, S)}).`)
      if (bestSolar.length === 1) overall.push(`${lbl(S)} may therefore suit power-constrained operations, while ${lbl(C)} offers a communication advantage.`)
    } else if (bestComms.length > 1) {
      overall.push(`Earth visibility is similar for ${bestComms.map(lbl).join(' and ')} (${p(comms.best.v)}).`)
    }
  }
  }

  // ---- why: only mechanisms the data shows directly
  const sameSite = cmp.length > 1 && new Set(cmp.map((e) => e.scenario.site.id)).size === 1
  const sameStart = cmp.length > 1 && new Set(cmp.map((e) => placement(e).landingMs)).size === 1 // evaluated landings
  if (sameSite && !sameStart) {
    const el = pick(cmp, (e) => e.result!.solar?.mean_elevation_deg, 'higher')
    if (el) overall.push(`All scenarios use the same site, so the differences come from where the Sun and Earth are on those dates, not from the terrain: mean solar elevation ranges from ${el.worst.v.toFixed(2)}° (${lbl(el.worst.e)}) to ${el.best.v.toFixed(2)}° (${lbl(el.best.e)}).`)
  } else if (sameStart && !sameSite) {
    overall.push('All scenarios share the same landing time, so the Sun and Earth sit in almost the same part of the sky for each; the differences come mainly from each site’s local terrain horizon.')
  }
  const clear = pick(cmp, (e) => e.result!.solar?.mean_clearance_lit_deg, 'higher')
  if (clear && clear.best.v - clear.worst.v > 0.5) {
    overall.push(`While lit, the Sun stays on average ${clear.best.v.toFixed(2)}° above the local terrain at ${lbl(clear.best.e)} but only ${clear.worst.v.toFixed(2)}° at ${lbl(clear.worst.e)}, so at ${lbl(clear.worst.e)} small changes in the Sun’s height are enough for the terrain to block it.`)
  }
  const assessed = list.filter((e) => eligibilityOf(e) !== null)
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
  const groupIds = new Set(list.map((e) => e.ranking?.group).filter(Boolean))
  if (groupIds.size > 1) caveats.push(`These scenarios fall into ${groupIds.size} separate ranking groups (different data basis, requirements or mission duration). Canonical ranks only compare scenarios inside the same group.`)
  return { bests, highlights, overall, caveats }
}
