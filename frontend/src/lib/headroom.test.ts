import { describe, expect, it } from 'vitest'

import { DEFAULT_REQUIREMENTS, type OperationalHeadroom, type ViabilityResult } from '../types'
import type { MissionTrack } from '../viz/mission'
import {
  deriveHeadroom,
  deriveHeadroomFromTrack,
  formatMarginMetric,
  headroomTone,
  resolveHeadroom,
} from './headroom'

const SITE = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }

function makeResult(longestDark: number, longestComms = 48): ViabilityResult {
  return {
    passes: true,
    eligibility: 'pass',
    score: 88,
    source: 'test',
    data_source: 'synthetic',
    violations: [],
    scenario: {
      site: SITE,
      landing_utc: '2027-01-15T00:00:00Z',
      duration_days: 7,
      requirements: { ...DEFAULT_REQUIREMENTS, battery_hours: 50, max_comms_gap_hours: 96 },
    },
    metrics: {
      sunlight_fraction: 0.9,
      equivalent_sun_hours: 151,
      longest_dark_gap_hours: longestDark,
      earth_visibility_fraction: 0.72,
      longest_comms_gap_hours: longestComms,
      initial_sun_hours: 40,
      initial_comms_hours: 20,
      hours_to_first_sunset: 40,
      hours_to_first_earthset: 20,
      mean_sun_clearance_deg: 2.1,
      mean_earth_clearance_deg: 1.5,
      mean_solar_elevation_deg: 1.6,
    },
  }
}

describe('canonical headroom presenter & derivation', () => {
  it('distinguishes a 15h gap (35h comfortable headroom) from a 49h gap (1h limited headroom) under a 50h battery limit', () => {
    const comfy = deriveHeadroom(makeResult(15, 48))
    expect(comfy.status).toBe('comfortable')
    expect(comfy.darkness?.margin.value).toBe(35)
    expect(comfy.communication_blackout?.margin.value).toBe(48)
    expect(headroomTone(comfy)).toBe('ok')
    expect(comfy.screening_note.toLowerCase()).toContain('not a guarantee')

    const tight = deriveHeadroom(makeResult(49, 48))
    expect(tight.status).toBe('limited')
    expect(tight.darkness?.margin.value).toBe(1)
    expect(tight.closest_constraint?.requirement_field).toBe('battery_hours')
    expect(tight.qualified_verdict.toLowerCase()).toContain('passes with limited darkness margin')
    expect(headroomTone(tight)).toBe('warn')
  })

  it('prefers backend canonical OperationalHeadroom verbatim and formats bounded intervals without collapsing them', () => {
    const canonical: OperationalHeadroom = {
      status: 'limited',
      qualified_verdict: 'Passes with limited darkness margin (between +1 h and +4 h of 50 h limit)',
      limited_constraints: ['battery_hours'],
      darkness: {
        id: 'max_continuous_darkness',
        requirement_field: 'battery_hours',
        name: 'Max continuous darkness',
        short_label: 'darkness',
        comparison: 'at_most',
        unit: 'h',
        threshold: 50,
        measured: { status: 'bounded', unit: 'h', lower: 46, upper: 49 },
        margin: { status: 'bounded', unit: 'h', lower: 1, upper: 4 },
        margin_class: 'narrow',
        narrow_reason: 'Proven lower bound is within 10% of the limit.',
        description: 'Remaining darkness capacity',
      },
      communication_blackout: null,
      initial_sunlight: {
        kind: 'sunlight',
        duration: { status: 'known', unit: 'h', value: 168 },
        first_end_hours: { status: 'not_applicable', unit: 'h' },
        requirement_hours: 24,
        summary_text: '168 h from landing (stays lit all mission)',
      },
      initial_earth: {
        kind: 'earth',
        duration: { status: 'known', unit: 'h', value: 48 },
        first_end_hours: { status: 'known', unit: 'h', value: 48 },
        requirement_hours: 12,
        summary_text: '48 h continuous from landing (first Earthset T+48 h)',
      },
      closest_constraint: {
        constraint_id: 'max_continuous_darkness',
        requirement_field: 'battery_hours',
        label: 'Max continuous darkness',
        margin_class: 'narrow',
        unit: 'h',
        headroom_text: 'between +1 h and +4 h',
        summary_text: 'Max continuous darkness: between +1 h and +4 h remaining of 50 h limit',
      },
      constraints: [],
      screening_note: 'Model screening result only; not a guarantee of spacecraft survival.',
    }

    const res = { ...makeResult(49), headroom: canonical }
    const out = resolveHeadroom(res)
    expect(out).toBe(canonical)
    expect(formatMarginMetric(out.darkness!.margin, true)).toBe('between +1 h and +4 h')
  })

  it('derives qualified headroom and initial windows from client MissionTrack for 3D playback', () => {
    const start = Date.parse('2027-01-15T00:00:00Z')
    const hours = Array.from({ length: 72 }, (_, i) => ({
      t: start + i * 3600_000,
      dark: i >= 20 && i < 69,
      blackout: false,
      sunFraction: i >= 20 && i < 69 ? 0 : 1,
    }))
    const track: MissionTrack = {
      start,
      end: start + 72 * 3600_000,
      hours,
      darkStreak: hours.map((_, i) => (i >= 20 && i < 69 ? i - 19 : 0)),
      gapStreak: hours.map(() => 0),
      longestDark: { start: start + 20 * 3600_000, hours: 49 },
      longestBlackout: null,
      initialSunHours: 20,
      initialCommsHours: 72,
      sunlightFraction: 23 / 72,
      earthFraction: 1,
      unknownHours: 0,
      failures: [],
    }
    const hr = deriveHeadroomFromTrack(track, { ...DEFAULT_REQUIREMENTS, battery_hours: 50, min_sunlight_fraction: 0.25, min_initial_sun_hours: 12 })
    expect(hr.status).toBe('limited')
    expect(hr.darkness?.margin.value).toBe(1)
    expect(hr.initial_sunlight.first_end_hours.value).toBe(20)
    expect(hr.initial_earth.first_end_hours.status).toBe('not_applicable')
    expect(hr.qualified_verdict.toLowerCase()).toContain('passes with limited darkness margin')
    expect(hr.screening_note.toLowerCase()).toContain('not a guarantee')
  })
})
