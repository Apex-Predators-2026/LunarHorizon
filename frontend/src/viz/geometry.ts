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
