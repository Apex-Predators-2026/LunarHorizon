// Pure helpers for things drawn on the Moon's surface (markers, PSR outlines, failure lines).
import { MOON_RADIUS_M, SiteFrame, latLonToVec, type Vec3 } from './cubeSphere'

/** Site-frame position of a surface point (lat, lon, height above the 1737.4 km sphere), lifted by `lift` m. */
export function surfacePoint(frame: SiteFrame, lat: number, lon: number, heightM: number, lift = 0): Vec3 {
  const u = latLonToVec(lat, lon)
  const r = MOON_RADIUS_M + heightM + lift
  return frame.toSite([u[0] * r, u[1] * r, u[2] * r])
}

/** Great-circle destination: from (lat, lon) along a bearing (clockwise from north) for d metres. */
export function destination(latDeg: number, lonDeg: number, azDeg: number, distM: number): [number, number] {
  const D = Math.PI / 180
  const lat1 = latDeg * D
  const lon1 = lonDeg * D
  const a = azDeg * D
  const d = distM / MOON_RADIUS_M
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(a))
  const lon2 = lon1 + Math.atan2(Math.sin(a) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  return [lat2 / D, (((lon2 / D) % 360) + 360) % 360]
}

/** Horizon value at an azimuth from the 0.5-degree mask (nearest bin), or null if unknown. */
export function horizonAt(az: number[], values: (number | null)[], azDeg: number): number | null {
  if (!az.length) return null
  const step = az.length > 1 ? az[1] - az[0] : 360
  const i = Math.round((((azDeg % 360) + 360) % 360) / step) % az.length
  return values[i]
}

export interface Blocker {
  body: 'sun' | 'earth'
  azimuthDeg: number
  distanceM: number // to the terrain point that sets the horizon
  horizonDeg: number // how high that terrain rises, seen from the lander
  bodyDeg: number // body's elevation
  marginDeg: number // bodyDeg - horizonDeg (< 0 = blocked)
  // Site-frame positions: the lander's eye and the blocking terrain point.
  from: Vec3
  to: Vec3
}

/**
 * Where the terrain blocks a body: the point on the horizon in the body's direction. That point
 * sits at distance d along the great circle, at height eye + d*tan(horizon) above the eye's local
 * horizontal (minus the Moon's curvature, already inside the horizon angle the engine computed).
 * For drawing we place it on the line of sight: eye + d * direction(az, horizon).
 */
export function blockerLine(
  body: 'sun' | 'earth',
  azimuthDeg: number,
  bodyDeg: number,
  horizonDeg: number | null,
  distanceM: number | null,
  eyeHeightM: number,
): Blocker | null {
  if (horizonDeg === null || distanceM === null || bodyDeg >= horizonDeg) return null
  const D = Math.PI / 180
  const az = azimuthDeg * D
  const el = horizonDeg * D
  // Slant range so that the horizontal distance is the engine's (great-circle) distance.
  const slant = distanceM / Math.cos(el)
  const dir: Vec3 = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]
  const from: Vec3 = [0, eyeHeightM, 0]
  const to: Vec3 = [dir[0] * slant, eyeHeightM + dir[1] * slant, dir[2] * slant]
  return { body, azimuthDeg, distanceM, horizonDeg, bodyDeg, marginDeg: bodyDeg - horizonDeg, from, to }
}

export const fmtDistance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`)

/** Marker colour by site kind (see backend/app/engine/sites.py). */
export const KIND_COLOR: Record<string, string> = {
  artemis: '#38bdf8',
  apollo: '#f59e0b',
  clps: '#a78bfa',
  international: '#34d399',
  control: '#94a3b8',
  custom: '#f97316',
}

/** Artemis sites whose region isn't on NASA's current (2024) list: a paler, greyer blue. */
export const ARTEMIS_FORMER_COLOR = '#7c93b8'

/** Marker colour of a site: by kind, and for Artemis sites by whether NASA's current list names the region. */
export function siteColor(s: { kind?: string; artemis_list?: string | null }): string {
  if (s.kind === 'artemis' && s.artemis_list && s.artemis_list !== '2024') return ARTEMIS_FORMER_COLOR
  return KIND_COLOR[s.kind ?? 'custom'] ?? KIND_COLOR.custom
}

/** What an Artemis site's status means, for tooltips (null for other sites). Sources: backend engine/sites.py. */
export function artemisNote(s: { artemis_list?: string | null }): string | null {
  switch (s.artemis_list) {
    case '2024':
      return "Artemis III candidate region: one of the 9 in NASA's October 2024 update"
    case '2022':
      return "In NASA's original 13 Artemis III candidate regions (2022), not among the 9 of the October 2024 update (NASA: that doesn't make it unsuitable for future exploration)"
    case 'unconfirmed':
      return "Approximate point at de Gerlache Rim: NASA's 2024 list keeps de Gerlache Rim 2 and dropped Rim 1; which one this point is in isn't confirmed"
    default:
      return null
  }
}

type BodyStep = { azimuth_deg: number; elevation_deg: number; horizon_deg: number | null }

/** The Sun/Earth blockers at one hour, from the engine's horizon mask (empty when both are clear). */
export function currentBlockers(
  step: { sun: BodyStep; earth: BodyStep } | null,
  horizon: { azimuth_deg: number[]; elevation_deg: (number | null)[]; distance_m: (number | null)[] } | null,
  eyeHeightM: number,
): Blocker[] {
  if (!step || !horizon) return []
  const out: Blocker[] = []
  for (const body of ['sun', 'earth'] as const) {
    const b = step[body]
    const h = b.horizon_deg ?? horizonAt(horizon.azimuth_deg, horizon.elevation_deg, b.azimuth_deg)
    const d = horizonAt(horizon.azimuth_deg, horizon.distance_m, b.azimuth_deg)
    const line = blockerLine(body, b.azimuth_deg, b.elevation_deg, h, d, eyeHeightM)
    if (line) out.push(line)
  }
  return out
}
