// The stored validation report's summary (GET /api/validation). The backend derives every number here from the
// per-site results it serves with it, so the panel shows these and never hand-typed figures.

export interface ValidationRun {
  run_utc: string
  code_commit: string
  sites: number
  site_generator_versions: string[]
  data_range: string
}

interface CheckBase {
  kind: string
  date: string
  scope: string
  reference: string
  limitation: string
}

export interface EphemerisCheck extends CheckBase {
  max_separation_deg: number
  max_rms_deg: number
  verdict_checks: number
  verdict_changes: number
}

export interface HorizonCheck extends CheckBase {
  max_difference_deg: { min: number; max: number; site: string }
  per_site_max_deg: Record<string, number>
  mirrored_max_deg: { min: number; max: number }
}

export interface SitePixel {
  model_any_sun_pct: number
  lroc_pct: number
  lroc_3x3_pct: [number, number]
}

export interface AreaComparison {
  points: number
  grid: string
  /** null when there is no variation to correlate (e.g. a permanently dark crater floor). */
  pearson_r: number | null
  mean_bias_pct: number
  mean_abs_diff_pct: number
  lroc_mean_pct: number
}

export interface IlluminationCheck extends CheckBase {
  site_pixel: Record<string, SitePixel>
  area: Record<string, AreaComparison>
}

export interface ValidationSummary {
  run: ValidationRun
  ephemeris_agreement?: EphemerisCheck
  horizon_method?: HorizonCheck
  illumination_observed?: IlluminationCheck
}

export async function fetchValidation(signal?: AbortSignal): Promise<ValidationSummary> {
  const r = await fetch('/api/validation', { signal })
  if (!r.ok) throw new Error(r.status === 404 ? 'No validation report has been generated yet.' : `The backend answered ${r.status}.`)
  const body = (await r.json()) as { summary: ValidationSummary }
  return body.summary
}

// ---------------------------------------------------------------- viability engine (software verification)
// GET /api/viability/validation-summary (docs/viability-api.md §2): the stored report of the viability engine's
// validation suite (python -m app.viability.validation). It verifies that the engine follows its own rules on the
// real site files; it is not an independent scientific validation (that is /api/validation above).

export interface ViabilityCase {
  name: string
  category: string
  synthetic: boolean
  passed: boolean
  check_count: number
  failed_checks: string[]
  inputs: Record<string, unknown>
  outcome: Record<string, unknown>
}

export interface ViabilityDataset {
  site_id: string
  file: string
  sha256: string
  current_sha256: string | null
  unchanged: boolean
  is_synthetic: boolean
  calculation_basis: string
  coverage_start_utc: string
  coverage_end_utc: string
  sample_count: number
}

export interface ViabilityValidationSummary {
  api_version: string
  status: 'passed' | 'failed' | string
  validation_version: string
  generated_utc: string
  report_file: string
  regenerate_command: string
  versions: Record<string, string>
  currency: {
    current: boolean
    version_mismatches: (string | Record<string, unknown>)[]
    changed_datasets: (string | Record<string, unknown>)[]
    unvalidated_datasets: (string | Record<string, unknown>)[]
    note: string
  }
  totals: { checks: number; failed: number; smoke_checks: number; smoke_failed: (string | Record<string, unknown>)[] }
  cases: ViabilityCase[]
  invariants: { name: string; passed: boolean; detail: string }[]
  datasets: ViabilityDataset[]
  standard_lander: Record<string, number>
  timing: {
    evaluate_scenario_median_ms: number | null
    evaluate_scenario_p95_ms: number | null
    evaluate_scenario_workload: string | null
    machine: Record<string, string | number> | null
  } | null
  limitations: string[]
}

/** The report, or exactly why there is none. Nothing here ever stands in for a result that was not produced. */
export type ViabilityValidationState =
  | { status: 'loading' }
  | { status: 'loaded'; summary: ViabilityValidationSummary }
  | { status: 'missing'; detail: string } // 404: no report has been generated
  | { status: 'unavailable'; detail: string } // backend down, other error or malformed answer

export async function fetchViabilityValidation(signal?: AbortSignal): Promise<ViabilityValidationState> {
  let r: Response
  try {
    r = await fetch('/api/viability/validation-summary', { signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    return { status: 'unavailable', detail: 'The backend could not be reached.' }
  }
  if (r.status === 404) {
    let detail = 'No viability validation report has been generated.'
    try {
      const body = (await r.json()) as { detail?: unknown }
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      /* keep the default */
    }
    return { status: 'missing', detail }
  }
  if (!r.ok) return { status: 'unavailable', detail: `The backend answered ${r.status}.` }
  try {
    const summary = (await r.json()) as ViabilityValidationSummary
    if (!summary || !summary.totals || !Array.isArray(summary.cases) || !summary.currency)
      return { status: 'unavailable', detail: 'The backend returned an incomplete report summary.' }
    return { status: 'loaded', summary }
  } catch {
    return { status: 'unavailable', detail: 'The backend returned an unreadable report summary.' }
  }
}

export type ReportVerdict = 'current_pass' | 'stale_pass' | 'failed'

/** The report's own verdict, with currency: a pass that no longer matches the running code or data is "stale". */
export function reportVerdict(s: ViabilityValidationSummary): ReportVerdict {
  const anyFailed =
    s.status !== 'passed' ||
    s.totals.failed > 0 ||
    s.totals.smoke_failed.length > 0 ||
    s.cases.some((c) => !c.passed) ||
    s.invariants.some((i) => !i.passed)
  if (anyFailed) return 'failed'
  return s.currency.current ? 'current_pass' : 'stale_pass'
}

/** "connecting-ridge" -> "Connecting Ridge" (site ids in the report are slugs). */
export const siteName = (id: string) =>
  id
    .split('-')
    .map((w) => (w === 'im' ? 'IM' : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
