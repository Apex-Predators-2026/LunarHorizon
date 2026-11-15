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
  cellScenario,
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
import noneJson from './__fixtures__/atlas-none-feasible.json'

const malapert = malapertJson as unknown as AtlasResponse
const none = noneJson as unknown as AtlasResponse
const site = { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.99, lon: 0.6 }

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
    expect(robustnessText(malapert, 1, 3)).toMatch(/Viable for 9 consecutive tested dates, 2027-01-01 to 2027-01-09 \(the run reaches the edge of the search/)
    // The last passing date before the boundary: the next tested date fails.
    expect(neighbourhood(malapert, 1, 8).after).toBe('fail')
    // An isolated pass (7 d, last tested date) and a fail next to a pass.
    expect(robustnessText(malapert, 0, 15)).toMatch(/^Viable only at this tested date|run reaches the edge/)
    expect(robustnessText(malapert, 0, 14)).toBe('Not viable here, but a neighbouring tested date (1 d away) passes.')
    expect(robustnessText(malapert, 0, 11)).toBe('Not viable here or at the neighbouring tested dates.')
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

  it('sends exactly the selected mission to the Planner', () => {
    const cell = malapert.cells[0][4]
    const sc = cellScenario(malapert, cell, site)
    expect(sc).toEqual({
      site: { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.99, lon: 0.6 },
      landing_utc: '2027-01-05T00:00:00Z',
      duration_days: 7,
      requirements: malapert.requirements_input,
    })
    expect(Date.parse(sc.landing_utc)).toBe(Date.parse('2027-01-05T00:00:00Z'))
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
