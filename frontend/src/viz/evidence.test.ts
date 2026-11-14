import { describe, expect, it } from 'vitest'
import { bodyForWindowKind, evidenceFromWindow, showEvidence, useEvidence } from './evidence'

describe('"Show me why": viability evidence windows -> the 3D view', () => {
  it('looks at the Sun for sunlight and power, at Earth for communications', () => {
    for (const k of ['darkness', 'power_dark', 'sunlight', 'partial_sunlight', 'sun_unknown', 'power_unknown']) expect(bodyForWindowKind(k)).toBe('sun')
    for (const k of ['communication_blackout', 'earth_visible', 'earth_unknown']) expect(bodyForWindowKind(k)).toBe('earth')
    expect(bodyForWindowKind('simultaneous_sun_earth')).toBe('sun')
    expect(bodyForWindowKind('unknown_data')).toBeNull() // no data: nothing to show
  })

  it('turns an engine window into a request, and each request is new (the same one twice still jumps)', () => {
    const w = { kind: 'darkness', start_utc: '2027-03-04T05:00:00Z', end_utc: '2027-03-06T07:00:00Z' }
    const r = evidenceFromWindow('connecting-ridge', w)!
    expect(r).toEqual({ siteId: 'connecting-ridge', startUtc: w.start_utc, endUtc: w.end_utc, body: 'sun' })
    showEvidence(r)
    const first = useEvidence.getState().request!
    showEvidence(r)
    expect(useEvidence.getState().request!.id).toBe(first.id + 1)
    expect(evidenceFromWindow('x', { ...w, kind: 'unknown_data' })).toBeNull()
  })
})
