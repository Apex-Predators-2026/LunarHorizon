// Layout shared by the Mission Report preview (HTML) and its PDF: the pages and sections in order, the status
// colours (always paired with a text label), the headline chart data, and the text clean-up the PDF's built-in font
// needs. One definition, so the preview, the PDF and the Mission Assistant's section guide never disagree.
import type { CardValue, MetricRow, ReportCard, Status } from './reportCard'

export const SECTIONS = [
  { id: 'rc-summary', title: 'Executive summary', page: 1, contains: 'The plans compared, their assessment status, a summary of the results and the key findings.' },
  { id: 'rc-overview', title: 'Mission overview', page: 2, contains: 'Per plan: site and coordinates, landing time, mission duration, spacecraft, mission requirements, status, eligibility and canonical rank.' },
  { id: 'rc-performance', title: 'Mission performance', page: 3, contains: 'Headline chart, then solar performance (sunlight, mean visible solar disk, longest darkness, Sun clearance), communication performance (Earth in line of sight, longest communication blackout, Earth clearance) and mission viability tables.' },
  { id: 'rc-analysis', title: 'Comparison analysis', page: 4, contains: 'Which plan does better on sunlight, darkness, Earth visibility, communication blackout and requirements, and the measured trade-offs.' },
  { id: 'rc-requirements', title: 'Mission requirements assessment', page: 4, contains: 'Every configured requirement with each plan\'s PASS / FAIL / UNKNOWN, measured value, limit and margin, and why any requirement is UNKNOWN.' },
  { id: 'rc-strengths', title: 'Strengths and weaknesses', page: 5, contains: 'Per plan: requirements met, measured advantages, violated or undecided requirements and narrow margins.' },
  { id: 'rc-final', title: 'Final assessment and recommendation', page: 5, contains: 'Plans grouped as eligible PASS, FAIL, UNKNOWN or not assessed; the recommendation (or why there is none) with its evidence and uncertainty.' },
  { id: 'rc-sources', title: 'Data sources and methodology', page: 6, contains: 'NASA JPL Horizons and LOLA sources, datasets, data coverage per plan, assessment method, versions, main uncertainty and limitations.' },
  { id: 'rc-disclaimer', title: 'Disclaimer', page: 6, contains: 'What this report is and is not (a planning aid, not an official NASA mission approval).' },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']
export const PAGE_COUNT = Math.max(...SECTIONS.map((s) => s.page))
export const sectionNumber = (id: SectionId) => SECTIONS.findIndex((s) => s.id === id) + 1

/** Report colours: deep navy and white with a restrained cyan accent. */
export const COLORS = {
  navy: '#0b1f3a',
  navy2: '#1d3557',
  ink: '#111827',
  ink2: '#374151',
  ink3: '#6b7280',
  line: '#d7dde5',
  wash: '#f3f6fa',
  cyan: '#0e7490',
  cyanSoft: '#e0f2f6',
  bar: '#94a3b8',
} as const

/** Status colours, always shown together with the status word (never colour alone). */
export const STATUS_STYLE: Record<Status | 'NOT CONFIGURED', { fg: string; bg: string; border: string }> = {
  PASS: { fg: '#166534', bg: '#dcfce7', border: '#86efac' },
  FAIL: { fg: '#991b1b', bg: '#fee2e2', border: '#fca5a5' },
  UNKNOWN: { fg: '#92400e', bg: '#fef3c7', border: '#fcd34d' },
  'NOT ASSESSED': { fg: '#374151', bg: '#f3f4f6', border: '#d1d5db' },
  'NOT CONFIGURED': { fg: '#6b7280', bg: '#ffffff', border: '#e5e7eb' },
}

/** Eligibility shown beside the status: INELIGIBLE is distinguished from FAIL. */
export const ELIGIBILITY_SHORT = (e: string) => (e.startsWith('Eligible') ? 'ELIGIBLE' : e.startsWith('Ineligible') ? 'INELIGIBLE' : 'NOT ASSESSED')

export interface ChartBar {
  label: string
  value: CardValue
  /** Bar length as a share of the chart scale (0..1); null when there is no exact value (no bar is drawn). */
  share: number | null
  best: boolean
}

export interface Chart {
  title: string
  unit: string
  better: 'higher' | 'lower'
  bars: ChartBar[]
}

const CHART_ROWS: { table: 'solar' | 'communication'; id: string; title: string; unit: string }[] = [
  { table: 'solar', id: 'disk', title: 'Mean visible solar disk', unit: '%' },
  { table: 'solar', id: 'dark', title: 'Longest continuous power darkness', unit: 'h' },
  { table: 'communication', id: 'earth_share', title: 'Earth in line of sight', unit: '%' },
  { table: 'communication', id: 'blackout', title: 'Longest communication blackout', unit: 'h' },
]

/** The four headline measures as bar charts. Percentages on a 0-100 scale; hours on 0 to the largest known value. */
export function headlineCharts(card: ReportCard): Chart[] {
  return CHART_ROWS.map(({ table, id, title, unit }) => {
    const row = card.performance[table].find((r: MetricRow) => r.id === id)!
    const nums = card.labels.map((l) => row.values[l].num).filter((n): n is number => n !== undefined)
    const max = unit === '%' ? 100 : Math.max(1, ...nums)
    return {
      title, unit, better: row.better ?? 'higher',
      bars: card.labels.map((l) => {
        const v = row.values[l]
        return { label: l, value: v, share: v.num === undefined ? null : Math.max(0, Math.min(1, v.num / max)), best: row.best.includes(l) }
      }),
    }
  })
}

/**
 * Text for the PDF's built-in Helvetica (WinAnsi). Characters it cannot draw are written out instead of being
 * dropped or shown as boxes: "≤ 100 h" becomes "max 100 h", "≥ 50%" becomes "min 50%", "→" becomes "to".
 */
export function pdfText(s: string): string {
  return s
    .replace(/≤\s?/g, 'max ').replace(/≥\s?/g, 'min ')
    .replace(/\s?→\s?/g, ' to ').replace(/−/g, '-').replace(/[‐‑‒]/g, '-')
    .replace(/[^\x20-\x7E -ÿ–—‘’“”•…€™\n]/g, '')
}

export const reportFileName = (card: Pick<ReportCard, 'snapshot_id'>) => `lunar-mission-report-${card.snapshot_id}.pdf`
