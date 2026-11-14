// Pure geometry for the 3D scene. Scene frame (metres, centred on the site):
//   x = east, y = up, z = -north (south).
// Azimuth is clockwise from north, as in the backend/Horizons.

const DEG = Math.PI / 180

/** Direction (unit vector, or scaled by r) of a sky position given azimuth/elevation in degrees. */
export function azElToVector(azDeg: number, elDeg: number, r = 1): [number, number, number] {
  const az = azDeg * DEG
  const el = elDeg * DEG
  return [r * Math.sin(az) * Math.cos(el), r * Math.sin(el), -r * Math.cos(az) * Math.cos(el)]
}

/** World positions of the Sun and Earth discs at `distance` from an eye `eyeHeight` above the site. */
export function skyPositions(
  status: { sun: { azimuth_deg: number; elevation_deg: number }; earth: { azimuth_deg: number; elevation_deg: number } },
  distance: number,
  eyeHeight: number,
) {
  const sun = azElToVector(status.sun.azimuth_deg, status.sun.elevation_deg, distance)
  const earth = azElToVector(status.earth.azimuth_deg, status.earth.elevation_deg, distance)
  sun[1] += eyeHeight
  earth[1] += eyeHeight
  return { sun, earth }
}

type SkyStep = {
  time_utc: string
  sun: { azimuth_deg: number; elevation_deg: number; visible_fraction: number | null; visible?: boolean | null }
  earth: { azimuth_deg: number; elevation_deg: number; visible: boolean | null }
}

/**
 * A body's path across the sky over consecutive hourly steps, as line segments (one per hour) at
 * radius r around the eye. Colour per vertex: `visible` where the body clears the terrain, `blocked`
 * where terrain hides it, `unknown` where the data can't say. Steps more than 1.5 h apart are not
 * joined (a gap in the data stays a gap).
 */
export function skyTrail(
  steps: SkyStep[],
  body: 'sun' | 'earth',
  r: number,
  colours: { visible: [number, number, number]; blocked: [number, number, number]; unknown: [number, number, number] },
): { positions: Float32Array; colors: Float32Array } {
  const pos: number[] = []
  const col: number[] = []
  const state = (s: SkyStep) => {
    const v = body === 'sun' ? (s.sun.visible ?? (s.sun.visible_fraction === null ? null : s.sun.visible_fraction > 0)) : s.earth.visible
    return v === null || v === undefined ? colours.unknown : v ? colours.visible : colours.blocked
  }
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1]
    const b = steps[i]
    if (Date.parse(b.time_utc) - Date.parse(a.time_utc) > 1.5 * 3600_000) continue
    pos.push(...azElToVector(a[body].azimuth_deg, a[body].elevation_deg, r), ...azElToVector(b[body].azimuth_deg, b[body].elevation_deg, r))
    col.push(...state(a), ...state(a)) // the segment takes the state at its start hour
  }
  return { positions: new Float32Array(pos), colors: new Float32Array(col) }
}

/**
 * A closed band ("curtain") on a sphere of radius r around the eye: top edge follows the terrain
 * horizon, bottom edge sits at `bottomElDeg`. Sun/Earth placed further out are hidden by it exactly
 * when they are below the computed horizon.
 */
export function buildHorizonCurtain(
  azimuthDeg: number[],
  horizonDeg: number[],
  r: number,
  bottomElDeg = -30,
): { positions: Float32Array; indices: Uint32Array; topLine: Float32Array } {
  const n = azimuthDeg.length
  const positions = new Float32Array((n + 1) * 2 * 3)
  const topLine = new Float32Array((n + 1) * 3)
  for (let i = 0; i <= n; i++) {
    const j = i % n // repeat the first azimuth to close the loop
    const top = azElToVector(azimuthDeg[j], horizonDeg[j], r)
    const bottom = azElToVector(azimuthDeg[j], bottomElDeg, r)
    positions.set(top, 6 * i)
    positions.set(bottom, 6 * i + 3)
    topLine.set(top, 3 * i)
  }
  const indices = new Uint32Array(n * 6)
  for (let i = 0; i < n; i++) {
    const t0 = 2 * i
    const b0 = t0 + 1
    const t1 = t0 + 2
    const b1 = t0 + 3
    indices.set([t0, b0, t1, t1, b0, b1], 6 * i)
  }
  return { positions, indices, topLine }
}
