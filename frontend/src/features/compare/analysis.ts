// Comparison logic: metric table, best-of, ranking, baseline deltas, trade-off index, conditions at a
// time and the written summary. Pure functions over backend results; no React, no fetching.
//
// Nothing here computes Sun/Earth geometry or viability. Viability (pass/fail, score, violations) is
// the team evaluator's output and is only displayed and sorted.
import type { ComparisonScenario, CompareResult, ResultState, TimelineColumns } from './types'

export interface Entry {
  scenario: ComparisonScenario
  state: ResultState | undefined
  result: CompareResult | null // set only when state is done AND status is ok
  offsetHours: number // where this scenario's landing sits on the shared time axis
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
  hint?: string
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : v * 100)

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
  // ---- mission performance (team viability evaluator)
  { id: 'score', group: 'mission', label: 'Viability score', unit: 'score', better: 'higher', provenance: 'viability',
    get: (r) => r.viability?.score ?? null },
  { id: 'violations', group: 'mission', label: 'Constraint violations', unit: 'count', better: 'lower', provenance: 'viability',
    get: (r) => r.viability?.violations.length ?? null },
  { id: 'solar_margin', group: 'mission', label: 'Solar margin', unit: 'pts', better: 'higher', provenance: 'viability',
    get: (r, s) => (r.viability ? (r.viability.metrics.sunlight_fraction - s.requirements.min_sunlight_fraction) * 100 : null),
    hint: 'Mean visible solar disk minus the required minimum.' },
  { id: 'battery_margin', group: 'mission', label: 'Battery margin', unit: 'h', better: 'higher', provenance: 'viability',
    get: (r, s) => (r.viability ? s.requirements.battery_hours - r.viability.metrics.longest_dark_gap_hours : null),
    hint: 'Max acceptable darkness minus the longest power gap (Sun below the panel threshold).' },
  { id: 'comms_margin', group: 'mission', label: 'Communication margin', unit: 'h', better: 'higher', provenance: 'viability',
    get: (r, s) => (r.viability ? s.requirements.max_comms_gap_hours - r.viability.metrics.longest_comms_gap_hours : null),
    hint: 'Max acceptable blackout minus the longest blackout.' },
  { id: 'earth_margin', group: 'mission', label: 'Earth-visibility margin', unit: 'pts', better: 'higher', provenance: 'viability',
    get: (r, s) =>
      r.viability ? (r.viability.metrics.earth_visibility_fraction - s.requirements.min_earth_visibility_fraction) * 100 : null },
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
export function bestIds(entries: Entry[], m: MetricDef): Set<string> {
  if (!m.better) return new Set()
  const vals = comparableEntries(entries)
    .map((e) => ({ id: e.scenario.id, v: m.get(e.result!, e.scenario) }))
    .filter((x): x is { id: string; v: number } => x.v !== null && Number.isFinite(x.v))
  if (vals.length < 2) return new Set()
  const best = m.better === 'higher' ? Math.max(...vals.map((x) => x.v)) : Math.min(...vals.map((x) => x.v))
  const worst = m.better === 'higher' ? Math.min(...vals.map((x) => x.v)) : Math.max(...vals.map((x) => x.v))
  const tol = Math.max(1e-9, Math.abs(best - worst) * 0.005)
  if (Math.abs(best - worst) <= tol) return new Set() // all equal: no winner
  return new Set(vals.filter((x) => Math.abs(x.v - best) <= tol).map((x) => x.id))
}

export interface Delta {
  value: number
  better: boolean | null // null = no preferred direction or no change
}

export function deltaVsBaseline(m: MetricDef, e: Entry, base: Entry | undefined): Delta | null {
  if (!base || base.scenario.id === e.scenario.id || !e.result || !base.result) return null
  const a = m.get(e.result, e.scenario)
  const b = m.get(base.result, base.scenario)
  if (a === null || b === null) return null
  const d = a - b
  if (Math.abs(d) < 1e-9 || !m.better) return { value: d, better: null }
  return { value: d, better: m.better === 'higher' ? d > 0 : d < 0 }
}

// ---------------------------------------------------------------- ranking (team viability)

export interface Ranked {
  entry: Entry
  rank: number
}

/** Order by the team evaluator's verdict and score. Demonstration results are ranked only among themselves. */
export function rankByViability(entries: Entry[]): { real: Ranked[]; demo: Ranked[] } {
  const order = (list: Entry[]) =>
    [...list]
      .sort((a, b) => {
        const va = a.result!.viability!, vb = b.result!.viability!
        return Number(vb.passes) - Number(va.passes) || (vb.score ?? 0) - (va.score ?? 0)
      })
      .map((entry, i) => ({ entry, rank: i + 1 }))
  const ok = okEntries(entries).filter((e) => e.result!.viability)
  return { real: order(ok.filter((e) => e.result!.data_kind === 'real')), demo: order(ok.filter((e) => e.result!.data_kind === 'demonstration')) }
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
  { key: 'science', label: 'Science site value', basis: 'DEMONSTRATION: proximity to the nearest catalog PSR' },
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
  scores: Record<CriterionKey, number>
  raw: Record<CriterionKey, string>
  weighted: number
  contributions: Record<CriterionKey, number>
  rank: number
}

export function computeTradeoff(entries: Entry[], w: Weights, traverseKm: number): TradeoffRow[] {
  const total = w.solar + w.comms + w.science + w.safety
  const rows = comparableEntries(entries)
    .filter((e) => e.result!.viability && e.result!.solar && e.result!.earth)
    .map((entry) => {
      const r = entry.result!
      const v = r.viability!.metrics
      const req = entry.scenario.requirements
      const psrKm = r.science_context?.distance_to_psr_edge_km ?? Infinity
      const scores: Record<CriterionKey, number> = {
        solar: r.solar!.mean_visible_fraction,
        comms: r.earth!.visible_fraction,
        science: Number.isFinite(psrKm) ? scienceIndex(psrKm, traverseKm) : 0,
        safety: (outageIndex(v.longest_dark_gap_hours, req.battery_hours) + outageIndex(v.longest_comms_gap_hours, req.max_comms_gap_hours)) / 2,
      }
      const raw: Record<CriterionKey, string> = {
        solar: `${(scores.solar * 100).toFixed(1)}% mean disk`,
        comms: `${(scores.comms * 100).toFixed(1)}% Earth in view`,
        science: Number.isFinite(psrKm) ? `${psrKm.toFixed(1)} km to ${r.science_context!.nearest_psr_name}` : 'n/a',
        safety: `dark ${Math.round(v.longest_dark_gap_hours)}/${req.battery_hours} h · blackout ${Math.round(v.longest_comms_gap_hours)}/${req.max_comms_gap_hours} h`,
      }
      const contributions = Object.fromEntries(
        CRITERIA.map((c) => [c.key, total > 0 ? (w[c.key] * scores[c.key]) / total : 0]),
      ) as Record<CriterionKey, number>
      const weighted = Object.values(contributions).reduce((a, b) => a + b, 0)
      return { entry, scores, raw, weighted, contributions, rank: 0 }
    })
  rows.sort((a, b) => b.weighted - a.weighted)
  rows.forEach((r, i) => (r.rank = i + 1))
  return rows
}

// ---------------------------------------------------------------- the shared time axis

export type Align = 'met' | 'utc'

export function axisOffsets(scenarios: ComparisonScenario[], align: Align): Record<string, number> {
  if (align === 'met' || !scenarios.length) return Object.fromEntries(scenarios.map((s) => [s.id, 0]))
  const t0 = Math.min(...scenarios.map((s) => new Date(s.landing_utc).getTime()))
  return Object.fromEntries(scenarios.map((s) => [s.id, (new Date(s.landing_utc).getTime() - t0) / 3_600_000]))
}

export function fullDomain(entries: Entry[]): [number, number] {
  if (!entries.length) return [0, 24]
  const lo = Math.min(...entries.map((e) => e.offsetHours))
  const hi = Math.max(...entries.map((e) => e.offsetHours + e.scenario.duration_days * 24))
  return [lo, hi > lo ? hi : lo + 24]
}

export function axisOrigin(scenarios: ComparisonScenario[]): number {
  return scenarios.length ? Math.min(...scenarios.map((s) => new Date(s.landing_utc).getTime())) : 0
}

/** Tick label for an axis value. */
export function fmtAxis(x: number, align: Align, originMs: number, span: number): string {
  if (align === 'met') return span > 96 ? `T+${(x / 24).toFixed(x % 24 === 0 ? 0 : 1)} d` : `T+${Math.round(x)} h`
  const d = new Date(originMs + x * 3_600_000)
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return span > 96 ? day : `${day} ${d.toISOString().slice(11, 16)}`
}

// ---------------------------------------------------------------- conditions at a moment

export interface Conditions {
  index: number
  met: number
  time_utc: string
  sunEl: number
  sunAz: number
  sunHorizon: number
  sunFraction: number
  incidence: number
  earthEl: number
  earthAz: number
  earthHorizon: number
  earthVisible: boolean
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
  if (f >= 0.999) sunReason = `Full Sun: disk ${deg(sunEl - sunHorizon)} above the terrain horizon`
  else if (f > 0) sunReason = `Partial Sun: ${Math.round(f * 100)}% of the disk clears the terrain (horizon ${deg(sunHorizon)})`
  else if (sunHorizon > sunEl) sunReason = `Dark: terrain at ${deg(sunHorizon)} hides the Sun at ${deg(sunEl)}`
  else sunReason = `Dark: Sun at ${deg(sunEl)} is below the horizon`
  const margin = earthEl - earthHorizon
  const earthReason = vis
    ? `Earth in line of sight, ${deg(margin)} above the terrain`
    : earthEl > 0
      ? `Blocked: terrain at ${deg(earthHorizon)} hides Earth at ${deg(earthEl)}`
      : `Below horizon: Earth at ${deg(earthEl)}, terrain ${deg(earthHorizon)}`
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
  weaknesses: string[]
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

const h = (v: number) => (v >= 72 ? `${Math.round(v)} h (${(v / 24).toFixed(1)} days)` : `${Math.round(v)} h`)
const p = (v: number) => `${(v * 100).toFixed(1)}%`

export function buildSummary(entries: Entry[]): Summary {
  const list = comparableEntries(entries).filter((e) => e.result!.solar && e.result!.earth)
  const caveats: string[] = []
  const unavailable = entries.filter((e) => e.state?.state === 'done' && !e.result)
  if (unavailable.length) caveats.push(`${unavailable.map(lbl).join(', ')} ${unavailable.length > 1 ? 'have' : 'has'} no scientific data for the chosen site/dates and ${unavailable.length > 1 ? 'are' : 'is'} not included.`)
  const demoOut = okEntries(entries).filter((e) => !list.includes(e))
  if (demoOut.length) caveats.push(`${demoOut.map(lbl).join(', ')} use demonstration data and are not compared with real-data scenarios.`)
  if (list.length && list[0].result!.data_kind === 'demonstration') caveats.push('All compared scenarios use DEMONSTRATION data: the statements below illustrate the tool, not the real Moon.')
  caveats.push('Earth visibility is geometric line of sight; it does not guarantee a working radio link.')

  const empty: Summary = { bests: [], highlights: [], overall: [], caveats }
  if (list.length < 2) {
    if (list.length === 1) empty.overall.push('Add at least one more scenario with data to generate a comparison.')
    return empty
  }

  const solar = pick(list, (e) => e.result!.solar!.mean_visible_fraction, 'higher')!
  const comms = pick(list, (e) => e.result!.earth!.visible_fraction, 'higher')!
  const dark = pick(list, (e) => e.result!.solar!.longest_dark_hours, 'lower')!
  const black = pick(list, (e) => e.result!.earth!.longest_blackout_hours, 'lower')!
  const viab = pick(list, (e) => (e.result!.viability ? (e.result!.viability.score ?? 0) + (e.result!.viability.passes ? 1000 : 0) : null), 'higher')

  const tied = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
  const winners = (x: NonNullable<ReturnType<typeof pick>>, tol: number) => x.all.filter((y) => tied(y.v, x.best.v, tol)).map((y) => y.e)
  const bestSolar = winners(solar, 0.005), bestComms = winners(comms, 0.005)
  const bestDark = winners(dark, 0.5), bestBlack = winners(black, 0.5)

  const bests: Summary['bests'] = []
  const add = (label: string, es: Entry[], detail: string, all: number) => {
    if (es.length < all) bests.push({ label, ids: es.map((e) => e.scenario.id), detail })
  }
  add('Best solar performance', bestSolar, `${p(solar.best.v)} mean visible solar disk`, list.length)
  add('Best Earth communication', bestComms, `Earth in view ${p(comms.best.v)} of the mission`, list.length)
  add('Shortest darkness', bestDark, `longest darkness ${h(dark.best.v)}`, list.length)
  add('Shortest blackout', bestBlack, `longest blackout ${h(black.best.v)}`, list.length)
  if (viab) {
    const v = viab.best.e.result!.viability!
    bests.push({ label: 'Best mission viability', ids: [viab.best.e.scenario.id],
      detail: `score ${v.score?.toFixed(1) ?? 'n/a'}, ${v.passes ? 'passes all requirements' : `${v.violations.length} violation(s)`}` })
  }

  const highlights: ScenarioHighlights[] = list.map((e) => {
    const r = e.result!
    const strengths: string[] = [], weaknesses: string[] = []
    if (bestSolar.includes(e) && bestSolar.length < list.length) strengths.push('Greatest solar availability')
    if (bestComms.includes(e) && bestComms.length < list.length) strengths.push('Longest Earth visibility')
    if (bestDark.includes(e) && bestDark.length < list.length) strengths.push('Shortest continuous darkness')
    if (bestBlack.includes(e) && bestBlack.length < list.length) strengths.push('Shortest communication blackout')
    if (r.viability?.passes) strengths.push('Meets every mission requirement')
    if (solar.worst.e === e && !bestSolar.includes(e)) weaknesses.push(`Least solar availability (${p(r.solar!.mean_visible_fraction)})`)
    if (comms.worst.e === e && !bestComms.includes(e)) weaknesses.push(`Least Earth visibility (${p(r.earth!.visible_fraction)})`)
    if (dark.worst.e === e && !bestDark.includes(e) && r.solar!.longest_dark_hours > 0) weaknesses.push(`Longest darkness (${h(r.solar!.longest_dark_hours)})`)
    if (black.worst.e === e && !bestBlack.includes(e) && r.earth!.longest_blackout_hours > 0) weaknesses.push(`Longest blackout (${h(r.earth!.longest_blackout_hours)})`)
    for (const v of r.viability?.violations ?? []) weaknesses.push(v.message)
    return { entry: e, strengths, weaknesses }
  })

  // ---- overall narrative, only from numbers above
  const overall: string[] = []
  const S = solar.best.e, C = comms.best.e
  const sameSolarComms = bestSolar.length === 1 && bestComms.length === 1 && S === C
  if (sameSolarComms) {
    overall.push(`${lbl(S)} leads on both power and communication: ${p(solar.best.v)} mean visible solar disk (next best ${p(solar.second.v)}) and Earth in view ${p(comms.best.v)} of the mission (next best ${p(comms.second.v)}).`)
  } else {
    if (bestSolar.length === 1) {
      const darkS = S.result!.solar!.longest_dark_hours
      const other = bestComms.length === 1 ? C : solar.second.e
      const darkO = other.result!.solar!.longest_dark_hours
      const darkCmp = darkS < darkO - 0.5 ? `, with a shorter continuous darkness (${h(darkS)} vs ${h(darkO)} for ${lbl(other)})`
        : darkS > darkO + 0.5 ? `, although its longest darkness is longer (${h(darkS)} vs ${h(darkO)} for ${lbl(other)})` : ''
      overall.push(`${lbl(S)} provides the greatest solar availability (${p(solar.best.v)} mean visible solar disk vs ${p(solar.second.v)} for the next best)${darkCmp}.`)
    } else {
      overall.push(`Solar availability is similar across ${bestSolar.map(lbl).join(' and ')} (${p(solar.best.v)}).`)
    }
    if (bestComms.length === 1 && C !== S) {
      overall.push(`However, ${lbl(C)} has longer geometric Earth visibility (${p(comms.best.v)} vs ${p(S.result!.earth!.visible_fraction)} for ${lbl(S)}; longest blackout ${h(C.result!.earth!.longest_blackout_hours)} vs ${h(S.result!.earth!.longest_blackout_hours)}).`)
      if (bestSolar.length === 1) overall.push(`${lbl(S)} may therefore suit power-constrained operations, while ${lbl(C)} offers a communication advantage.`)
    } else if (bestComms.length > 1) {
      overall.push(`Earth visibility is similar for ${bestComms.map(lbl).join(' and ')} (${p(comms.best.v)}).`)
    }
  }

  // ---- why: only mechanisms the data shows directly
  const sameSite = new Set(list.map((e) => e.scenario.site.id)).size === 1
  const sameStart = new Set(list.map((e) => e.scenario.landing_utc)).size === 1
  if (sameSite && !sameStart) {
    const el = pick(list, (e) => e.result!.solar!.mean_elevation_deg, 'higher')!
    overall.push(`All scenarios use the same site, so the differences come from where the Sun and Earth are on those dates, not from the terrain: mean solar elevation ranges from ${el.worst.v.toFixed(2)}° (${lbl(el.worst.e)}) to ${el.best.v.toFixed(2)}° (${lbl(el.best.e)}).`)
  } else if (sameStart && !sameSite) {
    overall.push('All scenarios share the same landing time, so the Sun and Earth sit in almost the same part of the sky for each; the differences come mainly from each site’s local terrain horizon.')
  }
  const clear = pick(list, (e) => e.result!.solar!.mean_clearance_lit_deg, 'higher')
  if (clear && clear.best.v - clear.worst.v > 0.5) {
    overall.push(`While lit, the Sun stays on average ${clear.best.v.toFixed(2)}° above the local terrain at ${lbl(clear.best.e)} but only ${clear.worst.v.toFixed(2)}° at ${lbl(clear.worst.e)}, so at ${lbl(clear.worst.e)} small changes in the Sun’s height are enough for the terrain to block it.`)
  }
  const passing = list.filter((e) => e.result!.viability?.passes)
  if (viab) {
    if (passing.length === 0) overall.push('No compared scenario passes every mission requirement; see each scenario’s violations below.')
    else if (passing.length < list.length) overall.push(`${passing.map(lbl).join(', ')} ${passing.length > 1 ? 'pass' : 'passes'} every requirement according to the team viability evaluator.`)
  }
  return { bests, highlights, overall, caveats }
}
