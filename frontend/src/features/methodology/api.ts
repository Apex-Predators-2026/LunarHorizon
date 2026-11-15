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

/** "connecting-ridge" -> "Connecting Ridge" (site ids in the report are slugs). */
export const siteName = (id: string) =>
  id
    .split('-')
    .map((w) => (w === 'im' ? 'IM' : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
