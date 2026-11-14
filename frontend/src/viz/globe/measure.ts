// Geodesic, 3D surface distance, LOLA elevation/slope profile, lunar curvature drop, and
// point-to-point Line-of-Sight (LOS) relay calculations on the 1737.4 km MEAN_ME lunar sphere.
import type { PsrData } from '../../types'
import { MOON_RADIUS_M, SiteFrame, latLonToVec, vecToLatLon, type Vec3 } from './cubeSphere'
import { surfacePoint } from './overlays'
import { groundHeightAt, type TileHeights } from './terrainHeight'

const DEG = Math.PI / 180

/** NASA Artemis EVA & VIPER/CLPS rover slope thresholds (degrees). */
export const SLOPE_WARN_DEG = 10
export const SLOPE_CRIT_DEG = 20

export type SlopeStatus = 'ok' | 'warn' | 'crit'

export interface MeasureWaypoint {
  id: string
  label: string // 'A', 'B', 'C', ...
  name?: string // optional user-defined custom label, e.g. 'Lander', 'Relay Ridge', 'Ice Target'
  lat: number
  lon: number
  heightM: number // metres above the 1737.4 km reference sphere
}

export interface WaypointStat {
  id: string
  label: string
  name: string
  lat: number
  lon: number
  heightM: number
  cumulativeGeodesicM: number
  cumulativeSurfaceM: number
  segmentSurfaceM: number
  segmentBearingDeg: number | null
  segmentMaxSlopeDeg: number
  segmentSlopeStatus: SlopeStatus
}

export interface MeasureSegment {
  fromIndex: number
  toIndex: number
  geodesicDistanceM: number
  surfaceDistanceM: number
  bearingDeg: number
  netElevationM: number
  maxSlopeDeg: number
  midpointSitePos: Vec3
}

export interface ProfileSample {
  index: number
  segmentIndex: number
  distanceM: number // cumulative great-circle distance from Waypoint A (m)
  surfaceDistanceM: number // cumulative 3D terrain-following distance from Waypoint A (m)
  lat: number
  lon: number
  heightM: number // LOLA terrain elevation above 1737.4 km sphere (m)
  slopeDeg: number // local terrain grade (deg)
  slopeStatus: SlopeStatus
  losHeightM: number // height of the straight 3D Line-of-Sight chord above the 1737.4 km sphere at this sample (m)
  losClearanceM: number // losHeightM - heightM (negative = blocked by terrain ridge + lunar curvature)
  sitePos: Vec3 // [x east, y up, z -north] in the active SiteFrame, lifted slightly for 3D rendering
}

export interface MeasureAnalysis {
  waypoints: MeasureWaypoint[]
  waypointStats: WaypointStat[]
  segments: MeasureSegment[]
  samples: ProfileSample[]
  geodesicDistanceM: number
  surfaceDistanceM: number
  initialBearingDeg: number // A -> B (or A -> last) in [0, 360) clockwise from true north
  compassRose: string // e.g. 'SE', 'NNW'
  netElevationChangeM: number
  totalAscentM: number
  totalDescentM: number
  minHeightM: number
  maxHeightM: number
  maxSlopeDeg: number
  meanSlopeDeg: number
  slopeStatus: SlopeStatus
  curvatureDropM: number // d^2 / (2 * R_Moon) over the total geodesic distance
  losClear: boolean // true if straight 3D ray between first and last waypoint (at mastHeightM) clears all terrain
  losMinClearanceM: number // minimum vertical clearance (m) along the A -> last sightline
  losBlockerDistanceM: number | null // distance from A where the worst terrain obstruction occurs, if blocked
  nearestIceDistanceM: number | null // distance from final waypoint to nearest Moon Trek surface-ice / PSR point
  nearestPsrName: string | null
}

/** Great-circle surface arc distance (metres) on the 1737.4 km Moon sphere between two coordinates. */
export function greatCircleDistanceM(lat1Deg: number, lon1Deg: number, lat2Deg: number, lon2Deg: number): number {
  const u = latLonToVec(lat1Deg, lon1Deg)
  const v = latLonToVec(lat2Deg, lon2Deg)
  const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))
  const cross = Math.hypot(
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  )
  return MOON_RADIUS_M * Math.atan2(cross, dot)
}

/**
 * Forward azimuth (degrees in [0, 360), clockwise from true North) from (lat1, lon1) to (lat2, lon2)
 * in the Moon's Mean-Earth (MEAN_ME) frame. At the exact south/north pole, uses the meridian lon2.
 */
export function initialBearingDeg(lat1Deg: number, lon1Deg: number, lat2Deg: number, lon2Deg: number): number {
  if (Math.abs(lat1Deg - lat2Deg) < 1e-9 && Math.abs(lon1Deg - lon2Deg) < 1e-9) return 0
  const lat1 = lat1Deg * DEG
  const lon1 = lon1Deg * DEG
  const lat2 = lat2Deg * DEG
  const lon2 = lon2Deg * DEG
  const dLon = lon2 - lon1
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(y, x) / DEG) % 360 + 360) % 360
}

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

export function bearingToCompass(azDeg: number): string {
  const norm = ((azDeg % 360) + 360) % 360
  return COMPASS_16[Math.round(norm / 22.5) % 16]
}

export function classifySlope(slopeDeg: number): SlopeStatus {
  if (slopeDeg > SLOPE_CRIT_DEG) return 'crit'
  if (slopeDeg > SLOPE_WARN_DEG) return 'warn'
  return 'ok'
}

/** Lunar horizon drop d^2 / (2 * R_Moon) in metres for a horizontal distance d (metres). */
export function lunarCurvatureDropM(distanceM: number): number {
  return (distanceM * distanceM) / (2 * MOON_RADIUS_M)
}

/** Spherical linear interpolation (slerp) between two unit vectors on the Moon sphere. */
function slerpUnitVec(u: Vec3, v: Vec3, t: number): Vec3 {
  if (t <= 0) return u
  if (t >= 1) return v
  const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))
  const omega = Math.acos(dot)
  if (omega < 1e-7) {
    const x = u[0] + t * (v[0] - u[0])
    const y = u[1] + t * (v[1] - u[1])
    const z = u[2] + t * (v[2] - u[2])
    const n = Math.hypot(x, y, z) || 1
    return [x / n, y / n, z / n]
  }
  const sinO = Math.sin(omega)
  const a = Math.sin((1 - t) * omega) / sinO
  const b = Math.sin(t * omega) / sinO
  return [a * u[0] + b * v[0], a * u[1] + b * v[1], a * u[2] + b * v[2]]
}

/** Label for waypoint index: 0 -> 'A', 1 -> 'B', ... 25 -> 'Z', 26 -> 'AA'. */
export function waypointLabel(index: number): string {
  let n = index
  let s = ''
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  }
  return s
}

/** Re-assign sequential A, B, C... labels after inserting or deleting a waypoint. */
export function reindexWaypoints(waypoints: MeasureWaypoint[]): MeasureWaypoint[] {
  return waypoints.map((wp, idx) => ({ ...wp, label: waypointLabel(idx) }))
}

/** Remove a waypoint by id (or toggle it off if clicked again within snapRadiusM) and re-index labels. */
export function removeWaypointById(waypoints: MeasureWaypoint[], id: string): MeasureWaypoint[] {
  return reindexWaypoints(waypoints.filter((wp) => wp.id !== id))
}

/** Rename a specific waypoint by id. */
export function renameWaypointById(waypoints: MeasureWaypoint[], id: string, name: string): MeasureWaypoint[] {
  return waypoints.map((wp) => (wp.id === id ? { ...wp, name } : wp))
}

/** Find an existing waypoint within `snapRadiusM` great-circle metres of `(lat, lon)`, or null. */
export function findNearbyWaypoint(
  waypoints: MeasureWaypoint[],
  lat: number,
  lon: number,
  snapRadiusM = 60,
): MeasureWaypoint | null {
  let best: MeasureWaypoint | null = null
  let bestDist = snapRadiusM
  for (const wp of waypoints) {
    const d = greatCircleDistanceM(wp.lat, wp.lon, lat, lon)
    if (d <= bestDist) {
      bestDist = d
      best = wp
    }
  }
  return best
}

/**
 * Compute full multi-waypoint lunar traverse analysis, sampling the loaded LOLA DEM tiles
 * along each great-circle segment and checking 3D Line-of-Sight (accounting for lunar curvature).
 */
export function analyseTraverse(
  waypoints: MeasureWaypoint[],
  frame: SiteFrame,
  tileHeights?: TileHeights | null,
  psrData?: PsrData | null,
  mastHeightM = 2,
  samplesPerSegment = 48,
): MeasureAnalysis | null {
  if (waypoints.length < 2) return null

  const segments: MeasureSegment[] = []
  const rawSamples: {
    segmentIndex: number
    distanceM: number
    surfaceDistanceM: number
    lat: number
    lon: number
    unitVec: Vec3
    heightM: number
    sitePos: Vec3
  }[] = []

  let cumGeodesicM = 0
  let cumSurfaceM = 0
  let totalAscentM = 0
  let totalDescentM = 0

  const stepsPerSeg = Math.max(8, Math.min(96, samplesPerSegment))

  for (let segIdx = 0; segIdx < waypoints.length - 1; segIdx++) {
    const wpA = waypoints[segIdx]
    const wpB = waypoints[segIdx + 1]
    const uA = latLonToVec(wpA.lat, wpA.lon)
    const uB = latLonToVec(wpB.lat, wpB.lon)
    const segGeodesicM = greatCircleDistanceM(wpA.lat, wpA.lon, wpB.lat, wpB.lon)
    const segBearingDeg = initialBearingDeg(wpA.lat, wpA.lon, wpB.lat, wpB.lon)

    let segSurfaceM = 0
    let segMaxSlopeDeg = 0
    const startSampleIdx = rawSamples.length

    for (let k = 0; k <= stepsPerSeg; k++) {
      if (segIdx > 0 && k === 0) continue // avoid duplicating shared vertex between segments
      const t = k / stepsPerSeg
      const u = slerpUnitVec(uA, uB, t)
      const [lat, lon] = vecToLatLon(u)
      // Sample loaded LOLA DEM tile; fall back to linear interpolation between endpoint heights if tile not yet in cache
      const sampledH =
        k === 0
          ? wpA.heightM
          : k === stepsPerSeg
            ? wpB.heightM
            : (tileHeights ? groundHeightAt(u, tileHeights) : null) ?? wpA.heightM + t * (wpB.heightM - wpA.heightM)

      const dGeodesic = cumGeodesicM + t * segGeodesicM
      if (rawSamples.length > 0) {
        const prev = rawSamples[rawSamples.length - 1]
        const dh = sampledH - prev.heightM
        const dd = Math.max(0.01, dGeodesic - prev.distanceM)
        const step3d = Math.hypot(dd, dh)
        cumSurfaceM += step3d
        segSurfaceM += step3d
        if (dh > 0) totalAscentM += dh
        else totalDescentM += Math.abs(dh)
        const stepSlopeDeg = Math.atan2(Math.abs(dh), dd) / DEG
        if (stepSlopeDeg > segMaxSlopeDeg) segMaxSlopeDeg = stepSlopeDeg
      }

      rawSamples.push({
        segmentIndex: segIdx,
        distanceM: dGeodesic,
        surfaceDistanceM: cumSurfaceM,
        lat,
        lon,
        unitVec: u,
        heightM: sampledH,
        sitePos: surfacePoint(frame, lat, lon, sampledH, 3.5),
      })
    }

    const midSample = rawSamples[Math.floor((startSampleIdx + rawSamples.length - 1) / 2)] ?? rawSamples[rawSamples.length - 1]
    segments.push({
      fromIndex: segIdx,
      toIndex: segIdx + 1,
      geodesicDistanceM: segGeodesicM,
      surfaceDistanceM: segSurfaceM,
      bearingDeg: segBearingDeg,
      netElevationM: wpB.heightM - wpA.heightM,
      maxSlopeDeg: segMaxSlopeDeg,
      midpointSitePos: midSample.sitePos,
    })

    cumGeodesicM += segGeodesicM
  }

  // Compute local slopes and 3D Line-of-Sight (LOS) between first and last waypoint (with mastHeightM)
  const first = rawSamples[0]
  const last = rawSamples[rawSamples.length - 1]
  const rFirst = MOON_RADIUS_M + first.heightM + mastHeightM
  const rLast = MOON_RADIUS_M + last.heightM + mastHeightM
  const pFirst: Vec3 = [first.unitVec[0] * rFirst, first.unitVec[1] * rFirst, first.unitVec[2] * rFirst]
  const pLast: Vec3 = [last.unitVec[0] * rLast, last.unitVec[1] * rLast, last.unitVec[2] * rLast]

  let minH = Infinity
  let maxH = -Infinity
  let maxSlopeDeg = 0
  let slopeSum = 0
  let slopeCount = 0
  let losClear = true
  let losMinClearanceM = Infinity
  let losBlockerDistanceM: number | null = null

  const samples: ProfileSample[] = rawSamples.map((s, idx) => {
    if (s.heightM < minH) minH = s.heightM
    if (s.heightM > maxH) maxH = s.heightM

    // Central difference for smooth local slope
    const prev = rawSamples[Math.max(0, idx - 1)]
    const next = rawSamples[Math.min(rawSamples.length - 1, idx + 1)]
    const dd = next.distanceM - prev.distanceM
    const dh = next.heightM - prev.heightM
    const slopeDeg = dd > 0.01 ? Math.atan2(Math.abs(dh), dd) / DEG : 0
    if (slopeDeg > maxSlopeDeg) maxSlopeDeg = slopeDeg
    slopeSum += slopeDeg
    slopeCount++

    // 3D chord position at fraction f along total geodesic distance
    const f = cumGeodesicM > 0.01 ? s.distanceM / cumGeodesicM : 0
    const cx = pFirst[0] + f * (pLast[0] - pFirst[0])
    const cy = pFirst[1] + f * (pLast[1] - pFirst[1])
    const cz = pFirst[2] + f * (pLast[2] - pFirst[2])
    const chordRadiusM = Math.hypot(cx, cy, cz)
    const losHeightM = chordRadiusM - MOON_RADIUS_M
    const losClearanceM = losHeightM - s.heightM

    // Check intermediate points (exclude exact endpoints) for terrain blocking
    if (idx > 0 && idx < rawSamples.length - 1) {
      if (losClearanceM < losMinClearanceM) {
        losMinClearanceM = losClearanceM
        if (losClearanceM < 0) losBlockerDistanceM = s.distanceM
      }
      if (losClearanceM < 0) losClear = false
    }

    return {
      index: idx,
      segmentIndex: s.segmentIndex,
      distanceM: s.distanceM,
      surfaceDistanceM: s.surfaceDistanceM,
      lat: s.lat,
      lon: s.lon,
      heightM: s.heightM,
      slopeDeg,
      slopeStatus: classifySlope(slopeDeg),
      losHeightM,
      losClearanceM,
      sitePos: s.sitePos,
    }
  })

  if (!Number.isFinite(losMinClearanceM)) losMinClearanceM = mastHeightM

  // Nearest water-ice / PSR distance from the final waypoint
  const endWp = waypoints[waypoints.length - 1]
  let nearestIceDistanceM: number | null = null
  let nearestPsrName: string | null = null
  if (psrData) {
    for (const [iceLat, iceLon] of psrData.ice) {
      const d = greatCircleDistanceM(endWp.lat, endWp.lon, iceLat, iceLon)
      if (nearestIceDistanceM === null || d < nearestIceDistanceM) nearestIceDistanceM = d
    }
    let bestPsrDist = Infinity
    for (const p of psrData.psrs) {
      const d = greatCircleDistanceM(endWp.lat, endWp.lon, p.lat, p.lon)
      if (d < bestPsrDist) {
        bestPsrDist = d
        nearestPsrName = p.id
      }
    }
  }

  const overallBearing = initialBearingDeg(
    waypoints[0].lat,
    waypoints[0].lon,
    waypoints[waypoints.length - 1].lat,
    waypoints[waypoints.length - 1].lon,
  )

  const waypointStats: WaypointStat[] = []
  let cumGeo = 0
  let cumSurf = 0
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i]
    const seg = i > 0 ? segments[i - 1] : null
    if (seg) {
      cumGeo += seg.geodesicDistanceM
      cumSurf += seg.surfaceDistanceM
    }
    waypointStats.push({
      id: wp.id,
      label: wp.label,
      name: wp.name ?? '',
      lat: wp.lat,
      lon: wp.lon,
      heightM: wp.heightM,
      cumulativeGeodesicM: cumGeo,
      cumulativeSurfaceM: cumSurf,
      segmentSurfaceM: seg ? seg.surfaceDistanceM : 0,
      segmentBearingDeg: seg ? seg.bearingDeg : null,
      segmentMaxSlopeDeg: seg ? seg.maxSlopeDeg : 0,
      segmentSlopeStatus: classifySlope(seg ? seg.maxSlopeDeg : 0),
    })
  }

  return {
    waypoints,
    waypointStats,
    segments,
    samples,
    geodesicDistanceM: cumGeodesicM,
    surfaceDistanceM: cumSurfaceM,
    initialBearingDeg: overallBearing,
    compassRose: bearingToCompass(overallBearing),
    netElevationChangeM: waypoints[waypoints.length - 1].heightM - waypoints[0].heightM,
    totalAscentM,
    totalDescentM,
    minHeightM: minH,
    maxHeightM: maxH,
    maxSlopeDeg,
    meanSlopeDeg: slopeCount > 0 ? slopeSum / slopeCount : 0,
    slopeStatus: classifySlope(maxSlopeDeg),
    curvatureDropM: lunarCurvatureDropM(cumGeodesicM),
    losClear,
    losMinClearanceM,
    losBlockerDistanceM,
    nearestIceDistanceM,
    nearestPsrName,
  }
}

/**
 * Returns true when any placed waypoint is anchored within `thresholdM` of the active Lander coordinates,
 * allowing the 3D scene to hide the redundant Lander badge so the two labels never collide.
 */
export function isLanderWaypointPresent(
  waypoints: MeasureWaypoint[],
  landerLat: number,
  landerLon: number,
  thresholdM = 25,
): boolean {
  return waypoints.some((wp) => greatCircleDistanceM(wp.lat, wp.lon, landerLat, landerLon) <= thresholdM)
}

/**
 * Computes the horizontal textAnchor and pixel offset for a waypoint label on the 2D SVG elevation
 * profile so start/end waypoint labels never collide with the Y-axis elevation labels or right border.
 */
export function profileWaypointLabelAnchor(
  distanceM: number,
  totalDistanceM: number,
): { textAnchor: 'start' | 'middle' | 'end'; dx: number } {
  const frac = totalDistanceM > 0 ? distanceM / totalDistanceM : 0
  if (frac <= 0.12) return { textAnchor: 'start', dx: 4 }
  if (frac >= 0.88) return { textAnchor: 'end', dx: -4 }
  return { textAnchor: 'middle', dx: 0 }
}

