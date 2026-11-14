import { describe, expect, it } from 'vitest'
import { coverageLabel } from './coverage'

describe('coverage badge text', () => {
  it('names the terrain close up, the photo mosaic zoomed out, and the blend in between', () => {
    expect(coverageLabel(0).title).toBe('LOLA terrain')
    expect(coverageLabel(100).title).toBe('LRO photo mosaic')
    const mid = coverageLabel(35)
    expect(mid.title).toContain('LOLA terrain')
    expect(mid.title).toContain('LRO photo mosaic')
    expect(mid.detail).toContain('35%')
  })

  it('explains the data source in the tooltip', () => {
    expect(coverageLabel(0).tip).toMatch(/LOLA.*Moon Trek/)
    expect(coverageLabel(100).tip).toMatch(/Wide Angle Camera.*Moon Trek/)
  })
})
