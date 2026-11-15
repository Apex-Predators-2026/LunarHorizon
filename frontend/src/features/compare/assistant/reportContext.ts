// The Mission Report as the assistant sees it: a compact view of the report snapshot the user generated (report.ts),
// never a fresh recomputation. The report is frozen at generation time, so the assistant is told whether the live
// comparison has changed since ("out_of_date"); it must then present the report as the earlier snapshot.
import type { ReportSnapshot } from '../report'
import { SECTIONS } from '../reportLayout'

/**
 * Sections of the Mission Report, in order, with what each one shows: the numbered report sections (the same list
 * the preview and the PDF are laid out from), then the technical appendix in the preview.
 */
export const REPORT_SECTION_GUIDE: readonly { title: string; where: string; contains: string }[] = [
  ...SECTIONS.map((s, i) => ({ title: s.title, where: `section ${i + 1}, page ${s.page}`, contains: s.contains })),
  { title: 'Appendix: technical record', where: 'preview only, after the report pages', contains: 'Ranking method and comparability, pairwise evidence behind the order, changes against the baseline, preference weights, and the snapshot details needed to reproduce the results.' },
]

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
  sections: readonly { title: string; where: string; contains: string }[]
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
