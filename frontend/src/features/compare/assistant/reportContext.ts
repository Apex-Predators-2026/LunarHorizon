// The Mission Report as the assistant sees it: a compact view of the report snapshot the user generated (report.ts),
// never a fresh recomputation. The report is frozen at generation time, so the assistant is told whether the live
// comparison has changed since ("out_of_date"); it must then present the report as the earlier snapshot.
import type { ReportSnapshot } from '../report'

/** Sections of the report document, in order, with what each one shows (ReportPreview.tsx). */
export const REPORT_SECTION_GUIDE = [
  { title: 'Decision', contains: 'The recommendation for each comparable group, or why there is none, with the main evidence.' },
  { title: 'Plans evaluated', contains: 'Every plan with its site, mission window, verdict, rank and deciding requirement.' },
  { title: 'Declared requirements', contains: 'The mission requirements (thresholds) the plans were judged against.' },
  { title: 'Decisive differences', contains: 'Side-by-side key figures: direct sunlight, mean visible solar disk, Earth in line of sight, longest power darkness, longest without direct sunlight, longest communication blackout, with each requirement verdict and limit.' },
  { title: 'Main uncertainty', contains: 'The single most important limit on what the evidence can establish.' },
  { title: 'Scenario configuration and results', contains: 'Per plan: site and coordinates, requested and evaluated mission window, verdict, rank, score, data source and coverage, spacecraft, and a table of every requirement with limit, measured value, margin and verdict.' },
  { title: 'Changes against the baseline', contains: 'The decisive figures of each plan as a change from the baseline plan (better or worse).' },
  { title: 'Ranking method and comparability', contains: 'How plans are grouped and ranked: only PASS plans, only within a comparable group.' },
  { title: 'Pairwise evidence behind the order', contains: 'For each pair of ranked plans, the deciding criterion and score difference.' },
  { title: 'Measured trade-offs', contains: 'What each plan does better than the others, metric by metric.' },
  { title: 'Uncertainty', contains: 'What the evidence cannot establish (bounded values, undecided requirements).' },
  { title: 'User preference weights', contains: 'Any weights set in the trade-off panel (presentation only; they never change verdicts or ranks).' },
  { title: 'Sources and data coverage', contains: 'NASA JPL Horizons and LOLA data used, dataset ids and coverage.' },
  { title: 'Assumptions and limitations', contains: 'Modelling assumptions and known limitations.' },
  { title: 'Reproducing this report', contains: 'Snapshot id, versions and inputs needed to reproduce the results.' },
] as const

/** Section headings of the report document, in order. */
export const REPORT_SECTIONS = REPORT_SECTION_GUIDE.map((s) => s.title)

export interface AssistantReport {
  snapshot_id: string
  generated_at: string
  /** True when the scenarios, their inputs or their results changed after the report was generated. */
  out_of_date: boolean
  /** Whether the report preview is open on screen right now. */
  open: boolean
  scenarios: string[]
  plans: { label: string; role: string | null; site: string; verdict: string | null; status: string; rank: string; deciding_requirement: string | null }[]
  decisions: { group: string; label: string; recommended: string | null; headline: string; evidence: string[]; tradeoffs: string[]; uncertainty: string[] }[]
  decisive_differences: { row: string; values: Record<string, { text: string; status: string | null; limit: string | null }> }[]
  same_requirements: boolean
  comparability_note: string | null
  unassessed: { label: string; reason: string }[]
  main_uncertainty: string
  limitations: string[]
  /** The report's sections and what each shows, for "which section shows …" questions. */
  sections: readonly { title: string; contains: string }[]
}

export function reportForAssistant(s: ReportSnapshot | null, liveSelectionKey: string, open: boolean): AssistantReport | null {
  if (!s) return null
  return {
    snapshot_id: s.snapshot_id,
    generated_at: s.generated_at,
    out_of_date: liveSelectionKey !== s.selection.key,
    open,
    scenarios: s.selection.labels,
    plans: s.scenarios.map((p) => ({
      label: p.label, role: p.role, site: p.site, verdict: p.verdict, status: p.status_text, rank: p.rank, deciding_requirement: p.key,
    })),
    decisions: s.decisions.map((d) => ({
      group: d.id, label: d.label, recommended: d.recommended, headline: d.headline,
      evidence: d.evidence.slice(0, 3), tradeoffs: d.tradeoffs.slice(0, 4), uncertainty: d.uncertainty.slice(0, 3),
    })),
    decisive_differences: s.decisive.map((r) => ({
      row: r.label,
      values: Object.fromEntries(Object.entries(r.cells).map(([l, c]) => [l, { text: c.text, status: c.status, limit: c.limit }])),
    })),
    same_requirements: s.same_requirements,
    comparability_note: s.comparability_note,
    unassessed: s.unassessed,
    main_uncertainty: s.main_uncertainty,
    limitations: s.limitations.slice(0, 6),
    sections: REPORT_SECTION_GUIDE,
  }
}
