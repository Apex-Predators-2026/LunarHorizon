// "Show why" from the Scenario Comparison: the canonical evidence window behind a requirement verdict, as the 3D view
// request (viz/evidence.ts). Same selection as the Mission assessment panel (assessment/logic.ts
// evidenceForConstraint) applied to the engine windows the comparison response carries. Nothing is reconstructed
// from the comparison's descriptive statistics.
import { evidenceForConstraint, type ConstraintEvidence } from '../assessment/logic'
import type { EvidenceRequest } from '../../viz/evidence'
import { fmtMetric } from './analysis'
import type { CanonicalMetric, CompareResult, ConstraintItem } from './types'

export type CompareEvidence = { ok: true; evidence: ConstraintEvidence; request: EvidenceRequest } | { ok: false; reason: string }

const UNIT = { h: 'h', '%': '%', deg: 'deg' } as const

/** A canonical metric in the comparison's display units: a value, a range, or "not available" (never 0). */
export function canonicalText(m: CanonicalMetric): string {
  const scale = m.unit === 'fraction' ? 100 : 1
  const unit = m.unit === 'fraction' ? '%' : (UNIT as Record<string, 'h' | '%' | 'deg'>)[m.unit] ?? 'count'
  if (m.status === 'known' && m.value !== null) return fmtMetric(m.value * scale, unit)
  if (m.status === 'bounded' && m.lower !== null && m.upper !== null) return `${fmtMetric(m.lower * scale, unit)} – ${fmtMetric(m.upper * scale, unit)}`
  if (m.status === 'not_applicable') return 'not applicable'
  return 'not available'
}

function thresholdText(c: ConstraintItem): string | undefined {
  if (c.threshold === null) return undefined
  const op = c.comparison === 'at_most' ? '≤ ' : c.comparison === 'at_least' ? '≥ ' : ''
  return op + canonicalText({ status: 'known', unit: c.measured.unit, value: c.threshold, lower: null, upper: null, reason: null })
}

/** The evidence request for one requirement of one compared scenario, or why there is none to show. */
export function compareEvidence(r: CompareResult, siteId: string, c: ConstraintItem, label: string, section?: string): CompareEvidence {
  if (r.data_kind !== 'real')
    return { ok: false, reason: 'Demonstration (synthetic) data: the 3D view shows real data only, so this cannot be shown there.' }
  if (!r.assessment) return { ok: false, reason: 'The viability engine did not assess this plan, so there is no evidence window.' }
  if (c.status === 'not_applicable') return { ok: false, reason: 'Not applicable under this configuration.' }
  const ev = evidenceForConstraint(
    { site: { id: siteId }, windows: r.assessment.windows ?? [] },
    { constraint_id: c.id, name: c.name ?? c.id, status: c.status, evidence_windows: c.evidence_windows },
  )
  if (!ev)
    return {
      ok: false,
      reason: c.status === 'unknown'
        ? 'Undecided, but the engine reported no missing-data window for this body to point at.'
        : 'The engine reported no time window for this requirement (a whole-mission share), so there is no moment to show.',
    }
  const request: EvidenceRequest = {
    ...ev.request,
    requirement: thresholdText(c),
    measured: canonicalText(c.measured),
    origin: { kind: 'comparison', label: `Plan ${label}`, section },
  }
  return { ok: true, evidence: ev, request }
}

/**
 * Canonical constraint behind a shared-contract violation (`Violation.constraint` is the Rescue requirement field).
 * Inverse of backend app/viability/compat/rescue.py CONSTRAINT_TO_RESCUE.
 */
export const CONSTRAINT_FOR_VIOLATION: Record<string, string> = {
  min_sunlight_fraction: 'min_mean_solar_disk_fraction',
  battery_hours: 'max_continuous_darkness',
  min_earth_visibility_fraction: 'min_earth_visibility_percent',
  max_comms_gap_hours: 'max_communication_blackout',
  min_initial_sun_hours: 'min_initial_sunlight',
  min_initial_comms_hours: 'min_initial_earth_visibility',
}

/** The canonical constraint item for a violation of this result, if the engine assessed it. */
export const constraintForViolation = (r: CompareResult, field: string): ConstraintItem | undefined =>
  r.assessment?.constraints.find((c) => c.id === CONSTRAINT_FOR_VIOLATION[field])
