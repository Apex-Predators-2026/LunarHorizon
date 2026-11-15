// Mission Report Card: the structured content of the "Lunar Mission Comparison Report", built from the frozen summary
// report snapshot (report.ts) and nothing else. Pure functions; the preview and the PDF only lay this content out.
//
// Integrity rules (the same as the comparison's):
//   - a missing measurement is "Unavailable", a bound is a range, never a number it is not; never 0;
//   - UNKNOWN stays UNKNOWN and is never counted as a failure; "not assessed" (no data) is its own state;
//   - canonical ranks and the recommendation are the snapshot's own (only eligible PASS plans in their group);
//   - comparison statements need at least two plans with a known value, and a meaningful difference;
//   - nothing is recomputed from the live comparison: the card describes the snapshot it was built from.
import { fmtMetric } from './analysis'
import type { ExportedMetric, ExportedRequirement, ExportedScenario } from './export'
import { fmtEvaluatedLength, fmtRequestedLength, fmtWhen } from './missionTime'
import type { ReportSnapshot } from './report'

export const REPORT_CARD_VERSION = 'mission-report-card-v1'
export const REPORT_TITLE = 'Lunar Mission Comparison Report'
export const PRODUCT_NAME = 'Lunar Landing Site Navigator'

export type Status = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT ASSESSED'
export type Eligibility = 'Eligible (ranked)' | 'Eligible (not ranked)' | 'Ineligible: fails a requirement' | 'Ineligible: undecided (UNKNOWN)' | 'Not assessed'

export interface CardValue {
  text: string // as displayed: "95.6%", "between 12 h and 30 h", "Unavailable", "Not assessed"
  kind: 'known' | 'bounded' | 'unavailable' | 'not_applicable' | 'not_assessed'
  /** The exact value in display units (%, h, °), for charts. Only when kind is 'known'. */
  num?: number
}

export interface PlanSummary {
  label: string
  name: string
  role: string | null
  site: string
  coordinates: string | null
  coordinate_source: string | null
  landing: string // evaluated landing (or the request, named as such)
  duration: string
  time_note: string | null
  status: Status
  eligibility: Eligibility
  rank: string // "Rank 1 of 2 in group G1" or "Not ranked: …"
  data: string // real / demonstration / unavailable, with source
}

export interface MetricRow {
  id: string
  metric: string
  better: 'higher' | 'lower' | null
  note: string | null
  values: Record<string, CardValue>
  best: string[] // labels meaningfully best (empty: no meaningful difference, or fewer than two known values)
}

export interface RequirementCell {
  status: Status | 'NOT CONFIGURED'
  limit: string | null
  measured: string
  margin: string | null
  note: string | null // why it is UNKNOWN / what the engine said
}

export interface RequirementRow {
  id: string
  requirement: string
  limit: string | null // shared limit, or null when the plans differ (then each cell has its own)
  cells: Record<string, RequirementCell>
}

export interface Finding {
  topic: string
  text: string
}

export interface ReportCard {
  version: typeof REPORT_CARD_VERSION
  title: typeof REPORT_TITLE
  product: typeof PRODUCT_NAME
  snapshot_id: string
  generated_at: string
  labels: string[]
  mission_title: string | null
  change: string[]
  executive_summary: string
  key_findings: string[]
  plans: PlanSummary[]
  overview: {
    label: string
    spacecraft: string
    requirements: { requirement: string; limit: string }[]
    notes: string | null
  }[]
  performance: { solar: MetricRow[]; communication: MetricRow[]; viability: MetricRow[] }
  analysis: { findings: Finding[]; tradeoffs: string[] }
  requirements: { rows: RequirementRow[]; unknown_notes: string[] }
  strengths: { label: string; strengths: string[]; weaknesses: string[] }[]
  final: {
    categories: { eligible_pass: string[]; fail: string[]; unknown: string[]; not_assessed: string[] }
    groups: { id: string; primary: boolean; outcome: 'recommended' | 'single_pass' | 'lone' | 'unresolved' | 'none_pass' | 'insufficient'; recommended: string | null; statement: string; evidence: string[]; uncertainty: string[] }[]
    conclusion: string
    separate_groups_note: string | null
  }
  sources: {
    nasa: string[]
    datasets: string[]
    coverage: { label: string; text: string }[]
    methodology: string[]
    versions: string[]
    main_uncertainty: string
    limitations: string[]
  }
  disclaimer: string
}

// ---------------------------------------------------------------- formatting

const STATUS: Record<string, Status> = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN' }
const statusOf = (e: string | null | undefined): Status => (e ? STATUS[e] ?? 'NOT ASSESSED' : 'NOT ASSESSED')
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const scen = (ls: string[]) => (ls.length === 1 ? `Scenario ${ls[0]}` : `Scenarios ${list(ls)}`)

/** A canonical measurement as displayed: fractions as %, bounds as a range, nothing missing turned into a number. */
export function valueOf(m: ExportedMetric | null | undefined, assessed = true): CardValue {
  if (!assessed) return { text: 'Not assessed', kind: 'not_assessed' }
  if (!m || m.status === 'missing' || m.status === 'unavailable') return { text: 'Unavailable', kind: 'unavailable' }
  if (m.status === 'not_applicable') return { text: 'Not applicable', kind: 'not_applicable' }
  const pct = m.unit === 'fraction'
  const unit = pct || m.unit === '%' ? '%' : m.unit === 'h' ? 'h' : 'deg'
  const k = pct ? 100 : 1
  if (m.status === 'known' && m.value !== null) return { text: fmtMetric(m.value * k, unit), kind: 'known', num: m.value * k }
  if (m.status === 'bounded' && m.lower !== null && m.upper !== null) {
    return { text: `between ${fmtMetric(m.lower * k, unit)} and ${fmtMetric(m.upper * k, unit)}`, kind: 'bounded' }
  }
  return { text: 'Unavailable', kind: 'unavailable' }
}

const exact = (m: ExportedMetric | null | undefined): number | null =>
  m && m.status === 'known' && m.value !== null ? m.value * (m.unit === 'fraction' ? 100 : 1) : null

function limitText(r: ExportedRequirement): string | null {
  if (r.threshold === null || !r.comparison) return null
  const op = r.comparison === 'at_most' ? '≤' : '≥'
  return `${op} ${valueOf({ status: 'known', unit: r.measured.unit, value: r.threshold, lower: null, upper: null }).text}`
}

function marginText(s: ExportedScenario, r: ExportedRequirement): string | null {
  const m = s.margins.find((x) => x.id === r.id)
  if (!m) return null
  const v = valueOf(m.margin)
  if (v.kind !== 'known' && v.kind !== 'bounded') return v.kind === 'unavailable' ? 'uncertain' : null
  const signed = m.margin.status === 'known' && m.margin.value !== null && m.margin.value > 0 ? `+${v.text}` : v.text
  return m.margin_class === 'narrow' || m.margin_class === 'at_threshold' ? `${signed} (narrow)` : signed
}

const windowOf = (s: ExportedScenario) => {
  const t = s.mission_time
  if (t.evaluated_landing_utc && t.evaluated_duration_hours !== null) {
    return { landing: fmtWhen(t.evaluated_landing_utc), duration: fmtEvaluatedLength(t.evaluated_duration_hours), note: t.time_note }
  }
  return { landing: `${fmtWhen(t.requested_landing_utc)} (requested; not evaluated)`, duration: `${fmtRequestedLength(t.requested_duration_days)} (requested)`, note: t.time_note }
}

const coords = (s: ExportedScenario) =>
  Number.isFinite(s.site.lat) && Number.isFinite(s.site.lon)
    ? `${Math.abs(s.site.lat).toFixed(4)}° ${s.site.lat < 0 ? 'S' : 'N'}, ${(((s.site.lon % 360) + 360) % 360).toFixed(4)}° E`
    : null

function eligibilityOf(s: ExportedScenario): Eligibility {
  if (s.eligibility === 'pass') return s.canonical_rank !== null ? 'Eligible (ranked)' : 'Eligible (not ranked)'
  if (s.eligibility === 'fail') return 'Ineligible: fails a requirement'
  if (s.eligibility === 'unknown') return 'Ineligible: undecided (UNKNOWN)'
  return 'Not assessed'
}

function spacecraftText(s: ExportedScenario): string {
  const c = s.spacecraft
  const part = (v: number | null, unit: string, what: string) => (v === null ? `${what} not set` : `${v} ${unit} ${what}`)
  return `${c.panel_mode.replace(/_/g, ' ')} solar panel · ${part(c.panel_rated_power_w, 'W', 'rated')} · ${part(c.average_load_w, 'W', 'average load')} · ${part(c.battery_capacity_wh, 'Wh', 'battery')}`
}

// ---------------------------------------------------------------- metric tables

interface MetricDef { id: string; metric: string; key: string | null; better: 'higher' | 'lower' | null; note?: string; derive?: 'share_hours' ; share?: string }

const SOLAR: MetricDef[] = [
  { id: 'sun_share', metric: 'Direct sunlight (share of mission)', key: 'sunlight_percent', better: 'higher', note: 'Any part of the solar disk above the local terrain' },
  { id: 'sun_hours', metric: 'Total direct sunlight', key: null, better: 'higher', derive: 'share_hours', share: 'sunlight_percent', note: 'Share × evaluated mission length' },
  { id: 'disk', metric: 'Mean visible solar disk', key: 'mean_solar_disk_fraction', better: 'higher', note: 'Partial Sun counts partially (drives solar power)' },
  { id: 'power_lit', metric: 'Power-lit share of mission', key: 'power_lit_percent', better: 'higher' },
  { id: 'dark', metric: 'Longest continuous power darkness', key: 'longest_power_darkness_h', better: 'lower', note: 'Must be survived on batteries' },
  { id: 'no_sun', metric: 'Longest without direct sunlight', key: 'longest_without_sun_h', better: 'lower' },
  { id: 'sun_after_landing', metric: 'Continuous sunlight after landing', key: 'initial_sunlight_h', better: 'higher' },
  { id: 'sun_el', metric: 'Mean solar elevation', key: 'mean_solar_elevation_deg', better: null },
  { id: 'sun_clear', metric: 'Mean Sun clearance above terrain', key: 'mean_sun_clearance_deg', better: 'higher', note: 'Near 0° means terrain nearly blocks the Sun' },
]
const COMMS: MetricDef[] = [
  { id: 'earth_share', metric: 'Earth in line of sight (share of mission)', key: 'earth_visible_percent', better: 'higher', note: 'Geometric visibility, not a radio link budget' },
  { id: 'earth_hours', metric: 'Total Earth visibility', key: null, better: 'higher', derive: 'share_hours', share: 'earth_visible_percent', note: 'Share × evaluated mission length' },
  { id: 'blackout', metric: 'Longest communication blackout', key: 'longest_blackout_h', better: 'lower' },
  { id: 'earth_after_landing', metric: 'Continuous Earth contact after landing', key: 'initial_earth_h', better: 'higher' },
  { id: 'earth_clear', metric: 'Mean Earth clearance above terrain', key: 'mean_earth_clearance_deg', better: 'higher' },
  { id: 'both', metric: 'Sun and Earth visible together', key: 'simultaneous_percent', better: 'higher' },
]

/** Meaningful difference: 1 percentage point, max(2 h, 10%) for durations, 0.5° for angles. */
function meaningful(id: string, a: number, b: number): boolean {
  const d = Math.abs(a - b)
  if (/hours|dark|no_sun|blackout|after_landing/.test(id)) return d >= Math.max(2, 0.1 * Math.max(Math.abs(a), Math.abs(b)))
  if (/clear|_el$/.test(id)) return d >= 0.5
  return d >= 1
}

function metricRows(defs: MetricDef[], scenarios: ExportedScenario[]): MetricRow[] {
  return defs.map((d) => {
    const values: Record<string, CardValue> = {}
    const nums: Record<string, number | null> = {}
    for (const s of scenarios) {
      if (!s.assessed) { values[s.label] = valueOf(null, false); nums[s.label] = null; continue }
      if (d.derive === 'share_hours') {
        const share = s.metrics[d.share!]
        const hours = s.mission_time.evaluated_duration_hours
        const v = exact(share)
        if (v !== null && hours !== null) {
          const h = (v / 100) * hours
          values[s.label] = { text: fmtMetric(h, 'h'), kind: 'known', num: h }
          nums[s.label] = h
        } else if (share && share.status === 'bounded' && share.lower !== null && share.upper !== null && hours !== null) {
          values[s.label] = { text: `between ${fmtMetric((share.lower / 100) * hours, 'h')} and ${fmtMetric((share.upper / 100) * hours, 'h')}`, kind: 'bounded' }
          nums[s.label] = null
        } else {
          values[s.label] = { text: 'Unavailable', kind: 'unavailable' }
          nums[s.label] = null
        }
        continue
      }
      const m = s.metrics[d.key!]
      values[s.label] = valueOf(m)
      nums[s.label] = exact(m)
    }
    return { id: d.id, metric: d.metric, better: d.better, note: d.note ?? null, values, best: bestOf(d, scenarios, nums) }
  })
}

function bestOf(d: MetricDef, scenarios: ExportedScenario[], nums: Record<string, number | null>): string[] {
  if (!d.better) return []
  // Real data competes with real data only, unless nothing is real.
  const real = scenarios.filter((s) => nums[s.label] !== null && s.data.kind === 'real')
  const pool = (real.length >= 2 ? real : scenarios.filter((s) => nums[s.label] !== null)).map((s) => ({ l: s.label, v: nums[s.label]! }))
  if (pool.length < 2) return []
  const sorted = [...pool].sort((a, b) => (d.better === 'higher' ? b.v - a.v : a.v - b.v))
  const top = sorted.filter((x) => x.v === sorted[0].v)
  const next = sorted.find((x) => x.v !== sorted[0].v)
  return next && meaningful(d.id, sorted[0].v, next.v) ? top.map((x) => x.l) : []
}

function viabilityRows(scenarios: ExportedScenario[], plans: PlanSummary[]): MetricRow[] {
  const by = (f: (s: ExportedScenario, p: PlanSummary) => string): Record<string, CardValue> =>
    Object.fromEntries(scenarios.map((s, i) => [s.label, { text: f(s, plans[i]), kind: s.assessed ? 'known' : 'not_assessed' } as CardValue]))
  return [
    { id: 'verdict', metric: 'Assessment', better: null, note: 'PASS: every applicable requirement met · FAIL: at least one violated · UNKNOWN: cannot be decided (not a failure)', values: by((_, p) => p.status), best: [] },
    { id: 'eligibility', metric: 'Eligibility for ranking', better: null, note: null, values: by((_, p) => p.eligibility), best: [] },
    { id: 'rank', metric: 'Canonical rank', better: null, note: 'Only eligible PASS plans, within their comparable group', values: by((_, p) => p.rank), best: [] },
    { id: 'failed', metric: 'Failed requirements', better: null, note: null, values: by((s) => (!s.assessed ? 'Not assessed' : s.failed_requirements.length ? s.failed_requirements.join('; ') : 'None')), best: [] },
    { id: 'undecided', metric: 'Undecided requirements (not failures)', better: null, note: null, values: by((s) => (!s.assessed ? 'Not assessed' : s.undecided_requirements.length ? s.undecided_requirements.join('; ') : 'None')), best: [] },
    { id: 'headroom', metric: 'Operating headroom', better: null, note: 'How comfortably a passing plan clears its limits', values: by((s) => (s.eligibility === 'pass' && s.headroom ? s.headroom.qualified_verdict : '-')), best: [] },
    { id: 'risk', metric: 'Screening risk', better: null, note: null, values: by((s) => s.overall_risk ?? '-'), best: [] },
    {
      id: 'score', metric: 'Desirability score', better: null, note: 'Relative index under the engine weights; not a probability of success',
      values: by((s) => (s.score.status === 'known' && s.score.exact !== null ? s.score.exact.toFixed(1)
        : s.score.status === 'bounded' && s.score.lower !== null && s.score.upper !== null ? `${s.score.lower.toFixed(1)}–${s.score.upper.toFixed(1)}`
          : 'Not scored')),
      best: [],
    },
  ]
}

// ---------------------------------------------------------------- requirements

function requirementRows(scenarios: ExportedScenario[]): { rows: RequirementRow[]; unknown_notes: string[] } {
  const ids: { id: string; name: string }[] = []
  for (const s of scenarios) for (const r of s.requirement_verdicts) {
    if (r.status !== 'not_applicable' && !ids.some((x) => x.id === r.id)) ids.push({ id: r.id, name: r.name })
  }
  const unknown_notes: string[] = []
  const rows = ids.map(({ id, name }) => {
    const cells: Record<string, RequirementCell> = {}
    const limits = new Set<string>()
    for (const s of scenarios) {
      const r = s.requirement_verdicts.find((x) => x.id === id)
      if (!s.assessed) { cells[s.label] = { status: 'NOT ASSESSED', limit: null, measured: 'Not assessed', margin: null, note: null }; continue }
      if (!r || r.status === 'not_applicable') { cells[s.label] = { status: 'NOT CONFIGURED', limit: null, measured: '-', margin: null, note: 'Not a requirement of this plan' }; continue }
      const limit = limitText(r)
      if (limit) limits.add(limit)
      const st = statusOf(r.status)
      let note: string | null = null
      if (st === 'UNKNOWN') {
        const w = r.evidence_windows[0]
        note = r.message ?? (w ? `Undecided ${w.kind.replace(/_/g, ' ')} from ${fmtWhen(w.start_utc)} to ${fmtWhen(w.end_utc)}` : 'The data cannot decide this requirement')
        unknown_notes.push(`Scenario ${s.label} · ${name}: ${note}`)
      } else if (st === 'FAIL') note = r.message
      cells[s.label] = { status: st, limit, measured: valueOf(r.measured).text, margin: marginText(s, r), note }
    }
    return { id, requirement: name, limit: limits.size === 1 ? [...limits][0] : null, cells }
  })
  return { rows, unknown_notes }
}

// ---------------------------------------------------------------- analysis, strengths, final

const TOPICS: { topic: string; row: string; table: 'solar' | 'communication'; phrase: string }[] = [
  { topic: 'Sunlight', row: 'disk', table: 'solar', phrase: 'the most sunlight' },
  { topic: 'Darkness', row: 'dark', table: 'solar', phrase: 'the shortest continuous power darkness' },
  { topic: 'Earth visibility', row: 'earth_share', table: 'communication', phrase: 'the most Earth visibility' },
  { topic: 'Communication blackout', row: 'blackout', table: 'communication', phrase: 'the shortest communication blackout' },
]
/** The headline measures used for best / weakest statements about a plan. */
const HEADLINE_ROWS = ['disk', 'dark', 'earth_share', 'blackout', 'sun_after_landing', 'earth_after_landing']

function topicFinding(rows: MetricRow[], rowId: string, phrase: string, labels: string[]): string {
  const row = rows.find((r) => r.id === rowId)!
  const vals = `${row.metric.replace(/ \(share of mission\)$/, '')}: ${labels.map((l) => `${l} ${row.values[l].text}`).join('; ')}`
  const known = labels.filter((l) => row.values[l].kind === 'known')
  if (row.best.length) return `${scen(row.best)} ${row.best.length === 1 ? 'has' : 'share'} ${phrase} (${vals}).`
  if (known.length < 2) return `Cannot be compared: fewer than two plans have an exact value (${vals}).`
  return `No meaningful difference between the plans (${vals}).`
}

function strengthsOf(s: ExportedScenario, card: Pick<ReportCard, 'performance' | 'requirements'>, labels: string[]) {
  const strengths: string[] = []
  const weaknesses: string[] = []
  if (!s.assessed) return { label: s.label, strengths, weaknesses: ['Not assessed: no data for this site and date range, so nothing can be stated about it.'] }
  const cells = card.requirements.rows.map((row) => ({ row, c: row.cells[s.label] })).filter(({ c }) => c.status !== 'NOT CONFIGURED' && c.status !== 'NOT ASSESSED')
  const passed = cells.filter(({ c }) => c.status === 'PASS')
  if (cells.length) {
    strengths.push(passed.length === cells.length ? `Meets every requirement (${passed.length} of ${cells.length})` : `Meets ${passed.length} of ${cells.length} requirements`)
  }
  // Most serious first: violations, then requirements that cannot be decided, then passes with little margin.
  for (const { row, c } of cells) {
    if (c.status === 'FAIL') weaknesses.push(`Fails ${row.requirement} (${c.measured}${c.limit ? `, limit ${c.limit}` : ''}${c.margin ? `, margin ${c.margin}` : ''})`)
  }
  for (const { row, c } of cells) if (c.status === 'UNKNOWN') weaknesses.push(`${row.requirement} cannot be decided from the data (not a failure)`)
  for (const { row, c } of cells) {
    if (c.status === 'PASS' && c.margin?.endsWith('(narrow)')) weaknesses.push(`Narrow margin on ${row.requirement} (${c.measured}, limit ${c.limit}, margin ${c.margin.replace(' (narrow)', '')})`)
  }
  const name = (m: string) => m.replace(/ \(share of mission\)$/, '')
  const best: string[] = []
  const worst: string[] = []
  for (const row of [...card.performance.solar, ...card.performance.communication].filter((r) => HEADLINE_ROWS.includes(r.id))) {
    if (!row.better || labels.length < 2) continue
    if (row.best.includes(s.label) && row.best.length < labels.length) best.push(`Best of the compared plans on ${name(row.metric)}: ${row.values[s.label].text}`)
    else if (row.best.length && !row.best.includes(s.label)) {
      const known = labels.filter((l) => row.values[l].kind === 'known')
      const v = (l: string) => parseFloat(row.values[l].text)
      if (known.length >= 2 && known.includes(s.label)) {
        // Every plan tied at the worst value is named (never just the first one the sort happens to return).
        const vals = known.map(v)
        const worstVal = row.better === 'higher' ? Math.min(...vals) : Math.max(...vals)
        if (v(s.label) === worstVal) worst.push(`Weakest of the compared plans on ${name(row.metric)}: ${row.values[s.label].text}`)
      }
    }
  }
  strengths.push(...best.slice(0, 4))
  weaknesses.push(...worst.slice(0, 4))
  if (s.eligibility === 'pass' && s.headroom?.limited_constraints.length && !weaknesses.some((w) => w.startsWith('Narrow margin'))) {
    weaknesses.push(`Passes with little margin on ${list(s.headroom.limited_constraints)}`)
  }
  if (s.data.kind === 'demonstration') weaknesses.push('Uses synthetic demonstration data: illustrative only, not for planning')
  const cov = [s.data.sun_coverage_percent, s.data.earth_coverage_percent].filter((x): x is number => x !== null)
  if (cov.length && Math.min(...cov) < 100) weaknesses.push(`Data covers only part of the mission (Sun ${s.data.sun_coverage_percent?.toFixed(1) ?? '-'}%, Earth ${s.data.earth_coverage_percent?.toFixed(1) ?? '-'}%)`)
  return { label: s.label, strengths, weaknesses }
}

const OUTCOME: Record<string, ReportCard['final']['groups'][number]['outcome']> = {
  recommended: 'recommended', single_pass: 'single_pass', lone: 'lone', unresolved: 'unresolved', none_pass: 'none_pass', insufficient: 'insufficient',
}

function finalAssessment(s: ReportSnapshot, x: ExportedScenario[]): ReportCard['final'] {
  const by = (f: (e: ExportedScenario) => boolean) => x.filter(f).map((e) => e.label)
  const categories = {
    eligible_pass: by((e) => e.eligibility === 'pass'),
    fail: by((e) => e.eligibility === 'fail'),
    unknown: by((e) => e.eligibility === 'unknown'),
    not_assessed: by((e) => !e.eligibility),
  }
  const groups = s.decisions.map((d) => {
    const outcome = OUTCOME[d.kind] ?? 'insufficient'
    const rec = outcome === 'recommended' || outcome === 'single_pass' || outcome === 'lone' ? d.recommended : null
    const g = s.decisions.length > 1 ? ` in group ${d.id}` : ''
    // Our sentence states the outcome; the decision's own headline is added only where it gives more than that.
    const statement = outcome === 'recommended' ? `Scenario ${rec} is the canonical top-ranked eligible option${g}: it meets every requirement and holds rank 1.`
      : outcome === 'single_pass' ? `Scenario ${rec} is the only plan${g} that meets every requirement.`
        : outcome === 'lone' ? `Scenario ${rec} meets every requirement, but there is no comparable plan to rank it against.`
          : outcome === 'unresolved' ? `Several plans${g} meet every requirement, but the evidence does not establish a preference between them. ${d.headline}`
            : outcome === 'none_pass' ? `No eligible passing recommendation is available${g}: no plan meets every requirement.`
              : `A definitive recommendation cannot be established${g}: the evidence does not decide every requirement. ${d.headline}`
    return { id: d.id, primary: d.primary, outcome, recommended: rec, statement, evidence: d.evidence, uncertainty: d.uncertainty }
  })
  const primary = groups.find((g) => g.primary) ?? groups[0]
  const conclusion = !groups.length
    ? 'No plan has a canonical assessment, so none can be judged and no recommendation is made.'
    : primary.recommended && (primary.outcome === 'recommended' || primary.outcome === 'single_pass')
      ? `On the evidence in this report, Scenario ${primary.recommended} is the most suitable plan under the selected requirements${groups.length > 1 ? ' (main comparison group)' : ''}.`
      : primary.outcome === 'lone' ? `Scenario ${primary.recommended} meets every requirement; with nothing comparable, no ranking preference is stated.`
        : primary.outcome === 'unresolved' ? 'The passing plans cannot be separated on the evidence; the choice between them depends on the trade-offs listed in this report.'
          : primary.outcome === 'none_pass' ? 'No eligible passing recommendation is available: every assessed plan fails at least one requirement.'
            : 'A definitive recommendation cannot be established from the available evidence.'
  const separate = s.decisions.filter((d) => d.separate_reason)
  return {
    categories, groups, conclusion,
    separate_groups_note: separate.length ? `Plans in different groups are not ranked against each other (${separate.map((d) => `group ${d.id}: ${d.separate_reason}`).join('; ')}).` : null,
  }
}

function executiveSummary(card: Omit<ReportCard, 'executive_summary' | 'key_findings' | 'disclaimer'>, s: ReportSnapshot): string {
  const n = card.plans.length
  const sites = [...new Set(card.plans.map((p) => p.site))]
  const reqNames = card.requirements.rows.map((r) => r.requirement.toLowerCase())
  const c = card.final.categories
  const parts: string[] = []
  parts.push(`This report evaluates ${n} lunar south-pole mission plan${n === 1 ? '' : 's'} (${card.plans.map((p) => `Scenario ${p.label}, ${p.site}`).join('; ')}) against ${reqNames.length ? `${reqNames.length} selected requirement${reqNames.length === 1 ? '' : 's'} on sunlight, darkness and direct-to-Earth communication` : 'their selected requirements'}, using hourly NASA JPL Horizons ephemerides and LOLA terrain${sites.length === 1 ? ` at ${sites[0]}` : ''}.`)
  const states: string[] = []
  if (c.eligible_pass.length) states.push(`${scen(c.eligible_pass)} ${c.eligible_pass.length === 1 ? 'meets' : 'meet'} every assessed requirement`)
  if (c.fail.length) {
    states.push(c.fail.map((l) => {
      const p = s.export.scenarios.find((e) => e.label === l)!
      return `Scenario ${l} fails ${list(p.failed_requirements.map((x) => x.toLowerCase()))}`
    }).join('; '))
  }
  if (c.unknown.length) states.push(`${scen(c.unknown)} cannot be decided from the data (UNKNOWN, not a failure)`)
  if (c.not_assessed.length) states.push(`${scen(c.not_assessed)} could not be assessed (no data)`)
  if (states.length) parts.push(`${states.join('; ')}.`)
  parts.push(card.final.conclusion)
  parts.push('The following sections give the evidence, the requirement-by-requirement assessment, the trade-offs and the remaining uncertainty.')
  return parts.join(' ')
}

// ---------------------------------------------------------------- the card

export const NASA_SOURCES = [
  'NASA JPL Horizons System: apparent Sun and Earth azimuth and elevation from each site (CENTER=coord@301), precomputed hourly.',
  'NASA Moon Trek / LRO LOLA digital elevation models: terrain horizons in 720 directions with lunar curvature (5 m to 200 m resolution, out to 300 km).',
  'NASA LROC Quickmap WAC_POLE_ILL_TWI_SOUTH: empirical illumination used to validate the sunlight model.',
  'Validation reference: Gracy & Lee, LPSC 2024 (south-polar illumination of Connecting Ridge and Peak Near Shackleton).',
]

export const DISCLAIMER = 'This report summarizes the Lunar Landing Site Navigator\'s modelled results for the selected scenarios and mission requirements, as computed at the time shown. It is a planning aid: it is not an official NASA mission approval, certification or guarantee of operational safety. Geometric sunlight and Earth line of sight are not power or radio-link budgets.'

export function buildReportCard(s: ReportSnapshot): ReportCard {
  const x = s.export.scenarios
  const labels = x.map((e) => e.label)
  const plans: PlanSummary[] = x.map((e) => {
    const w = windowOf(e)
    const row = s.scenarios.find((r) => r.label === e.label)
    return {
      label: e.label, name: e.name, role: e.role, site: e.site.name, coordinates: coords(e), coordinate_source: e.coordinate_source,
      landing: w.landing, duration: w.duration, time_note: w.note,
      status: statusOf(e.eligibility), eligibility: eligibilityOf(e),
      rank: e.canonical_rank !== null ? `Rank ${e.canonical_rank}${e.ranking_group ? ` in group ${e.ranking_group}` : ''}` : row?.rank ?? 'Not ranked',
      data: e.data.kind === 'real' ? `NASA data (${e.data.source ?? 'Horizons + LOLA'})` : e.data.kind === 'demonstration' ? 'Synthetic demonstration data (illustrative only)' : e.data.kind === 'unavailable' ? 'No data for this site and date range' : 'Not loaded',
    }
  })
  const performance = {
    solar: metricRows(SOLAR, x),
    communication: metricRows(COMMS, x),
    viability: viabilityRows(x, plans),
  }
  const requirements = requirementRows(x)
  const analysis = {
    findings: [
      ...TOPICS.map((t) => ({ topic: t.topic, text: topicFinding(t.table === 'solar' ? performance.solar : performance.communication, t.row, t.phrase, labels) })),
      { topic: 'Requirements', text: [
        plans.filter((p) => p.status === 'PASS').length ? `${scen(plans.filter((p) => p.status === 'PASS').map((p) => p.label))} meet${plans.filter((p) => p.status === 'PASS').length === 1 ? 's' : ''} every requirement.` : 'No plan meets every requirement.',
        ...plans.filter((p) => p.status === 'FAIL').map((p) => `Scenario ${p.label} fails ${list(x.find((e) => e.label === p.label)!.failed_requirements.map((f) => f.toLowerCase()))}.`),
        ...plans.filter((p) => p.status === 'UNKNOWN').map((p) => `Scenario ${p.label} has requirements that cannot be decided (UNKNOWN).`),
      ].join(' ') },
    ],
    tradeoffs: [...new Set(s.decisions.flatMap((d) => d.tradeoffs))],
  }
  const final = finalAssessment(s, x)
  const strengths = x.map((e) => strengthsOf(e, { performance, requirements }, labels))
  const sources = {
    nasa: NASA_SOURCES,
    datasets: s.export.reproduction.datasets.map((d) => `${d.file ? `data/sites/${d.file}` : d.dataset_id ?? 'dataset'}${d.sha256 ? ` · SHA-256 ${d.sha256}` : ''}`),
    coverage: x.map((e) => ({
      label: e.label,
      text: !e.assessed ? 'Not assessed (no data)' : `${e.data.kind ?? 'unknown'} data · Sun state known ${e.data.sun_coverage_percent?.toFixed(1) ?? '-'}% / Earth ${e.data.earth_coverage_percent?.toFixed(1) ?? '-'}% of the evaluated mission`,
    })),
    methodology: [
      'Each plan is evaluated hour by hour over its evaluated mission window: the Sun is treated as a 0.53° disk (partial sunlight counts partially) and Earth as visible when its centre is above the terrain horizon.',
      'Each requirement is checked by the canonical viability engine: PASS, FAIL, or UNKNOWN when the data cannot decide it. A plan passes only when every applicable requirement passes.',
      `Only passing plans are ranked, and only against plans with the same requirements, mission length and data basis${s.export.ranking_method ? ` (ranking method ${s.export.ranking_method})` : ''}.`,
      ...(s.export.reproduction.time_policy ? [`Time policy: ${s.export.reproduction.time_policy}`] : []),
    ],
    versions: [
      `Engine ${s.export.reproduction.versions.engine.join(', ') || '-'}`,
      `Scoring ${s.export.reproduction.versions.scoring_method.join(', ') || '-'}`,
      `Export ${s.export.reproduction.versions.export_format}`,
      `Report snapshot ${s.snapshot_id} · ${REPORT_CARD_VERSION}`,
    ],
    main_uncertainty: s.main_uncertainty,
    limitations: s.limitations,
  }
  const overview = x.map((e) => ({
    label: e.label,
    spacecraft: spacecraftText(e),
    requirements: e.requirement_verdicts.filter((r) => r.status !== 'not_applicable' && limitText(r)).map((r) => ({ requirement: r.name, limit: limitText(r)! })),
    notes: e.notes,
  }))
  const base = {
    version: REPORT_CARD_VERSION, title: REPORT_TITLE, product: PRODUCT_NAME,
    snapshot_id: s.snapshot_id, generated_at: s.generated_at, labels,
    mission_title: s.mission.title, change: s.mission.change,
    plans, overview, performance, analysis, requirements, strengths, final, sources,
  } as const
  const executive_summary = executiveSummary(base, s)
  const key_findings = [
    final.conclusion,
    ...analysis.findings.filter((f) => f.topic !== 'Requirements' && !f.text.startsWith('No meaningful') && !f.text.startsWith('Cannot')).slice(0, 3).map((f) => f.text),
    `Main uncertainty: ${s.main_uncertainty}`,
  ]
  return { ...base, executive_summary, key_findings, disclaimer: DISCLAIMER }
}
