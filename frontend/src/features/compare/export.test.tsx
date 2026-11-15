// Phase 7: export integrity. Fixture: A Peak Near Shackleton FAIL · B Malapert PASS #1 · C Connecting Ridge PASS #2 ·
// D no data (UNKNOWN, not assessed) · E Malapert 3-day PASS in separate group G2.
import { describe, expect, it } from 'vitest'

import { SCREENING_NOTE } from '../../lib/headroom'
import fixture from './__fixtures__/compare-response.json'
import { canonicalRanking, eligibilityOf, type Entry } from './analysis'
import { buildDecision } from './decision'
import { buildExport, toCsv } from './export'
import { makeScenario } from './scenario'
import type { CanonicalMetric, CompareResponse, CompareResult } from './types'

const res = fixture as unknown as CompareResponse
const byKey = Object.fromEntries(res.results.map((r) => [r.key, r])) as Record<string, CompareResult>
const SITE = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.9635, lon: 357.6326 }

function entry(key: string): Entry {
  const r = byKey[key]
  const scenario = { ...makeScenario({ site: SITE, landing_utc: '2027-01-15T00:00:00Z' }, []), label: key, id: `s-${key}` }
  return { scenario, state: { state: 'done', result: r }, result: r.status === 'ok' ? r : null, offsetHours: 0, ranking: r.ranking }
}

const all = () => ['A', 'B', 'C', 'D', 'E'].map(entry)
const exp = () => buildExport(all(), res.ranking_groups, res.pairwise, res.notes, new Date('2027-01-01T00:00:00Z'))
const byLabel = (x: ReturnType<typeof exp>) => Object.fromEntries(x.scenarios.map((s) => [s.label, s]))

/** Minimal CSV parser for the tests (quoted fields, doubled quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false; else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === '\r') continue
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else cur += ch
  }
  return rows
}

describe('wording', () => {
  it('shows engine durations in days or hours without changing the values', async () => {
    const { humanizeSeconds } = await import('./analysis')
    expect(humanizeSeconds('evaluated duration (1.2096e+06 s vs 432000 s)')).toBe('evaluated duration (14 d vs 5 d)')
    expect(humanizeSeconds('gap of 7200 s')).toBe('gap of 2 h')
    expect(humanizeSeconds('requirements fingerprint')).toBe('requirements fingerprint')
  })
})

describe('export', () => {
  it('matches the displayed comparison: eligibility, ranks, groups and the recommendation', () => {
    const x = exp()
    const s = byLabel(x)
    const e = all()
    for (const en of e) expect(s[en.scenario.label].eligibility).toBe(eligibilityOf(en))
    expect([s.B.canonical_rank, s.C.canonical_rank]).toEqual([1, 2])
    expect(s.B.ranking_group).toBe('G1')
    const d = buildDecision(e, res.ranking_groups, res.pairwise).groups.find((g) => g.group.primary)!
    expect(x.decisions.find((g) => g.group === 'G1')!.recommended).toBe(d.recommended!.scenario.label)
    expect(s.B.recommended).toBe(true)
    expect(x.ranking_groups.find((g) => g.id === 'G1')!.ranked).toEqual(
      canonicalRanking(e, res.ranking_groups).groups[0].ranked.map((r) => r.scenario.label))
    expect(x.warnings).toEqual([])
  })

  it('never exports a rank or a recommendation for FAIL, UNKNOWN or unassessed scenarios', () => {
    const s = byLabel(exp())
    expect(s.A.eligibility).toBe('fail')
    expect(s.A.canonical_rank).toBeNull()
    expect(s.A.recommended).toBe(false)
    expect(s.A.failed_requirements).toEqual(['Minimum mean visible solar-disk fraction'])
    expect(s.D.eligibility).toBe('unknown') // UNKNOWN stays UNKNOWN
    expect(s.D.assessed).toBe(false)
    expect(s.D.canonical_rank).toBeNull()
    expect(s.D.recommended).toBe(false)
  })

  it('drops an invalid rank instead of exporting it, and says so', () => {
    const a = entry('A')
    const bad = { ...a, ranking: { ...a.ranking!, rank: 1 } } // inconsistent input: FAIL with a rank
    const x = buildExport([bad, entry('B')], res.ranking_groups, res.pairwise, [])
    expect(byLabel(x).A.canonical_rank).toBeNull()
    expect(x.warnings[0]).toMatch(/rank was reported for a fail scenario and was not exported/)
  })

  it('a PASS in a separate group is exported with its group, never as the main recommendation', () => {
    const s = byLabel(exp())
    expect(s.E.ranking_group).toBe('G2')
    expect(s.E.ranking_group_primary).toBe(false)
    expect(s.E.recommended).toBe(false) // "lone" in its group, not a comparison winner
  })

  it('keeps missing values missing (null), never 0', () => {
    const s = byLabel(exp())
    expect(s.D.metrics.sunlight_percent).toEqual({ status: 'missing', unit: null, value: null, lower: null, upper: null })
    expect(s.D.score).toEqual({ status: 'eligibility_unknown', exact: null, lower: null, upper: null })
    expect(s.D.data.dataset_id).toBeNull()
    // An exact zero stays zero.
    expect(s.B.metrics.longest_blackout_h.value).toBe(0)
    expect(s.B.metrics.longest_blackout_h.status).toBe('known')
  })

  it('CSV: one row per scenario, empty cells for missing values with their status, and proper quoting', () => {
    const x = exp()
    const rows = parseCsv(toCsv(x))
    const [head, ...body] = rows
    expect(body).toHaveLength(5)
    const col = (name: string) => head.indexOf(name)
    const row = (label: string) => body.find((r) => r[col('label')] === label)!
    expect(row('D')[col('eligibility')]).toBe('unknown')
    expect(row('D')[col('sunlight_percent')]).toBe('')
    expect(row('D')[col('sunlight_percent_status')]).toBe('missing')
    expect(row('A')[col('canonical_rank')]).toBe('')
    expect(row('B')[col('canonical_rank')]).toBe('1')
    expect(row('B')[col('longest_blackout_h')]).toBe('0')
    expect(row('A')[col('failed_requirements')]).toBe('Minimum mean visible solar-disk fraction')
    // Names with commas survive quoting.
    expect(row('B')[col('name')]).toBe(x.scenarios.find((s) => s.label === 'B')!.name)
  })

  it('records provenance and versions', () => {
    const x = exp()
    const b = byLabel(x).B
    expect(x.format).toBe('comparison-export-v1')
    expect(x.generated_at).toBe('2027-01-01T00:00:00.000Z')
    expect(b.data.kind).toBe('real')
    expect(b.data.dataset_id).toBeTruthy()
    expect(b.data.engine_version).toBeTruthy()
    expect(b.ranking_explanation).not.toMatch(/rescue_/) // engine ids replaced by letters
  })

  it('exports comfortable vs limited PASS headroom, margins, initial sunset/Earthset, and screening note without collapsing bounded intervals', () => {
    const withDark = (base: Entry, label: string, opts: {
      darkHours: number
      batteryHours: number
      rank: number
      boundedDark?: [number, number]
    }): Entry => {
      const r = base.result!
      const a = r.assessment!
      const v = r.viability!
      const req = { ...v.scenario.requirements, battery_hours: opts.batteryHours, min_initial_sun_hours: 0, min_initial_comms_hours: 0 }
      const darkMetric: CanonicalMetric = opts.boundedDark
        ? { status: 'bounded', unit: 'h', value: null, lower: opts.boundedDark[0], upper: opts.boundedDark[1], reason: 'coverage gap' }
        : { status: 'known', unit: 'h', value: opts.darkHours, lower: null, upper: null, reason: null }
      const constraints = a.constraints.map((c) => (
        c.id === 'max_continuous_darkness'
          ? { ...c, threshold: opts.batteryHours, status: 'pass' as const, measured: darkMetric }
          : c
      ))
      const metrics = {
        ...a.metrics,
        longest_power_darkness_h: darkMetric,
        initial_sunlight_h: { status: 'known' as const, unit: 'h', value: 14, lower: null, upper: null, reason: null },
        time_to_first_sunset_h: { status: 'known' as const, unit: 'h', value: 14, lower: null, upper: null, reason: null },
        initial_earth_h: { status: 'known' as const, unit: 'h', value: 30, lower: null, upper: null, reason: null },
        time_to_first_earthset_h: { status: 'known' as const, unit: 'h', value: 30, lower: null, upper: null, reason: null },
      }
      const margins = opts.boundedDark
        ? [{
            id: 'max_continuous_darkness',
            name: 'Maximum continuous power-darkness',
            short_label: 'Max continuous darkness',
            unit: 'h',
            measured: { status: 'bounded' as const, unit: 'h', value: null, lower: opts.boundedDark[0], upper: opts.boundedDark[1] },
            margin_class: 'narrow' as const,
            margin: { status: 'bounded' as const, unit: 'h', value: null, lower: 1, upper: 8 },
            narrow_reason: 'Darkness headroom bounded within +[1..8] h against 50 h limit',
            description: 'Longest power-dark period vs battery limit',
          }]
        : undefined
      const ranking = { ...base.ranking!, eligibility: 'pass' as const, rank: opts.rank }
      const result: CompareResult = {
        ...r,
        key: label,
        ranking,
        viability: {
          ...v,
          passes: true,
          eligibility: 'pass',
          headroom: undefined,
          scenario: { ...v.scenario, requirements: req },
          metrics: { ...v.metrics, longest_dark_gap_hours: opts.darkHours, initial_sun_hours: 14, hours_to_first_sunset: 14, initial_comms_hours: 30, hours_to_first_earthset: 30 },
        },
        assessment: { ...a, headroom: undefined, margins, constraints, metrics },
      }
      return { ...base, scenario: { ...base.scenario, id: `s-${label}`, label, requirements: req }, result, state: { state: 'done', result }, ranking }
    }

    const comf = withDark(entry('B'), 'B', { darkHours: 15, batteryHours: 50, rank: 1 })
    const lim = withDark(entry('C'), 'C', { darkHours: 49, batteryHours: 50, rank: 2 })
    const bnd = withDark(entry('B'), 'X', { darkHours: 49, batteryHours: 50, rank: 3, boundedDark: [42, 49] })
    const exported = buildExport([comf, lim, bnd], res.ranking_groups.filter((g) => g.id === 'G1'), res.pairwise, [], new Date('2027-01-01T00:00:00Z'))
    const s = byLabel(exported)

    expect(s.B.headroom!.status).toBe('comfortable')
    expect(s.B.headroom!.darkness_headroom!.value).toBe(35)
    expect(s.C.headroom!.status).toBe('limited')
    expect(s.C.headroom!.qualified_verdict).toContain('limited darkness margin')
    expect(s.C.headroom!.closest_constraint!.label).toBe('Max continuous darkness')
    expect(s.C.metrics.time_to_first_sunset_h.value).toBe(14)
    expect(s.C.metrics.time_to_first_earthset_h.value).toBe(30)
    expect(s.C.headroom!.screening_note).toBe(SCREENING_NOTE)
    expect(exported.notes).toContain(SCREENING_NOTE)

    expect(s.X.metrics.longest_power_darkness_h).toEqual({ status: 'bounded', unit: 'h', value: null, lower: 42, upper: 49 })
    expect(s.X.margins[0].margin).toEqual({ status: 'bounded', unit: 'h', value: null, lower: 1, upper: 8 })
    expect(s.X.headroom!.darkness_headroom).toEqual({ status: 'bounded', unit: 'h', value: null, lower: 1, upper: 8 })

    const rows = parseCsv(toCsv(exported))
    const [head, ...body] = rows
    const col = (name: string) => head.indexOf(name)
    const row = (label: string) => body.find((r) => r[col('label')] === label)!
    expect(row('B')[col('headroom_status')]).toBe('comfortable')
    expect(row('C')[col('headroom_status')]).toBe('limited')
    expect(row('C')[col('darkness_headroom')]).toBe('1')
    expect(row('C')[col('time_to_first_sunset_h')]).toBe('14')
    expect(row('C')[col('time_to_first_earthset_h')]).toBe('30')
    expect(row('C')[col('screening_note')]).toBe(SCREENING_NOTE)
    expect(row('X')[col('darkness_headroom')]).toBe('')
    expect(row('X')[col('darkness_headroom_lower')]).toBe('1')
    expect(row('X')[col('darkness_headroom_upper')]).toBe('8')
    expect(row('X')[col('darkness_headroom_status')]).toBe('bounded')
    expect(row('X')[col('longest_power_darkness_h')]).toBe('')
    expect(row('X')[col('longest_power_darkness_h_lower')]).toBe('42')
    expect(row('X')[col('longest_power_darkness_h_upper')]).toBe('49')
  })
})
