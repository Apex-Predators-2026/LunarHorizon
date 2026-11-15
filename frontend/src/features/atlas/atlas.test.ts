// Feasibility Atlas logic, on real /api/atlas responses (fixtures made by the backend from the committed site files):
//   atlas-malapert.json       Malapert Massif, 16 daily landings from 2027-01-01, 7 and 28-day missions, default
//                             requirements: 7 d passes 01-01..01-08, fails 01-09..01-15, passes again 01-16;
//                             28 d passes 01-01..01-09, then fails.
//   atlas-none-feasible.json  Connecting Ridge, 14-day missions from 2030-12-25 with a 5 h battery: nothing
//                             passes, and the last 3 landings are after the data ends (not evaluated).
import { describe, expect, it } from 'vitest'

import {
  STATUS,
  cellLabel,
  limitText,
  measuredText,
  moveSelection,
  neighbourhood,
  noFeasibleSummary,
  robustnessText,
  searchBounds,
  type AtlasResponse,
} from './atlas'
import malapertJson from './__fixtures__/atlas-malapert.json'
import type { CellStatus } from './atlas'
import { noPassSummary, rowWindowsText } from './atlas'
import noneJson from './__fixtures__/atlas-none-feasible.json'

const malapert = malapertJson as unknown as AtlasResponse
const none = noneJson as unknown as AtlasResponse

describe('Feasibility Atlas', () => {
  it('has four distinct states, each with its own word and symbol (never colour alone)', () => {
    const labels = Object.values(STATUS).map((s) => s.label)
    const symbols = Object.values(STATUS).map((s) => s.symbol)
    expect(new Set(labels).size).toBe(4)
    expect(new Set(symbols).size).toBe(4)
    expect(Object.keys(STATUS).sort()).toEqual(['fail', 'not_evaluated', 'pass', 'unknown'])
  })

  it('every cell has a text label with its date, length, state and reason', () => {
    const t = cellLabel(malapert, 1, 10)
    expect(t).toMatch(/^Landing 2027-01-11 00:00 UTC, 28 d mission: Fails\. Fails: /)
    expect(cellLabel(none, 0, 9)).toMatch(/Not evaluated\. No data for this landing/)
  })

  it('explains a failing cell by its limiting requirement, with the limit and the measured value', () => {
    const cell = malapert.cells[1][10]
    expect(cell.status).toBe('fail')
    const req = malapert.requirements.find((q) => q.id === cell.limiting)!
    const c = cell.constraints!.find((x) => x.id === cell.limiting)!
    expect(c.status).toBe('fail')
    expect(cell.reason).toContain(req.name!)
    expect(limitText(req)).toMatch(/^[≥≤] /)
    expect(measuredText(c, req.unit)).not.toBe('unavailable')
    expect(c.margin!).toBeLessThan(0) // misses its limit
  })

  it('shows whether a candidate stays viable at the neighbouring tested dates', () => {
    // 28-day missions: a run of passes from the first tested date to 2027-01-09, then fails.
    const n = neighbourhood(malapert, 1, 3)
    expect(n.run).toMatchObject({ from: '2027-01-01T00:00Z', to: '2027-01-09T00:00Z', length: 9, touchesStart: true })
    expect(robustnessText(malapert, 1, 3)).toBe(
      'Passes at 9 consecutive tested dates, 2027-01-01 to 2027-01-09, one every 1 d: 9 tested opportunities, not a guarantee for the times between them. The run reaches the start of the search; dates beyond it were not tested.')
    // The last passing date before the boundary: the next tested date fails.
    expect(neighbourhood(malapert, 1, 8).after).toBe('fail')
    // An isolated pass on the last tested date: only one neighbour exists, and it is not said to be tested after.
    expect(robustnessText(malapert, 0, 15)).toBe('Passes at this tested date only. The tested date 1 d before fails; there is no tested date after it (end of the search).')
    expect(robustnessText(malapert, 0, 14)).toMatch(/^Fails here: .+ is not met\. The tested date 1 d before fails; the one 1 d after passes\.$/)
    expect(robustnessText(malapert, 0, 11)).toMatch(/^Fails here: .+\. The tested dates 1 d before and after both fail\.$/)
    // The strip stays within the grid.
    expect(neighbourhood(malapert, 0, 0).cells.map((c) => c.col)).toEqual([0, 1, 2, 3, 4])
  })

  it('summarises what rules everything out when nothing is feasible', () => {
    expect(none.counts.pass).toBe(0)
    expect(none.counts.not_evaluated).toBe(3)
    const top = noFeasibleSummary(none)
    expect(top.length).toBeGreaterThan(0)
    expect(top.reduce((n, t) => n + t.cells, 0)).toBe(none.counts.fail) // every failing cell counted once
    expect(top[0].requirement.name).toBeTruthy()
  })

  it('states the search bounds and size', () => {
    expect(searchBounds({ start_utc: '2027-01-01T00:00:00Z', step_hours: 24, count: 16, durations_days: [7, 28] }))
      .toEqual({ first: '2027-01-01T00:00:00Z', last: '2027-01-16T00:00:00.000Z', cells: 32 })
    expect(malapert.landing_utc).toHaveLength(16)
    expect(malapert.method).toMatch(/nothing is interpolated/)
  })

  it('moves the selection with the keyboard, staying inside the grid', () => {
    expect(moveSelection('ArrowRight', 0, 15, 2, 16)).toEqual([0, 15])
    expect(moveSelection('ArrowDown', 0, 3, 2, 16)).toEqual([1, 3])
    expect(moveSelection('ArrowUp', 0, 3, 2, 16)).toEqual([0, 3])
    expect(moveSelection('End', 1, 3, 2, 16)).toEqual([1, 15])
    expect(moveSelection('PageDown', 1, 12, 2, 16)).toEqual([1, 15])
    expect(moveSelection('x', 1, 3, 2, 16)).toBeNull()
  })
})

/** A one-row map with the given statuses (7-day missions, daily landings), built from the real fixture's metadata. */
function line(statuses: CellStatus[]): AtlasResponse {
  const landing = statuses.map((_, i) => `2027-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`)
  const counts = { pass: 0, fail: 0, unknown: 0, not_evaluated: 0 } as Record<CellStatus, number>
  statuses.forEach((st) => counts[st]++)
  return {
    ...malapert, landing_utc: landing, durations_days: [7], counts,
    cells: [statuses.map((st, i) => ({ landing_utc: landing[i], duration_days: 7, status: st, reason: st,
      limiting: st === 'fail' ? 'max_continuous_darkness' : null }))],
  }
}

describe('Atlas narratives keep the canonical states apart', () => {
  it('UNKNOWN is undecided, never "not viable", and neighbouring unknowns stay unknown', () => {
    const t = robustnessText(line(['fail', 'unknown', 'unknown']), 0, 1)
    expect(t).toMatch(/^Feasibility can't be decided here/)
    expect(t).toContain('this is not a failure')
    expect(t).toContain("The tested date 1 d before fails; the one 1 d after can't be decided from the data.")
    expect(t).not.toMatch(/not viable/i)
  })

  it('NOT_EVALUATED says no assessment was performed', () => {
    const t = robustnessText(line(['not_evaluated', 'not_evaluated', 'pass']), 0, 1)
    expect(t).toMatch(/^Not assessed: this landing is outside the site's data, so no mission was evaluated\./)
    expect(t).toContain('The tested date 1 d before was not evaluated (no data); the one 1 d after passes.')
  })

  it('FAIL names the demonstrated requirement and does not call undecided neighbours failures', () => {
    const t = robustnessText(line(['unknown', 'fail', 'not_evaluated']), 0, 1)
    expect(t).toMatch(/^Fails here: .*darkness.* is not met\./i)
    expect(t).toContain("before can't be decided from the data; the one 1 d after was not evaluated (no data).")
  })

  it('a pass at the first tested date does not imply the date before was tested', () => {
    const t = robustnessText(line(['pass', 'fail']), 0, 0)
    expect(t).toBe('Passes at this tested date only. There is no tested date before it (start of the search); the one 1 d after fails.')
  })

  it('a single-cell map', () => {
    expect(robustnessText(line(['pass']), 0, 0)).toBe('Passes at this tested date only. It is the only tested date, so no neighbouring date was tested.')
    expect(robustnessText(line(['unknown']), 0, 0)).toMatch(/can't be decided here.*It is the only tested date/)
  })

  it('runs are consecutive tested opportunities, and a run inside the search is not said to touch an edge', () => {
    const t = robustnessText(line(['fail', 'pass', 'pass', 'pass', 'unknown']), 0, 2)
    expect(t).toBe('Passes at 3 consecutive tested dates, 2027-01-02 to 2027-01-04, one every 1 d: 3 tested opportunities, not a guarantee for the times between them.')
    const both = robustnessText(line(['pass', 'pass']), 0, 0)
    expect(both).toContain('The run reaches the start and end of the search')
  })

  it('nothing passes: confirmed failures, undecided and unevaluated cells are told apart', () => {
    expect(noPassSummary(line(['unknown', 'unknown', 'unknown']))).toEqual({
      kind: 'none_confirmed',
      text: "No tested mission can be confirmed to pass, and none is shown to fail: of 3 missions, 3 can't be decided from the data. Undecided is not a failure; more complete data could settle it.",
    })
    const mixed = noPassSummary(line(['fail', 'unknown', 'not_evaluated', 'not_evaluated']))
    expect(mixed.kind).toBe('failures')
    expect(mixed.text).toBe("No tested mission meets every requirement here: of 4 missions, 1 fails a requirement, 1 can't be decided from the data, 2 were not evaluated (outside the site's data).")
    expect(noPassSummary(line(['not_evaluated', 'not_evaluated'])).kind).toBe('none_evaluated')
    // Only confirmed failures are counted as deciding requirements.
    expect(noFeasibleSummary(line(['unknown', 'fail', 'not_evaluated'])).map((x) => x.cells)).toEqual([1])
  })

  it('row summaries never call undecided or unevaluated dates failures', () => {
    expect(rowWindowsText(line(['unknown', 'not_evaluated', 'unknown']), 0)).toBe("no tested landing passes (2 can't be decided, 1 not evaluated)")
    expect(rowWindowsText(line(['pass', 'unknown', 'pass', 'pass']), 0)).toBe('pass at tested landings 2027-01-01, 2027-01-03 to 2027-01-04')
    // Real fixture with missing coverage at the end of the data.
    expect(rowWindowsText(none, 0)).toMatch(/^no tested landing passes \(\d+ fail.*3 not evaluated\)$/)
  })
})
