// Layout shared by the Mission Report preview (HTML) and its PDF: the pages and sections in order, the formal colour
// scheme, the figures (data and geometry) and the text clean-up the PDF's built-in fonts need. One definition, so the
// preview, the PDF and the Mission Assistant's section guide never disagree.
//
// Style: a formal technical report. Black text on white, thin black rules, plain status words; colour only in the
// figures, and only muted, conventional tones.
import type { CardValue, ReportCard } from './reportCard'

export const SECTIONS = [
  { id: 'rc-summary', title: 'Executive summary', page: 2, contains: 'The plans compared, their assessment status, a summary of the results and the key findings.' },
  { id: 'rc-overview', title: 'Mission overview', page: 3, contains: 'Per plan: site and coordinates, landing time, mission duration, spacecraft, mission requirements, status, eligibility and canonical rank.' },
  { id: 'rc-performance', title: 'Mission performance', page: 4, contains: 'Figures 1 to 5 (mean visible solar disk, longest darkness, Earth in line of sight and longest communication blackout against their limits, and requirement outcomes per plan), then the solar performance, communication performance and mission viability tables.' },
  { id: 'rc-analysis', title: 'Comparison analysis', page: 5, contains: 'Which plan does better on sunlight, darkness, Earth visibility, communication blackout and requirements, and the measured trade-offs.' },
  { id: 'rc-requirements', title: 'Mission requirements assessment', page: 5, contains: 'Every configured requirement with each plan\'s PASS / FAIL / UNKNOWN, measured value, limit and margin, and why any requirement is UNKNOWN.' },
  { id: 'rc-strengths', title: 'Strengths and weaknesses', page: 6, contains: 'Per plan: requirements met, measured advantages, violated or undecided requirements and narrow margins.' },
  { id: 'rc-final', title: 'Final assessment and recommendation', page: 6, contains: 'Plans grouped as eligible PASS, FAIL, UNKNOWN or not assessed; the recommendation (or why there is none) with its evidence and uncertainty.' },
  { id: 'rc-sources', title: 'Data sources and methodology', page: 7, contains: 'NASA JPL Horizons and LOLA sources, datasets, data coverage per plan, assessment method, versions, main uncertainty and limitations.' },
  { id: 'rc-disclaimer', title: 'Disclaimer', page: 7, contains: 'What this report is and is not (a planning aid, not an official NASA mission approval).' },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']
/** Page 1 is the title page with the contents; the numbered sections start on page 2. */
export const PAGE_COUNT = Math.max(...SECTIONS.map((s) => s.page))
export const sectionNumber = (id: SectionId) => SECTIONS.findIndex((s) => s.id === id) + 1

/** Formal palette: black text and rules; one muted blue for bars; muted green / red / ochre only for outcomes. */
export const COLORS = {
  ink: '#000000',
  ink2: '#262626',
  ink3: '#595959',
  rule: '#000000',
  hair: '#a6a6a6',
  grid: '#d9d9d9',
  shade: '#f2f2f2',
  bar: '#4a6890',
  pass: '#5b8a5b',
  fail: '#a94442',
  unknown: '#c8a03c',
} as const

/** Eligibility shown beside the status: INELIGIBLE is distinguished from FAIL. */
export const ELIGIBILITY_SHORT = (e: string) => (e.startsWith('Eligible') ? 'ELIGIBLE' : e.startsWith('Ineligible') ? 'INELIGIBLE' : 'NOT ASSESSED')

// ---------------------------------------------------------------- figures

export interface FigureBar {
  label: string
  value: CardValue
  /** The exact value, or null (no bar is drawn; the reason is written instead). */
  v: number | null
}

export interface BarFigure {
  kind: 'bars'
  number: number
  title: string
  caption: string
  unit: '%' | 'h'
  better: 'higher' | 'lower'
  max: number
  ticks: number[]
  bars: FigureBar[]
  limit: { value: number; text: string } | null
}

export interface OutcomeFigure {
  kind: 'outcomes'
  number: number
  title: string
  caption: string
  max: number
  ticks: number[]
  rows: { label: string; pass: number; fail: number; unknown: number; assessed: boolean }[]
}

export type Figure = BarFigure | OutcomeFigure

/** A round axis maximum and its ticks (steps of 1, 2, 2.5 or 5 × 10^k). */
export function niceAxis(max: number): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 10, ticks: [0, 2.5, 5, 7.5, 10] }
  const raw = max / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!
  const top = step * Math.ceil(max / step)
  const ticks: number[] = []
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Math.round(t * 1000) / 1000)
  return { max: top, ticks }
}

const FIGURE_ROWS: { table: 'solar' | 'communication'; id: string; requirement: string; title: string; unit: '%' | 'h'; what: string }[] = [
  { table: 'solar', id: 'disk', requirement: 'min_mean_solar_disk_fraction', title: 'Mean visible solar disk', unit: '%', what: 'Time-mean share of the solar disk above the local terrain' },
  { table: 'solar', id: 'dark', requirement: 'max_continuous_darkness', title: 'Longest continuous power darkness', unit: 'h', what: 'Longest stretch the lander must survive on batteries' },
  { table: 'communication', id: 'earth_share', requirement: 'min_earth_visibility_percent', title: 'Earth in line of sight', unit: '%', what: 'Share of the mission with Earth above the local terrain (geometric visibility)' },
  { table: 'communication', id: 'blackout', requirement: 'max_communication_blackout', title: 'Longest communication blackout', unit: 'h', what: 'Longest stretch with Earth below the local terrain horizon' },
]

/** Figures 1 to 5, from the report card only: the four headline measures against their limits, and outcomes. */
export function reportFigures(card: ReportCard): Figure[] {
  const bars: BarFigure[] = FIGURE_ROWS.map((f, i) => {
    const row = card.performance[f.table].find((r) => r.id === f.id)!
    const req = card.requirements.rows.find((r) => r.id === f.requirement)
    const limit = req && req.limit_value !== null && req.limit ? { value: req.limit_value, text: `Limit ${req.limit}` } : null
    const vals = card.labels.map((l) => row.values[l].num).filter((n): n is number => n !== undefined)
    const axis = f.unit === '%' ? { max: 100, ticks: [0, 25, 50, 75, 100] } : niceAxis(Math.max(0, ...vals, limit?.value ?? 0))
    return {
      kind: 'bars', number: i + 1, title: f.title, unit: f.unit, better: row.better ?? 'higher', max: axis.max, ticks: axis.ticks,
      caption: `${f.what}, by plan (${row.better === 'lower' ? 'lower' : 'higher'} is better)${limit ? '. The dashed line is the requirement limit' : ''}.`,
      bars: card.labels.map((l) => ({ label: l, value: row.values[l], v: row.values[l].num ?? null })),
      limit,
    }
  })
  const rows = card.labels.map((l) => {
    const cells = card.requirements.rows.map((r) => r.cells[l])
    return {
      label: l,
      pass: cells.filter((c) => c.status === 'PASS').length,
      fail: cells.filter((c) => c.status === 'FAIL').length,
      unknown: cells.filter((c) => c.status === 'UNKNOWN').length,
      assessed: cells.some((c) => c.status !== 'NOT ASSESSED' && c.status !== 'NOT CONFIGURED'),
    }
  })
  const most = Math.max(1, ...rows.map((r) => r.pass + r.fail + r.unknown))
  const outcomes: OutcomeFigure = {
    kind: 'outcomes', number: 5, title: 'Requirement outcomes by plan', max: most,
    ticks: Array.from({ length: most + 1 }, (_, i) => i).filter((t) => most <= 8 || t % 2 === 0),
    caption: 'Number of configured requirements each plan meets (PASS), violates (FAIL) or cannot decide from the data (UNKNOWN, not a failure).',
    rows,
  }
  return [...bars, outcomes]
}

// ---------------------------------------------------------------- figure geometry (shared by SVG and PDF)

export const FIG = { width: 480, label: 62, value: 104, top: 4, row: 17, bar: 10, axis: 25 } as const

export interface BarGeometry {
  width: number
  height: number
  plot: { x0: number; x1: number; y0: number; y1: number }
  ticks: { x: number; text: string }[]
  rows: { label: string; y: number; x: number; w: number | null; valueText: string; missing: boolean }[]
  limit: { x: number; text: string } | null
}

const fmtTick = (t: number, unit: string) => `${Number.isInteger(t) ? t : t.toFixed(1)}${unit === '%' ? '%' : unit === 'h' ? ' h' : ''}`

export function barGeometry(f: BarFigure): BarGeometry {
  const x0 = FIG.label, x1 = FIG.width - FIG.value
  const y0 = FIG.top, y1 = FIG.top + f.bars.length * FIG.row
  const sx = (v: number) => x0 + (Math.max(0, Math.min(v, f.max)) / f.max) * (x1 - x0)
  return {
    width: FIG.width,
    height: y1 + FIG.axis,
    plot: { x0, x1, y0, y1 },
    ticks: f.ticks.map((t) => ({ x: sx(t), text: fmtTick(t, f.unit) })),
    rows: f.bars.map((b, i) => ({
      label: `Scenario ${b.label}`,
      y: y0 + i * FIG.row + (FIG.row - FIG.bar) / 2,
      x: x0,
      w: b.v === null ? null : Math.max(sx(b.v) - x0, b.v > 0 ? 1 : 0),
      valueText: b.value.text,
      missing: b.v === null,
    })),
    limit: f.limit ? { x: sx(f.limit.value), text: f.limit.text } : null,
  }
}

export interface OutcomeGeometry {
  width: number
  height: number
  plot: { x0: number; x1: number; y0: number; y1: number }
  ticks: { x: number; text: string }[]
  rows: { label: string; y: number; segments: { x: number; w: number; n: number; kind: 'pass' | 'fail' | 'unknown' }[]; note: string }[]
}

export function outcomeGeometry(f: OutcomeFigure): OutcomeGeometry {
  const x0 = FIG.label, x1 = FIG.width - FIG.value
  const y0 = FIG.top, y1 = FIG.top + f.rows.length * FIG.row
  const unit = (x1 - x0) / f.max
  return {
    width: FIG.width,
    height: y1 + FIG.axis,
    plot: { x0, x1, y0, y1 },
    ticks: f.ticks.map((t) => ({ x: x0 + t * unit, text: String(t) })),
    rows: f.rows.map((r, i) => {
      let x = x0
      const segments = (['pass', 'fail', 'unknown'] as const).filter((k) => r[k] > 0).map((k) => {
        const s = { x, w: r[k] * unit, n: r[k], kind: k }
        x += s.w
        return s
      })
      const total = r.pass + r.fail + r.unknown
      return {
        label: `Scenario ${r.label}`, y: y0 + i * FIG.row + (FIG.row - FIG.bar) / 2, segments,
        note: r.assessed ? `${r.pass} of ${total} met` : 'Not assessed',
      }
    }),
  }
}

/**
 * Text for the PDF's built-in fonts (WinAnsi). Characters they cannot draw are written out instead of being dropped
 * or shown as boxes: "≤ 100 h" becomes "max 100 h", "≥ 50%" becomes "min 50%", "→" becomes "to".
 */
export function pdfText(s: string): string {
  return s
    .replace(/≤\s?/g, 'max ').replace(/≥\s?/g, 'min ')
    .replace(/\s?→\s?/g, ' to ').replace(/−/g, '-').replace(/[‐‑‒]/g, '-')
    .replace(/[^\x20-\x7E -ÿ–—‘’“”•…€™\n]/g, '')
}

export const reportFileName = (card: Pick<ReportCard, 'snapshot_id'>) => `lunar-mission-report-${card.snapshot_id}.pdf`
