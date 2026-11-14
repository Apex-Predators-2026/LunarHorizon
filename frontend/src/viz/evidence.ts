// "Show me why": any panel can point the 3D view at the evidence for a result (e.g. a failed constraint's
// evidence window from the viability engine). The 3D view then selects the site, pauses, jumps to the
// moment, and looks at the body concerned from the lander (the Sun for darkness/power, Earth for
// communications), where the blocker line and horizon show the terrain responsible; the window is shaded
// on the time strip. See docs/interfaces.md ("Show me why").
import { create } from 'zustand'

export type EvidenceBody = 'sun' | 'earth'

export interface EvidenceRequest {
  siteId: string
  startUtc: string // the moment to show (e.g. the start of the longest darkness)
  endUtc?: string | null // the end of the window, to shade it on the time strip
  body: EvidenceBody
}

export const useEvidence = create<{ request: (EvidenceRequest & { id: number }) | null }>(() => ({ request: null }))

/** Point the 3D view at a moment of evidence (see the module comment). */
export function showEvidence(request: EvidenceRequest) {
  useEvidence.setState((s) => ({ request: { ...request, id: (s.request?.id ?? 0) + 1 } }))
}

/** Clear the shaded evidence window (e.g. when the panel that asked closes). */
export const clearEvidence = () => useEvidence.setState({ request: null })

// The viability engine's window kinds (backend app/viability/enums.py WindowKind) -> what to look at.
const SUN_KINDS = new Set(['sunlight', 'darkness', 'full_sunlight', 'partial_sunlight', 'power_lit', 'power_dark', 'sun_unknown', 'power_unknown'])
const EARTH_KINDS = new Set(['earth_visible', 'communication_blackout', 'earth_unknown'])

/**
 * Which body explains a viability evidence window (`evidence_windows[].kind`): the Sun for sunlight and power,
 * Earth for communications. Windows needing both (simultaneous_*) show the Sun, since power is the usual
 * limit; unknown_data (no data at all) has nothing to show, so null.
 */
export function bodyForWindowKind(kind: string): EvidenceBody | null {
  if (SUN_KINDS.has(kind) || kind.startsWith('simultaneous')) return 'sun'
  if (EARTH_KINDS.has(kind)) return 'earth'
  return null
}

/** Convenience for a viability evidence window: null if it has nothing to show (see bodyForWindowKind). */
export function evidenceFromWindow(
  siteId: string,
  w: { kind: string; start_utc: string; end_utc: string },
): EvidenceRequest | null {
  const body = bodyForWindowKind(w.kind)
  return body ? { siteId, startUtc: w.start_utc, endUtc: w.end_utc, body } : null
}
