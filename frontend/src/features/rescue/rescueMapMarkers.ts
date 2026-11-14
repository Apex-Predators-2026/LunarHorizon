// Pure logic for the rescue overlay in the 3D view: which markers to draw for a rescue result.
// Kept free of three.js / React so it is easy to test.
import type { Scenario, Violation } from '../../types'
import { verdictOf } from '../../types'
import type { RescueCatalog, RescueResponse } from './types'

export const ALT_COLOR = '#ff634a'
export const FAIL_COLOR = '#f0605a'
/** Same grey the panels use for an unknown verdict (--color-unknown). */
export const UNKNOWN_COLOR = '#8691a9'
/** The changed plan's pin is shorter than the alternatives' so both stay visible at a shared site. */
export const FAILING_STEM_SCALE = 0.55

export interface RescueMarker {
  id: string
  kind: 'alternative' | 'failing' | 'near_miss'
  siteId: string
  lat: number
  lon: number
  label: string
  color: string
  /** Alternatives only: the best (lowest) rank at this site. */
  rank?: number
  selected: boolean
  /** Pin height relative to the standard stem (default 1). */
  stemScale?: number
}

const SHORT: Record<string, string> = {
  min_sunlight_fraction: 'sunlight',
  battery_hours: 'power darkness',
  panel_threshold: 'panel output',
  min_earth_visibility_fraction: 'Earth contact',
  max_comms_gap_hours: 'comms blackout',
  min_initial_sun_hours: 'initial sunlight',
  min_initial_comms_hours: 'initial Earth contact',
  data_coverage: 'no real data',
}

/** Short reasons (at most two, de-duplicated) for a list of violations. */
export function reasonText(violations: Violation[], max = 2): string {
  const out: string[] = []
  for (const v of violations) {
    const t = SHORT[v.constraint] ?? v.constraint.replace(/_/g, ' ')
    if (!out.includes(t)) out.push(t)
  }
  const more = out.length - max
  return out.slice(0, max).join(', ') + (more > 0 ? ` +${more} more` : '')
}

type Coord = { lat: number; lon: number }

/** Coordinates from the rescue catalog, else from the response's own site, else null. */
function coordsOf(site: Scenario['site'], catalog: RescueCatalog | null): Coord | null {
  const c = catalog?.sites.find((s) => s.id === site.id)
  for (const p of [c, site]) {
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return { lat: p.lat, lon: p.lon }
  }
  return null
}

export function rescueMapMarkers(
  result: RescueResponse | null,
  catalog: RescueCatalog | null,
  selected: Scenario | null = null,
): RescueMarker[] {
  if (!result) return []
  const markers: RescueMarker[] = []

  // One pin per alternative site, labelled with its best rank.
  const bySite = new Map<string, RescueMarker>()
  for (const a of result.alternatives) {
    const site = a.scenario.site
    const isSel = selected === a.scenario
    const prev = bySite.get(site.id)
    if (prev) {
      prev.selected ||= isSel
      if (a.rank < (prev.rank ?? Infinity)) {
        prev.rank = a.rank
        prev.label = `#${a.rank}`
      }
      continue
    }
    const c = coordsOf(site, catalog)
    if (!c) continue
    const m: RescueMarker = {
      id: `alt:${site.id}`, kind: 'alternative', siteId: site.id, ...c,
      label: `#${a.rank}`, color: ALT_COLOR, rank: a.rank, selected: isSel,
    }
    bySite.set(site.id, m)
    markers.push(m)
  }

  // The changed plan's own site, when it fails (or cannot be decided).
  const used = new Set(markers.map((m) => m.siteId))
  const changed = result.changed
  const verdict = verdictOf(changed)
  if (verdict !== 'pass') {
    const site = changed.scenario.site
    const c = coordsOf(site, catalog)
    if (c) {
      const delayed = changed.scenario.landing_utc !== result.original.scenario.landing_utc
      const name = delayed ? 'Plan after delay' : 'Changed plan'
      const unknown = verdict === 'unknown'
      const why = reasonText(changed.violations)
      markers.push({
        id: `fail:${site.id}`, kind: 'failing', siteId: site.id, ...c,
        label: unknown
          ? 'Changed plan: unknown (no real data)'
          : why ? `${name} fails: ${why}` : `${name} fails`,
        color: unknown ? UNKNOWN_COLOR : FAIL_COLOR, selected: false, stemScale: FAILING_STEM_SCALE,
      })
      used.add(site.id)
    }
  }

  // Closest failing options at other sites, one dot per site, with the rule broken.
  for (const n of result.near_misses) {
    const site = n.scenario.site
    if (used.has(site.id)) continue
    const c = coordsOf(site, catalog)
    if (!c) continue
    used.add(site.id)
    const why = reasonText(n.viability.violations)
    markers.push({
      id: `miss:${site.id}`, kind: 'near_miss', siteId: site.id, ...c,
      label: why ? `Fails: ${why}` : 'Fails', color: FAIL_COLOR, selected: false,
    })
  }
  // Draw order: failing/near-miss first, alternatives last, so a coral pin is never covered by a red one.
  return [...markers.filter((x) => x.kind !== 'alternative'), ...markers.filter((x) => x.kind === 'alternative')]
}

/** The markers the 3D overlay draws for the current store state; none when there is no result or "Show on map" is off. */
export function overlayMarkers(state: {
  rescue: RescueResponse | null
  showOnMap: boolean
  selected: Scenario | null
  catalog: RescueCatalog | null
}): RescueMarker[] {
  return state.showOnMap && state.rescue ? rescueMapMarkers(state.rescue, state.catalog, state.selected) : []
}

/** Far-zoom summary text. Counts alternatives, not sites; an unknown plan is never called a failure. */
export function summaryText(result: RescueResponse): string {
  const n = result.alternatives.length
  const v = verdictOf(result.changed)
  const plan = v === 'unknown' ? ', plan unknown' : v === 'pass' ? '' : ', plan fails'
  return `Rescue: ${n} ${n === 1 ? 'option' : 'options'}${plan}`
}
