// Scenario objects and adapters for the comparison workspace. Pure functions, no React.
import { DEFAULT_REQUIREMENTS, type Scenario, type Site, type SiteInfo } from '../../types'
import type { ComparisonScenario, ScenarioOrigin, SpacecraftConfig } from './types'

/** Site option for pickers: from /api/sites, or the offline fallback below. */
export interface SiteOption extends Site {
  source: string
  ground_height_m: number | null
  isControl: boolean // validation controls (e.g. the permanently shadowed crater floor)
  summary: SiteInfo['summary'] | null
  dataRange: [string, string] | null
}

// Offline fallback: the data engine's curated sites with their published coordinates
// (backend/app/engine/sites.py). Used only to keep the picker usable when the backend is down;
// no data is ever derived from these entries in the browser.
export const FALLBACK_SITES: SiteOption[] = [
  { id: 'peak-near-shackleton', name: 'Peak Near Shackleton', lat: -89.01701, lon: 126.27302,
    source: 'Gracy & Lee 2024, LPSC 55, abstract 1695', ground_height_m: null, isControl: false, summary: null, dataRange: null },
  { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326,
    source: 'Local summit in the Moon Trek 30 m LOLA DEM (see backend/app/engine/sites.py)', ground_height_m: null,
    isControl: false, summary: null, dataRange: null },
  { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.53432, lon: 209.94767,
    source: 'Gracy & Lee 2024, LPSC 55, abstract 1695', ground_height_m: null, isControl: false, summary: null, dataRange: null },
]

const CONTROL_IDS = new Set(['shackleton-floor'])

export const siteOptionFromInfo = (s: SiteInfo): SiteOption => ({
  id: s.id, name: s.name, lat: s.lat, lon: s.lon, source: s.source, ground_height_m: s.ground_height_m,
  isControl: CONTROL_IDS.has(s.id), summary: s.summary, dataRange: [s.data_start_utc, s.data_stop_utc],
})

/** Example lander configuration. Clearly user-editable values, not a real spacecraft. */
export const DEFAULT_SPACECRAFT: SpacecraftConfig = {
  panel_mode: 'vertical_sun_tracking',
  panel_azimuth_deg: 0,
  panel_rated_power_w: 400,
  average_load_w: 150,
  battery_capacity_wh: 7500,
}

export const PANEL_MODE_LABEL: Record<SpacecraftConfig['panel_mode'], string> = {
  vertical_sun_tracking: 'Vertical, tracks Sun azimuth',
  vertical_fixed: 'Vertical, fixed direction',
  horizontal: 'Horizontal (faces up)',
  two_axis: 'Two-axis tracking (ideal)',
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

let counter = 0
export const newId = () => `sc-${Date.now().toString(36)}-${(counter++).toString(36)}`

/** Next free letter: A..Z, then A2, B2... */
export function nextLabel(existing: string[]): string {
  const used = new Set(existing)
  for (let round = 1; ; round++) {
    for (let i = 0; i < 26; i++) {
      const l = String.fromCharCode(65 + i) + (round > 1 ? round : '')
      if (!used.has(l)) return l
    }
  }
}

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export const autoName = (site: Site, landingUtc: string, days: number) =>
  `${site.name} · ${fmtDate(landingUtc)} · ${days} d`

export function makeScenario(
  init: Partial<ComparisonScenario> & { site: Site; landing_utc: string },
  existingLabels: string[],
  origin: ScenarioOrigin = 'user',
): ComparisonScenario {
  const duration_days = init.duration_days ?? 14
  return {
    id: newId(),
    label: nextLabel(existingLabels),
    name: init.name ?? autoName(init.site, init.landing_utc, duration_days),
    site: { id: init.site.id, name: init.site.name, lat: init.site.lat, lon: init.site.lon },
    landing_utc: new Date(init.landing_utc).toISOString(),
    duration_days,
    requirements: { ...DEFAULT_REQUIREMENTS, ...init.requirements },
    spacecraft: { ...DEFAULT_SPACECRAFT, ...init.spacecraft },
    origin,
    notes: init.notes,
    colorSlot: init.colorSlot ?? 0,
  }
}

export const shiftIso = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * DAY).toISOString()

/** Copy of a scenario with its landing moved by `days` (fractions allowed). */
export function duplicateShifted(s: ComparisonScenario, days: number, existingLabels: string[]): ComparisonScenario {
  const landing = shiftIso(s.landing_utc, days)
  const nameWasAuto = s.name === autoName(s.site, s.landing_utc, s.duration_days)
  return {
    ...structuredClone(s),
    id: newId(),
    label: nextLabel(existingLabels),
    landing_utc: landing,
    name: nameWasAuto || days !== 0 ? autoName(s.site, landing, s.duration_days) : `${s.name} (copy)`,
    origin: 'duplicate',
    notes: days ? `Copy of ${s.label}, landing ${days > 0 ? '+' : ''}${days} d` : `Copy of ${s.label}`,
  }
}

/** The team's shared Scenario (src/types.ts) for an API call. */
export const toTeamScenario = (s: ComparisonScenario): Scenario => ({
  site: s.site,
  landing_utc: s.landing_utc,
  duration_days: s.duration_days,
  requirements: s.requirements,
})

/** Import a team Scenario (e.g. from Mission Rescue) into the workspace. */
export const fromTeamScenario = (
  sc: Scenario,
  existingLabels: string[],
  origin: ScenarioOrigin,
  extra: Partial<ComparisonScenario> = {},
): ComparisonScenario =>
  makeScenario({ ...extra, site: sc.site, landing_utc: sc.landing_utc, duration_days: sc.duration_days,
    requirements: sc.requirements }, existingLabels, origin)

/** Identifies everything that changes the backend's answer. Results are cached by this key. */
export const resultKey = (s: ComparisonScenario, allowDemo: boolean) =>
  JSON.stringify([s.site.id, s.site.lat, s.site.lon, s.landing_utc, s.duration_days, s.requirements, s.spacecraft, allowDemo])

/** Identifies a selected set (in selection order). A canonical ranking belongs to exactly one set. */
export const selectionKey = (selected: ComparisonScenario[], allowDemo: boolean) =>
  JSON.stringify(selected.map((s) => resultKey(s, allowDemo)))

/** Problems that would make the backend reject the scenario (checked before sending). */
export function validateScenario(s: ComparisonScenario): string[] {
  const out: string[] = []
  if (!s.site?.id) out.push('Pick a landing site.')
  if (!Number.isFinite(s.site?.lat) || s.site.lat < -90 || s.site.lat > 90) out.push('Latitude must be −90…90°.')
  if (!Number.isFinite(s.site?.lon)) out.push('Longitude is missing.')
  if (Number.isNaN(new Date(s.landing_utc).getTime())) out.push('Landing date/time is invalid.')
  if (!(s.duration_days > 0 && s.duration_days <= 365)) out.push('Mission duration must be between 0 and 365 days.')
  const r = s.requirements
  for (const k of ['min_sunlight_fraction', 'panel_threshold', 'min_earth_visibility_fraction'] as const) {
    if (!(r[k] >= 0 && r[k] <= 1)) out.push(`${k} must be between 0 and 1.`)
  }
  if (!(r.battery_hours > 0)) out.push('Max darkness (battery hours) must be > 0.')
  if (!(r.max_comms_gap_hours > 0)) out.push('Max communication blackout must be > 0.')
  return out
}

/** Mission end time. */
export const missionEnd = (s: Pick<ComparisonScenario, 'landing_utc' | 'duration_days'>) =>
  new Date(new Date(s.landing_utc).getTime() + s.duration_days * DAY).toISOString()

export const hoursBetween = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / HOUR
