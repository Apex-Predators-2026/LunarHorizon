// CSV / JSON export of the comparison (Phase 7). Pure functions over the data the dashboard displays.
//
// Integrity rules:
//   - a missing value stays missing (JSON null, empty CSV cell with its status in a *_status column), never 0;
//   - UNKNOWN stays "unknown";
//   - a canonical rank is only exported for an eligible PASS scenario, inside its comparable group;
//   - "recommended" is only true for the scenario the decision panel actually recommends.
import type { Eligibility, MissionRequirements } from '../../types'
import { eligibilityOf, requirementSummary, type Entry } from './analysis'
import { buildDecision, withLabels } from './decision'
import { METRIC_FIELDS_ORDER } from './exportFields'
import type { CanonicalMetric, PairEvidence, RankingGroup, SpacecraftConfig } from './types'

export const EXPORT_VERSION = 'comparison-export-v1'

export interface ExportedMetric {
  status: CanonicalMetric['status'] | 'missing'
  unit: string | null
  value: number | null
  lower: number | null
  upper: number | null
}

export interface ExportedRequirement {
  id: string
  name: string
  status: 'pass' | 'fail' | 'unknown' | 'not_applicable'
  comparison: string | null
  threshold: number | null
  measured: ExportedMetric
}

export interface ExportedScenario {
  label: string
  name: string
  origin: string
  site: { id: string; name: string; lat: number; lon: number }
  landing_utc: string
  duration_days: number
  requirements: MissionRequirements
  spacecraft: SpacecraftConfig
  data: {
    kind: string | null // real | demonstration | unavailable | null (not loaded)
    source: string | null
    dataset_id: string | null
    engine_version: string | null
    scoring_method_version: string | null
    sun_coverage_percent: number | null
    earth_coverage_percent: number | null
  }
  eligibility: Eligibility | null // null = not loaded / not assessed (never guessed)
  assessed: boolean
  canonical_rank: number | null // PASS only, within ranking_group
  ranking_group: string | null
  ranking_group_primary: boolean | null
  recommended: boolean
  score: { status: string | null; exact: number | null; lower: number | null; upper: number | null }
  overall_risk: string | null
  failed_requirements: string[]
  undecided_requirements: string[]
  requirement_verdicts: ExportedRequirement[]
  metrics: Record<string, ExportedMetric>
  ranking_explanation: string | null
  message: string | null
}

export interface ComparisonExport {
  format: typeof EXPORT_VERSION
  generated_at: string
  ranking_method: string | null
  ranking_groups: { id: string; primary: boolean; ranked: string[]; members: string[]; separate_reason: string | null; data_basis: string | null }[]
  decisions: { group: string; kind: string; recommended: string | null; headline: string; requirements: string[]; evidence: string[]; tradeoffs: string[]; uncertainty: string[] }[]
  scenarios: ExportedScenario[]
  notes: string[]
  warnings: string[] // inconsistencies found and corrected on export (should be empty)
}

const metric = (m: CanonicalMetric | undefined | null): ExportedMetric =>
  m ? { status: m.status, unit: m.unit, value: m.status === 'known' ? m.value : null,
    lower: m.status === 'bounded' ? m.lower : null, upper: m.status === 'bounded' ? m.upper : null }
    : { status: 'missing', unit: null, value: null, lower: null, upper: null }

export function buildExport(entries: Entry[], groups: RankingGroup[], pairs: PairEvidence[], notes: string[], now = new Date()): ComparisonExport {
  const decision = buildDecision(entries, groups, pairs)
  const recommended = new Set(decision.groups.filter((d) => d.kind === 'recommended' || d.kind === 'single_pass')
    .map((d) => d.recommended?.scenario.id).filter((x): x is string => !!x))
  const labelOfKey = new Map(entries.filter((e) => e.result).map((e) => [e.result!.key, e.scenario.label]))
  const warnings: string[] = []

  const scenarios = entries.map((e): ExportedScenario => {
    const r = e.result, a = r?.assessment, rk = e.ranking
    const el = eligibilityOf(e)
    let rank = rk?.rank ?? null
    if (rank !== null && el !== 'pass') {
      warnings.push(`Scenario ${e.scenario.label}: a rank was reported for a ${el ?? 'non-assessed'} scenario and was not exported.`)
      rank = null
    }
    const req = requirementSummary(e)
    const group = rk?.group ? groups.find((g) => g.id === rk.group) : undefined
    return {
      label: e.scenario.label,
      name: e.scenario.name,
      origin: e.scenario.origin,
      site: { ...e.scenario.site },
      landing_utc: e.scenario.landing_utc,
      duration_days: e.scenario.duration_days,
      requirements: { ...e.scenario.requirements },
      spacecraft: { ...e.scenario.spacecraft },
      data: {
        kind: e.state?.state === 'done' ? e.state.result.data_kind : null,
        source: e.state?.state === 'done' ? e.state.result.data_source : null,
        dataset_id: a?.dataset_id ?? null,
        engine_version: a?.engine_version ?? null,
        scoring_method_version: a?.scoring_method_version ?? null,
        sun_coverage_percent: a?.sun_coverage_percent ?? null,
        earth_coverage_percent: a?.earth_coverage_percent ?? null,
      },
      eligibility: el,
      assessed: !!a,
      canonical_rank: rank,
      ranking_group: rk?.group ?? null,
      ranking_group_primary: group ? group.primary : null,
      recommended: el === 'pass' && recommended.has(e.scenario.id),
      score: {
        status: rk?.score_status ?? null,
        exact: rk?.score_status === 'known' ? rk.score : null,
        lower: rk?.score_status === 'bounded' ? rk.score_lower : null,
        upper: rk?.score_status === 'bounded' ? rk.score_upper : null,
      },
      overall_risk: a?.overall_risk ?? null,
      failed_requirements: req ? req.failed.map((f) => f.name) : [],
      undecided_requirements: req ? req.undecided.map((f) => f.name) : [],
      requirement_verdicts: (a?.constraints ?? []).map((c) => ({
        id: c.id, name: c.name ?? c.id, status: c.status, comparison: c.comparison, threshold: c.threshold, measured: metric(c.measured),
      })),
      metrics: Object.fromEntries(METRIC_FIELDS_ORDER.map((k) => [k, metric(a?.metrics[k])])),
      ranking_explanation: rk?.explanation ? withLabels(rk.explanation, entries, pairs) : null,
      message: e.state?.state === 'done' ? e.state.result.message : e.state?.state === 'error' ? e.state.message : null,
    }
  })

  const lbl = (k: string) => labelOfKey.get(k) ?? k
  return {
    format: EXPORT_VERSION,
    generated_at: now.toISOString(),
    ranking_method: groups[0]?.method_version ?? null,
    ranking_groups: groups.map((g) => ({ id: g.id, primary: g.primary, ranked: g.ranked_keys.map(lbl), members: g.keys.map(lbl),
      separate_reason: g.separate_reason, data_basis: g.data_basis })),
    decisions: decision.groups.map((d) => ({
      group: d.group.id, kind: d.kind, recommended: d.kind === 'recommended' || d.kind === 'single_pass' ? d.recommended?.scenario.label ?? null : null,
      headline: d.headline, requirements: d.requirements.map((r) => r.text), evidence: d.evidence,
      tradeoffs: d.tradeoffs.map((t) => [...t.aBetter.map((x) => `${t.a.scenario.label}: ${x}`), ...t.bBetter.map((x) => `${t.b.scenario.label}: ${x}`)].join('; ')).filter(Boolean),
      uncertainty: d.uncertainty,
    })),
    scenarios,
    notes: [...decision.notes, ...notes],
    warnings,
  }
}

// ---------------------------------------------------------------- CSV

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '' // missing stays missing (its *_status column says why)
  const s = typeof v === 'string' ? v : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : JSON.stringify(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** One row per scenario. Every metric has value / lower / upper / status columns, so bounds and gaps survive. */
export function toCsv(x: ComparisonExport): string {
  const head = [
    'label', 'name', 'site_id', 'site_name', 'lat', 'lon', 'landing_utc', 'duration_days',
    'data_kind', 'data_source', 'dataset_id', 'engine_version', 'scoring_method_version', 'sun_coverage_percent', 'earth_coverage_percent',
    'eligibility', 'assessed', 'canonical_rank', 'ranking_group', 'ranking_group_primary', 'recommended',
    'score_status', 'score', 'score_lower', 'score_upper', 'overall_risk', 'failed_requirements', 'undecided_requirements',
    ...Object.keys(x.scenarios[0]?.requirements ?? {}).map((k) => `req_${k}`),
    ...METRIC_FIELDS_ORDER.flatMap((k) => [k, `${k}_lower`, `${k}_upper`, `${k}_status`]),
  ]
  const rows = x.scenarios.map((s) => [
    s.label, s.name, s.site.id, s.site.name, s.site.lat, s.site.lon, s.landing_utc, s.duration_days,
    s.data.kind, s.data.source, s.data.dataset_id, s.data.engine_version, s.data.scoring_method_version,
    s.data.sun_coverage_percent, s.data.earth_coverage_percent,
    s.eligibility ?? 'not_assessed', s.assessed, s.canonical_rank, s.ranking_group, s.ranking_group_primary, s.recommended,
    s.score.status, s.score.exact, s.score.lower, s.score.upper, s.overall_risk,
    s.failed_requirements.join('; '), s.undecided_requirements.join('; '),
    ...Object.values(s.requirements),
    ...METRIC_FIELDS_ORDER.flatMap((k) => { const m = s.metrics[k]; return [m.value, m.lower, m.upper, m.status] }),
  ].map(cell).join(','))
  return [head.join(','), ...rows].join('\r\n') + '\r\n'
}

/** Trigger a browser download of generated text (no network involved). */
export function downloadText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
