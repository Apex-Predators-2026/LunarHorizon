import { describe, expect, it } from 'vitest'
import { parseCoordinates } from './coordinates'

describe('parseCoordinates', () => {
  it('accepts south-polar coordinates and keeps east longitudes', () => {
    expect(parseCoordinates('-89.45', '222.69')).toEqual([-89.45, 222.69])
    expect(parseCoordinates(' 0.67 ', '23.47')).toEqual([0.67, 23.47]) // Apollo 11, with spaces
  })

  it('turns west (negative) longitudes into degrees east', () => {
    const [lat, lon] = parseCoordinates('-84.79', '-29.2') as [number, number]
    expect(lat).toBe(-84.79)
    expect(lon).toBeCloseTo(330.8, 10)
    expect(parseCoordinates('10', '360')).toEqual([10, 0])
  })

  it('explains what is wrong', () => {
    expect(parseCoordinates('', '10')).toMatch(/numbers/)
    expect(parseCoordinates('abc', '10')).toMatch(/numbers/)
    expect(parseCoordinates('-91', '10')).toMatch(/Latitude/)
    expect(parseCoordinates('-89', '400')).toMatch(/Longitude/)
  })
})
