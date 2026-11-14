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
 * Vertex positions and triangle indices for a height grid whose rows run north -> south and
 * columns west -> east (the /terrain endpoint's layout). Heights are made relative to `originHeight`.
 * Triangles are wound so normals point up (+y).
 */
export function buildTerrainMesh(
  heights: ArrayLike<number>,
  size: number,
  halfWidth: number,
  originHeight: number,
): { positions: Float32Array; indices: Uint32Array } {
  const spacing = (2 * halfWidth) / (size - 1)
  const positions = new Float32Array(size * size * 3)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c
      positions[3 * i] = -halfWidth + c * spacing // east
      positions[3 * i + 1] = heights[i] - originHeight // up
      positions[3 * i + 2] = -halfWidth + r * spacing // -north (row 0 is the north edge)
    }
  }
  const indices = new Uint32Array((size - 1) * (size - 1) * 6)
  let k = 0
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v00 = r * size + c
      const v01 = v00 + 1
      const v10 = v00 + size
      const v11 = v10 + 1
      indices.set([v00, v10, v01, v01, v10, v11], k)
      k += 6
    }
  }
  return { positions, indices }
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
