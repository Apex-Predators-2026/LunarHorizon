import { describe, expect, it } from 'vitest'
import { MOON_RADIUS_M, SiteFrame } from './cubeSphere'
import {
  analyseTraverse,
  bearingToCompass,
  classifySlope,
  findNearbyWaypoint,
  greatCircleDistanceM,
  initialBearingDeg,
  isLanderWaypointPresent,
  lunarCurvatureDropM,
  profileWaypointLabelAnchor,
  reindexWaypoints,
  removeWaypointById,
  renameWaypointById,
  waypointLabel,
  type MeasureWaypoint,
} from './measure'
import { destination } from './overlays'

describe('measure lunar geodesic & traverse math', () => {
  it('computes accurate great-circle distance and inverse bearing with destination()', () => {
    const lat1 = -89.45
    const lon1 = 222.69
    const targetDistM = 2450
    const targetAzDeg = 135
    const [lat2, lon2] = destination(lat1, lon1, targetAzDeg, targetDistM)

    const d = greatCircleDistanceM(lat1, lon1, lat2, lon2)
    expect(d).toBeCloseTo(targetDistM, 2)

    const az = initialBearingDeg(lat1, lon1, lat2, lon2)
    expect(az).toBeCloseTo(targetAzDeg, 2)
    expect(bearingToCompass(az)).toBe('SE')
  })

  it('computes lunar curvature drop d^2 / (2 * R_Moon)', () => {
    // At d = 3474.8 m, d^2 / (2 * 1,737,400) = 3.4748 m
    const d = 3474.8
    expect(lunarCurvatureDropM(d)).toBeCloseTo((d * d) / (2 * MOON_RADIUS_M), 5)
  })

  it('classifies NASA EVA and rover slope hazard thresholds', () => {
    expect(classifySlope(5.2)).toBe('ok')
    expect(classifySlope(14.8)).toBe('warn')
    expect(classifySlope(24.1)).toBe('crit')
    expect(waypointLabel(0)).toBe('A')
    expect(waypointLabel(1)).toBe('B')
    expect(waypointLabel(25)).toBe('Z')
    expect(waypointLabel(26)).toBe('AA')
  })

  it('computes 3D surface distance > geodesic distance on steep terrain and detects LOS clear', () => {
    const frame = new SiteFrame(-89.45, 222.69, 2100)
    const [latB, lonB] = destination(-89.45, 222.69, 90, 1000) // 1000 m east
    const waypoints: MeasureWaypoint[] = [
      { id: '1', label: 'A', lat: -89.45, lon: 222.69, heightM: 2100 },
      { id: '2', label: 'B', lat: latB, lon: lonB, heightM: 1700 }, // 400 m drop over 1000 m (~21.8 deg slope)
    ]

    const res = analyseTraverse(waypoints, frame, null, null, 2, 32)
    expect(res).not.toBeNull()
    expect(res!.geodesicDistanceM).toBeCloseTo(1000, 1)
    // 3D hypotenuse: sqrt(1000^2 + 400^2) ≈ 1077.03 m
    expect(res!.surfaceDistanceM).toBeCloseTo(Math.hypot(1000, 400), 0)
    expect(res!.netElevationChangeM).toBe(-400)
    expect(res!.totalDescentM).toBeCloseTo(400, 1)
    expect(res!.maxSlopeDeg).toBeCloseTo((Math.atan2(400, 1000) * 180) / Math.PI, 1)
    expect(res!.slopeStatus).toBe('crit')
    expect(res!.losClear).toBe(true)
  })

  it('detects Line-of-Sight blockage when an intermediate ridge rises above the 2 m mast chord', () => {
    const frame = new SiteFrame(-89.45, 222.69, 2000)
    const [latMid, lonMid] = destination(-89.45, 222.69, 0, 1500)
    const [latEnd, lonEnd] = destination(-89.45, 222.69, 0, 3000)
    const waypoints: MeasureWaypoint[] = [
      { id: '1', label: 'A', lat: -89.45, lon: 222.69, heightM: 2000 },
      { id: '2', label: 'B', lat: latMid, lon: lonMid, heightM: 2045 }, // +45 m ridge in the middle
      { id: '3', label: 'C', lat: latEnd, lon: lonEnd, heightM: 2000 },
    ]

    const res = analyseTraverse(waypoints, frame, null, null, 2, 24)
    expect(res).not.toBeNull()
    expect(res!.losClear).toBe(false)
    expect(res!.losMinClearanceM).toBeLessThan(-40)
    expect(res!.losBlockerDistanceM).toBeCloseTo(1500, -1)
    expect(res!.totalAscentM).toBeCloseTo(45, 1)
    expect(res!.totalDescentM).toBeCloseTo(45, 1)
    expect(res!.waypointStats).toHaveLength(3)
    expect(res!.waypointStats[0].segmentSurfaceM).toBe(0)
    expect(res!.waypointStats[1].segmentSurfaceM).toBeGreaterThan(1500)
    expect(res!.waypointStats[2].cumulativeGeodesicM).toBeCloseTo(3000, 0)
  })

  it('supports renaming, proximity click-to-delete lookup, and sequential re-indexing of waypoints', () => {
    const [latB, lonB] = destination(-89.45, 222.69, 90, 500)
    const [latC, lonC] = destination(-89.45, 222.69, 90, 1000)
    const initial: MeasureWaypoint[] = [
      { id: 'w1', label: 'A', name: 'Lander', lat: -89.45, lon: 222.69, heightM: 2100 },
      { id: 'w2', label: 'B', lat: latB, lon: lonB, heightM: 2080 },
      { id: 'w3', label: 'C', lat: latC, lon: lonC, heightM: 2050 },
    ]

    const renamed = renameWaypointById(initial, 'w2', 'Relay Ridge')
    expect(renamed[1].name).toBe('Relay Ridge')

    // Click within 30 m of Waypoint B should find it
    const [nearLat, nearLon] = destination(latB, lonB, 45, 25)
    const hit = findNearbyWaypoint(renamed, nearLat, nearLon, 60)
    expect(hit?.id).toBe('w2')

    // Removing Waypoint B re-indexes Waypoint C to 'B'
    const afterRemove = removeWaypointById(renamed, 'w2')
    expect(afterRemove).toHaveLength(2)
    expect(afterRemove[0].label).toBe('A')
    expect(afterRemove[1].id).toBe('w3')
    expect(afterRemove[1].label).toBe('B')
    expect(reindexWaypoints(afterRemove).map((w) => w.label)).toEqual(['A', 'B'])
  })

  it('detects when a waypoint is anchored at the lander and computes non-overlapping profile label anchors', () => {
    const landerLat = -89.45
    const landerLon = 222.69
    const [farLat, farLon] = destination(landerLat, landerLon, 90, 500)
    const farOnly: MeasureWaypoint[] = [{ id: 'w1', label: 'A', lat: farLat, lon: farLon, heightM: 2080 }]
    expect(isLanderWaypointPresent(farOnly, landerLat, landerLon)).toBe(false)

    const withLander: MeasureWaypoint[] = [
      { id: 'w0', label: 'A', name: 'Lander', lat: landerLat, lon: landerLon, heightM: 2100 },
      ...farOnly,
    ]
    expect(isLanderWaypointPresent(withLander, landerLat, landerLon)).toBe(true)

    expect(profileWaypointLabelAnchor(0, 5000)).toEqual({ textAnchor: 'start', dx: 4 })
    expect(profileWaypointLabelAnchor(2500, 5000)).toEqual({ textAnchor: 'middle', dx: 0 })
    expect(profileWaypointLabelAnchor(5000, 5000)).toEqual({ textAnchor: 'end', dx: -4 })
  })
})
