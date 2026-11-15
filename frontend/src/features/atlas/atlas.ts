// Feasibility Atlas: types for /api/atlas and the pure logic behind the view (tested in atlas.test.ts).
// "Which landing dates work for this mission length, and why does this boundary appear?"
import type { MissionRequirements } from '../../types'

export type CellStatus = 'pass' | 'fail' | 'unknown' | 'not_evaluated'

export interface AtlasRequest {
  site_id: string
  start_utc: string
  step_hours: number
  count: number
  durations_days: number[]
  requirements: MissionRequirements
}

export interface RequirementInfo {
  id: string
  name?: string | null
  comparison?: 'at_least' | 'at_most' | null
  threshold?: number | null // display units; absent = not an active requirement
  unit: string // h | % | fraction | deg
  requirement_field?: string | null
}

export interface CellConstraint {
  id: string
  status: 'pass' | 'fail' | 'unknown' | 'not_applicable'
  measured: 'known' | 'bounded' | 'unavailable' | 'not_applicable'
  value?: number | null
  lower?: number | null
  upper?: number | null
  margin?: number | null
  note?: string | null
}

export interface AtlasCell {
  landing_utc: string
  duration_days: number
  status: CellStatus
  limiting?: string | null
  reason: string
  constraints?: CellConstraint[]
}

export interface AtlasResponse {
  site_id: string
  site_name: string
  data_start_utc: string
  data_stop_utc: string
  start_utc: string // first landing evaluated (hourly data grid)
  step_hours: number
  time_note?: string // plain note when the grid moved the start or a length
  landing_utc: string[]
  durations_days: number[]
  requirements_input: MissionRequirements
  requirements: RequirementInfo[]
  cells: AtlasCell[][] // [duration row][landing column]
  counts: Record<CellStatus, number>
  engine_version: string
  method: string
  limitations: string[]
}

export const MAX_CELLS = 600 // backend limit (app/atlas/schemas.py)

/** Every state is told apart by a word and a symbol, never by colour alone. */
export const STATUS: Record<CellStatus, { label: string; symbol: string; long: string }> = {
  pass: { label: 'Passes', symbol: '✓', long: 'meets every requirement' },
  fail: { label: 'Fails', symbol: '✕', long: 'fails a requirement' },
  unknown: { label: 'Undecided', symbol: '?', long: "can't be decided from the data" },
  not_evaluated: { label: 'Not evaluated', symbol: '–', long: 'no data for this landing, not evaluated' },
}

export const STEP_OPTIONS = [
  { hours: 6, label: 'every 6 hours' },
  { hours: 12, label: 'every 12 hours' },
  { hours: 24, label: 'every day' },
  { hours: 48, label: 'every 2 days' },
  { hours: 72, label: 'every 3 days' },
] as const

export const fmtUtc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`
export const fmtDay = (iso: string) => iso.slice(0, 10)

/** "7 d", "1.5 d" */
export const fmtDays = (d: number) => `${Number.isInteger(d) ? d : d.toFixed(1)} d`

/** A value in the requirement's display unit. Fractions are shown as percentages. */
export function fmtValue(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined) return '—'
  // One decimal for percentages: near a limit, 49.6% must not read as the 50% it fails to reach.
  if (unit === 'fraction') return `${(v * 100).toFixed(1)}%`
  if (unit === '%') return `${v.toFixed(1)}%`
  if (unit === 'deg') return `${v.toFixed(2)}°`
  if (unit === 'h') return `${v.toFixed(0)} h`
  return `${v}`
}

/** "≥ 24 h", "≤ 50 h" */
export function limitText(r: RequirementInfo): string {
  if (r.threshold === null || r.threshold === undefined) return 'not required'
  return `${r.comparison === 'at_most' ? '≤' : '≥'} ${fmtValue(r.threshold, r.unit)}`
}

export function measuredText(c: CellConstraint, unit: string): string {
  if (c.measured === 'known') return fmtValue(c.value, unit)
  if (c.measured === 'bounded') return `${fmtValue(c.lower, unit)} to ${fmtValue(c.upper, unit)}`
  if (c.measured === 'not_applicable') return 'not applicable'
  return 'unavailable'
}

/** The requirements that are actually checked (a limit is set). */
export const activeRequirements = (r: AtlasResponse) => r.requirements.filter((q) => q.threshold !== null && q.threshold !== undefined)

/** Short text for one cell, for screen readers and tooltips. */
export function cellLabel(r: AtlasResponse, row: number, col: number): string {
  const c = r.cells[row][col]
  return `Landing ${fmtUtc(c.landing_utc)}, ${fmtDays(c.duration_days)} mission: ${STATUS[c.status].label}. ${c.reason}`
}

export interface Neighbourhood {
  cells: { col: number; landing_utc: string; status: CellStatus; selected: boolean }[]
  /** The run of consecutive PASS tested dates containing the selected one (null if it doesn't pass). */
  run: { from: string; to: string; length: number; touchesStart: boolean; touchesEnd: boolean } | null
  before: CellStatus | null // the tested date just before / after (same duration)
  after: CellStatus | null
}

/** The selected mission at its neighbouring tested landing dates (same duration). */
export function neighbourhood(r: AtlasResponse, row: number, col: number, radius = 4): Neighbourhood {
  const line = r.cells[row]
  const lo = Math.max(0, col - radius)
  const hi = Math.min(line.length - 1, col + radius)
  const cells = []
  for (let i = lo; i <= hi; i++) cells.push({ col: i, landing_utc: line[i].landing_utc, status: line[i].status, selected: i === col })
  let run: Neighbourhood['run'] = null
  if (line[col].status === 'pass') {
    let a = col
    let b = col
    while (a > 0 && line[a - 1].status === 'pass') a--
    while (b < line.length - 1 && line[b + 1].status === 'pass') b++
    run = { from: line[a].landing_utc, to: line[b].landing_utc, length: b - a + 1, touchesStart: a === 0, touchesEnd: b === line.length - 1 }
  }
  return { cells, run, before: col > 0 ? line[col - 1].status : null, after: col < line.length - 1 ? line[col + 1].status : null }
}

const stepText = (r: AtlasResponse) => (r.step_hours % 24 === 0 ? `${r.step_hours / 24} d` : `${r.step_hours} h`)

/** What a neighbouring tested date shows, in words. null = there is no tested date on that side (search edge). */
const NEIGHBOUR_WORD: Record<CellStatus, string> = {
  pass: 'passes',
  fail: 'fails',
  unknown: "can't be decided from the data",
  not_evaluated: 'was not evaluated (no data)',
}
const NEIGHBOURS_WORD: Record<CellStatus, string> = {
  pass: 'pass',
  fail: 'fail',
  unknown: "can't be decided from the data",
  not_evaluated: 'were not evaluated (no data)',
}

/** The tested dates either side of the selected one, without turning an edge or an undecided date into a failure. */
function neighboursText(before: CellStatus | null, after: CellStatus | null, step: string): string {
  if (before === null && after === null) return 'It is the only tested date, so no neighbouring date was tested.'
  if (before !== null && before === after) return `The tested dates ${step} before and after both ${NEIGHBOURS_WORD[before]}.`
  const b = before === null ? 'There is no tested date before it (start of the search)' : `The tested date ${step} before ${NEIGHBOUR_WORD[before]}`
  const a = after === null ? 'there is no tested date after it (end of the search)' : `the one ${step} after ${NEIGHBOUR_WORD[after]}`
  return `${b}; ${a}.`
}

/**
 * How the selected date compares with its neighbouring tested dates (same duration). Uses the canonical states as
 * they are: an undecided cell is never described as a failure, an unevaluated one never as assessed, and dates
 * outside the search are never described at all except as untested.
 */
export function robustnessText(r: AtlasResponse, row: number, col: number): string {
  const line = r.cells[row]
  const c = line[col]
  const n = neighbourhood(r, row, col)
  const step = stepText(r)
  const around = neighboursText(n.before, n.after, step)
  switch (c.status) {
    case 'pass': {
      const run = n.run!
      if (run.length === 1) return `Passes at this tested date only. ${around}`
      const edges = [run.touchesStart && 'start', run.touchesEnd && 'end'].filter(Boolean).join(' and ')
      return (
        `Passes at ${run.length} consecutive tested dates, ${fmtDay(run.from)} to ${fmtDay(run.to)}, one every ${step}: ` +
        `${run.length} tested opportunities, not a guarantee for the times between them.` +
        (edges ? ` The run reaches the ${edges} of the search; dates beyond it were not tested.` : '')
      )
    }
    case 'fail': {
      const q = r.requirements.find((x) => x.id === c.limiting)
      return `Fails here${q ? `: ${q.name ?? q.id} (${limitText(q)}) is not met` : ': a requirement is not met'}. ${around}`
    }
    case 'unknown':
      return `Feasibility can't be decided here: the data cannot settle at least one requirement (this is not a failure). ${around}`
    case 'not_evaluated':
      return `Not assessed: this landing is outside the site's data, so no mission was evaluated. ${around}`
  }
}

/** A grid with no PASS: confirmed failures, undecided and unevaluated cells told apart. */
export function noPassSummary(r: AtlasResponse): { kind: 'none_evaluated' | 'none_confirmed' | 'failures'; text: string } {
  const { fail, unknown, not_evaluated: ne } = r.counts
  const total = r.cells.reduce((a, row) => a + row.length, 0)
  const parts = [
    fail && `${fail} fail${fail === 1 ? 's' : ''} a requirement`,
    unknown && `${unknown} can't be decided from the data`,
    ne && `${ne} ${ne === 1 ? 'was' : 'were'} not evaluated (outside the site's data)`,
  ].filter(Boolean).join(', ')
  if (ne === total)
    return { kind: 'none_evaluated', text: `Nothing was evaluated: every tested landing is outside this site's data (${fmtDay(r.data_start_utc)} to ${fmtDay(r.data_stop_utc)}). Move the first landing date into that range.` }
  if (fail === 0)
    return { kind: 'none_confirmed', text: `No tested mission can be confirmed to pass, and none is shown to fail: of ${total} missions, ${parts}. Undecided is not a failure; more complete data could settle it.` }
  return { kind: 'failures', text: `No tested mission meets every requirement here: of ${total} missions, ${parts}.` }
}

/** Per duration row, the passing runs of consecutive tested dates, or what the row shows instead of a pass. */
export function rowWindowsText(r: AtlasResponse, row: number): string {
  const line = r.cells[row]
  const runs: string[] = []
  let start = -1
  line.forEach((c, i) => {
    if (c.status === 'pass' && start < 0) start = i
    if ((c.status !== 'pass' || i === line.length - 1) && start >= 0) {
      const end = c.status === 'pass' ? i : i - 1
      runs.push(start === end ? fmtDay(line[start].landing_utc) : `${fmtDay(line[start].landing_utc)} to ${fmtDay(line[end].landing_utc)}`)
      start = -1
    }
  })
  if (runs.length) return `pass at tested landings ${runs.join(', ')}`
  const count = (st: CellStatus) => line.filter((c) => c.status === st).length
  const parts = [
    count('fail') && `${count('fail')} fail`,
    count('unknown') && `${count('unknown')} can't be decided`,
    count('not_evaluated') && `${count('not_evaluated')} not evaluated`,
  ].filter(Boolean).join(', ')
  return `no tested landing passes (${parts})`
}

/** For a grid with nothing feasible: which requirements rule out the most cells, and the nearest miss. */
export function noFeasibleSummary(r: AtlasResponse): { requirement: RequirementInfo; cells: number }[] {
  const count = new Map<string, number>()
  for (const row of r.cells) for (const c of row) if (c.status === 'fail' && c.limiting) count.set(c.limiting, (count.get(c.limiting) ?? 0) + 1)
  const byId = new Map(r.requirements.map((q) => [q.id, q]))
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ requirement: byId.get(id) ?? { id, unit: '' }, cells: n }))
}

/** Grid size and time span of a request, for the "search bounds" line. */
export function searchBounds(q: Pick<AtlasRequest, 'start_utc' | 'step_hours' | 'count' | 'durations_days'>) {
  const last = new Date(Date.parse(q.start_utc) + (q.count - 1) * q.step_hours * 3_600_000).toISOString()
  return { first: q.start_utc, last, cells: q.count * q.durations_days.length }
}

/** Keyboard movement in the grid (arrow keys, Home / End, Page Up / Down = 7 columns). */
export function moveSelection(key: string, row: number, col: number, rows: number, cols: number): [number, number] | null {
  switch (key) {
    case 'ArrowLeft': return [row, Math.max(0, col - 1)]
    case 'ArrowRight': return [row, Math.min(cols - 1, col + 1)]
    case 'ArrowUp': return [Math.max(0, row - 1), col]
    case 'ArrowDown': return [Math.min(rows - 1, row + 1), col]
    case 'Home': return [row, 0]
    case 'End': return [row, cols - 1]
    case 'PageUp': return [row, Math.max(0, col - 7)]
    case 'PageDown': return [row, Math.min(cols - 1, col + 7)]
    default: return null
  }
}
