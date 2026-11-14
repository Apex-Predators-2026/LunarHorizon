import { describe, expect, it } from 'vitest'
import { azElToVector, buildHorizonCurtain, buildTerrainMesh } from './geometry'

// digits = decimal places; vertex buffers are Float32, so compare those more loosely.
const close = (a: number[], b: number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits))

describe('azElToVector', () => {
  it('maps compass directions onto x=east, z=-north', () => {
    close(azElToVector(0, 0), [0, 0, -1]) // north
    close(azElToVector(90, 0), [1, 0, 0]) // east
    close(azElToVector(180, 0), [0, 0, 1]) // south
    close(azElToVector(270, 0), [-1, 0, 0]) // west
    close(azElToVector(123, 90), [0, 1, 0]) // zenith
  })

  it('scales and keeps unit length', () => {
    const [x, y, z] = azElToVector(37, 12, 5)
    expect(Math.hypot(x, y, z)).toBeCloseTo(5, 9)
    expect(y).toBeCloseTo(5 * Math.sin((12 * Math.PI) / 180), 9)
  })
})

describe('buildTerrainMesh', () => {
  it('puts row 0 on the north edge, column 0 on the west edge, heights relative to the site', () => {
    // 2x2 grid: NW=10, NE=20, SW=30, SE=40
    const { positions, indices } = buildTerrainMesh([10, 20, 30, 40], 2, 100, 10)
    close(Array.from(positions.slice(0, 3)), [-100, 0, -100]) // NW: west, north (z = -north)
    close(Array.from(positions.slice(3, 6)), [100, 10, -100]) // NE
    close(Array.from(positions.slice(6, 9)), [-100, 20, 100]) // SW
    expect(indices.length).toBe(6)
  })

  it('winds triangles with upward normals', () => {
    const { positions: p, indices } = buildTerrainMesh([0, 0, 0, 0], 2, 1, 0)
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]])
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const ny = u[2] * v[0] - u[0] * v[2] // y component of u x v
      expect(ny).toBeGreaterThan(0)
    }
  })
})

describe('buildHorizonCurtain', () => {
  it('top edge follows the horizon and the loop closes', () => {
    const { topLine } = buildHorizonCurtain([0, 90, 180, 270], [5, 10, 0, -2], 1000)
    const n = topLine.length / 3
    expect(n).toBe(5)
    close(Array.from(topLine.slice(0, 3)), Array.from(topLine.slice(12, 15))) // closed
    close(Array.from(topLine.slice(3, 6)), azElToVector(90, 10, 1000), 3)
  })
})
