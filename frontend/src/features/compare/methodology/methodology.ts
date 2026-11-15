// Scenario Comparison methodology subpage: the formulas its interactive figures use and the navigation
// between the comparison and the subpage. The formulas mirror the backend engine (backend/app/engine,
// backend/app/viability); they only illustrate it here and never produce a result shown elsewhere.
import { COMPARE_METHODOLOGY, rememberSection, routeHash } from '../../../appRoute'

/** Mean lunar radius used by the horizon engine (km). */
export const MOON_RADIUS_KM = 1737.4
/** Apparent radius of the solar disk seen from the Moon (degrees, about 0.53° across). */
export const SUN_RADIUS_DEG = 0.2665
/** Default panel threshold: the visible solar-disk fraction below which panels count as dark. */
export const DEFAULT_PANEL_THRESHOLD = 0.25

/** How far the surface falls below a flat tangent plane at a distance (metres): d² / 2R. */
export function curvatureDropM(distanceKm: number): number {
  return ((distanceKm * distanceKm) / (2 * MOON_RADIUS_KM)) * 1000
}

/**
 * Elevation angle (degrees) at which terrain `reliefM` above the observer, `distanceKm` away, appears:
 * atan((relief − d²/2R) / d). Curvature lowers distant terrain, so far ridges block less than on a flat map.
 */
export function horizonAngleDeg(reliefM: number, distanceKm: number, curved = true): number {
  if (!(distanceKm > 0)) return 0
  const rise = reliefM - (curved ? curvatureDropM(distanceKm) : 0)
  return (Math.atan2(rise, distanceKm * 1000) * 180) / Math.PI
}

/**
 * Share of the solar disk above the horizon (0..1), the circular-segment area of a disk of radius `r`
 * whose centre is `centreAboveHorizonDeg` above a straight horizon (the engine's sun_fraction).
 */
export function visibleSunFraction(centreAboveHorizonDeg: number, radiusDeg = SUN_RADIUS_DEG): number {
  const u = Math.min(1, Math.max(-1, centreAboveHorizonDeg / radiusDeg))
  return 1 - (Math.acos(u) - u * Math.sqrt(1 - u * u)) / Math.PI
}

export type Verdict = 'PASS' | 'FAIL' | 'UNKNOWN'
export type Comparison = 'at_least' | 'at_most'

/**
 * A requirement's verdict from what the data proves: the measured value lies in [lower, upper] (equal when exact).
 * Minimum: PASS iff lower ≥ t, FAIL iff upper < t. Maximum: PASS iff upper ≤ t, FAIL iff lower > t.
 * Anything else cannot be decided from the evidence, so it is UNKNOWN, never FAIL.
 */
export function decide(comparison: Comparison, lower: number, upper: number, threshold: number): Verdict {
  const lo = Math.min(lower, upper)
  const hi = Math.max(lower, upper)
  const tol = 1e-12 * Math.max(1, Math.abs(threshold))
  if (comparison === 'at_least') {
    if (lo >= threshold - tol) return 'PASS'
    if (hi < threshold - tol) return 'FAIL'
    return 'UNKNOWN'
  }
  if (hi <= threshold + tol) return 'PASS'
  if (lo > threshold + tol) return 'FAIL'
  return 'UNKNOWN'
}

/** Overall eligibility: any FAIL fails the plan, else any UNKNOWN leaves it undecided, else it passes. */
export function eligibility(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('FAIL')) return 'FAIL'
  if (verdicts.includes('UNKNOWN')) return 'UNKNOWN'
  return 'PASS'
}

// ---- pipeline (the subpage's overview steps) ----------------------------------------------------

export interface PipelineStep {
  id: string
  title: string
  short: string
  input: string
  output: string
  where: string
}

export const PIPELINE: PipelineStep[] = [
  { id: 'plan', title: 'Landing plans', short: 'Site, date, length, requirements',
    input: 'Up to four plans, each a curated south-pole site (or a custom point from 80°S to 90°S), a landing time in UTC, a mission length and its spacecraft limits.',
    output: 'A validated request per plan. Plans with an input error are shown with the error and never evaluated.',
    where: 'Scenario editor → POST /api/compare' },
  { id: 'grid', title: 'Hourly grid', short: 'Snap to whole UTC hours',
    input: 'The landing time and mission length.',
    output: 'The evaluated window: the landing rounded to the nearest whole UTC hour and the length to whole hours, matching the precomputed hourly data (2026–2031).',
    where: 'backend/app/mission_time.py, timegrid.py' },
  { id: 'geometry', title: 'Sun & Earth geometry', short: 'JPL Horizons + LOLA horizons',
    input: 'Topocentric Sun and Earth azimuth, elevation and size from NASA JPL Horizons; the site’s 720-direction terrain horizon from LRO LOLA elevation models.',
    output: 'For every hour: the visible share of the solar disk, whether Earth’s centre clears the terrain, and each body’s clearance above the horizon.',
    where: 'backend/app/engine (horizon, ephemeris)' },
  { id: 'metrics', title: 'Mission metrics', short: 'Durations, shares, longest outages',
    input: 'The hourly conditions over the evaluated window.',
    output: 'Sunlight and Earth-visibility shares, longest power darkness and communication blackout, initial windows after landing, mean clearances. Each is exact, or a proven range when hours are missing.',
    where: 'backend/app/viability/metrics.py' },
  { id: 'verdicts', title: 'Requirement verdicts', short: 'Pass / Fail / Unknown',
    input: 'Each metric’s value or range, and the plan’s limits.',
    output: 'A verdict per requirement and an overall eligibility: any Fail fails the plan, otherwise any Unknown leaves it undecided.',
    where: 'backend/app/viability/constraints.py' },
  { id: 'ranking', title: 'Ranking & decision', short: 'Fair groups, weighted score',
    input: 'Eligible plans, grouped so that only plans judged by identical rules are compared.',
    output: 'A rank and desirability score within each group, pairwise evidence of what differs, and the recommendation (or the reason there is none).',
    where: 'backend/app/viability/ranking.py, scoring.py; frontend decision.ts' },
  { id: 'report', title: 'Report & assistant', short: 'Frozen snapshot, read-only AI',
    input: 'The comparison exactly as shown.',
    output: 'A Mission Report (preview and PDF) frozen at the moment it is made, and a Mission Assistant that only explains these results and never changes them.',
    where: 'frontend report.ts, ReportCardPdf.tsx; backend /api/assistant' },
]

// ---- navigation ------------------------------------------------------------------------------

/** Set while the subpage was opened from the comparison in this tab, so Back can return to that exact entry. */
const FROM_COMPARISON = 'cmp-methodology-from-comparison'
/** The intro section at the bottom of the comparison: where Back returns to. */
export const METHODOLOGY_INTRO_ID = 'cmp-methodology'

function session(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Open the methodology subpage (a new history entry). The comparison's entry first remembers this spot. */
export function openMethodology() {
  rememberSection(METHODOLOGY_INTRO_ID)
  try {
    session()?.setItem(FROM_COMPARISON, '1')
  } catch {
    /* storage blocked: Back falls back to a plain link */
  }
  window.location.hash = routeHash('compare', COMPARE_METHODOLOGY)
}

/**
 * Back to the comparison. Opened from it: step back in history, so the comparison comes back exactly as it was
 * (same entry, same section). Opened from a link or a refresh: go to the comparison's methodology intro.
 */
export function backToComparison() {
  let fromComparison = false
  try {
    fromComparison = session()?.getItem(FROM_COMPARISON) === '1'
    session()?.removeItem(FROM_COMPARISON)
  } catch {
    /* storage blocked */
  }
  if (fromComparison && window.history.length > 1) window.history.back()
  else window.location.hash = routeHash('compare', METHODOLOGY_INTRO_ID)
}
