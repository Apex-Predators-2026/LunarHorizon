import { describe, expect, it } from 'vitest'
import { azElToVector, buildHorizonCurtain } from './geometry'

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

describe('buildHorizonCurtain', () => {
  it('top edge follows the horizon and the loop closes', () => {
    const { topLine } = buildHorizonCurtain([0, 90, 180, 270], [5, 10, 0, -2], 1000)
    const n = topLine.length / 3
    expect(n).toBe(5)
    close(Array.from(topLine.slice(0, 3)), Array.from(topLine.slice(12, 15))) // closed
    close(Array.from(topLine.slice(3, 6)), azElToVector(90, 10, 1000), 3)
  })
})
