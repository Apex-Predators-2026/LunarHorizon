// Basic answers without AI, used when the AI service is unavailable. Every sentence is assembled from the
// comparison context (the page's own verdicts, decisions and display figures); nothing is inferred or worded
// freely, and the panel labels these answers "Basic answer · not AI".
import { fmtEvaluatedLength, fmtRequestedLength, fmtWhen } from '../missionTime'
import type { AssistantContext, AssistantMissionTime, AssistantScenario } from './context'
import { guideAnswer, guideFor } from './navigation'
import { basicReportAnswer, isReportQuestion } from './reportFallback'

/** The evaluated window (what the results describe); the request only when nothing was evaluated, named as such. */
const windowText = (t: AssistantMissionTime) =>
  t.evaluated_landing_utc && t.evaluated_duration_hours !== null
    ? `evaluated ${fmtWhen(t.evaluated_landing_utc)}, ${fmtEvaluatedLength(t.evaluated_duration_hours)}${t.adjusted ? ', adjusted to the hourly evaluation grid' : ''}`
    : `requested ${fmtWhen(t.requested_landing_utc)}, ${fmtRequestedLength(t.requested_duration_days)}, not evaluated yet`

const STATUS: Record<string, string> = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN' }
const status = (s: AssistantScenario) => (s.eligibility ? STATUS[s.eligibility] : s.result === 'loading' ? 'still loading' : 'not assessed')
const rank = (s: AssistantScenario) => (s.canonical_rank !== null ? `, rank ${s.canonical_rank}` : '')

const NOTHING_SELECTED = 'No scenarios are selected yet. In the **Scenario workspace** at the top of the page, tick two to four scenarios (or use **+ Add scenario**, or a quick comparison such as **Same date, 3 sites**). The comparison and my answers then use their results.'

function figureLines(c: AssistantContext, metrics: string[], block: 'Solar' | 'Earth'): string[] {
  const rows = c.at_a_glance.filter((r) => metrics.includes(r.metric)).map((r) => {
    const vals = c.selected.map((l) => `${l} ${r.values[l] ?? 'unavailable'}`).join(', ')
    const known = c.selected.filter((l) => /\d/.test(r.values[l] ?? '')).length
    const best = r.best.length ? ` (meaningfully best: ${r.best.join(', ')}; ${r.better} is better)`
      : known >= 2 ? ' (no meaningful difference)' : ''
    return `- **${r.metric}:** ${vals}${best}`
  })
  return [...rows, ...withheldLines(c, block)]
}

/** Why figures read "unavailable": the backend's own reason, one line per scenario and reason. */
function withheldLines(c: AssistantContext, block: 'Solar' | 'Earth'): string[] {
  return c.scenarios.flatMap((s) => s.figures_withheld.filter((w) => w.blocks.includes(block))
    .map((w) => `- Scenario ${s.label}: ${w.blocks.toLowerCase()} withheld, not zero. ${w.reason}`))
}

/** Each scenario's failed and undecided requirements, with measured value, threshold and margin from the page. */
function requirementLines(c: AssistantContext, s: AssistantScenario): string[] {
  const out: string[] = []
  for (const r of c.requirements) {
    const cell = r.by_scenario[s.label]
    if (!cell || cell === 'not assessed' || (cell.status !== 'fail' && cell.status !== 'unknown')) continue
    const req = cell.threshold ? `, required ${cell.threshold}` : ''
    const margin = cell.margin && cell.margin !== '-' && cell.margin !== '-' ? `, margin ${cell.margin}` : ''
    out.push(cell.status === 'fail'
      ? `  - Fails **${r.requirement}**: measured ${cell.measured}${req}${margin}`
      : `  - Cannot decide **${r.requirement}** (measured ${cell.measured}${req}): missing or uncertain data, not a failure`)
  }
  return out
}

function scenarioVerdict(c: AssistantContext, s: AssistantScenario): string[] {
  const head = `- **Scenario ${s.label}** (${s.site.name}): ${status(s)}${rank(s)}${s.recommended ? ', recommended' : ''}`
  if (s.eligibility === 'pass') return [head + (s.headroom ? `. ${s.headroom.verdict}` : '. Meets every applicable requirement.')]
  if (s.eligibility === 'unknown') return [head + ': not a failure; at least one requirement cannot be decided from the data.', ...requirementLines(c, s)]
  if (s.eligibility === 'fail') return [head, ...requirementLines(c, s)]
  return [head + (s.message ? `. ${s.message}` : '.')]
}

function stateNote(c: AssistantContext): string | null {
  if (c.state === 'loading') return 'Results are still loading, so this is incomplete and states no ranking.'
  if (c.state === 'updating') return 'The ranking is being recomputed, so this states no ranking or recommendation yet.'
  return null
}

/** The structured comparison summary (same sections the AI is asked to use), from the page's own results. */
export function basicSummary(c: AssistantContext): string {
  if (c.state === 'empty') return NOTHING_SELECTED
  const out: string[] = ['### Overall assessment']
  const note = stateNote(c)
  if (note) out.push(note)
  out.push(`Comparing ${c.scenarios.map((s) => `Scenario ${s.label} (${s.site.name}, ${windowText(s.mission_time)})`).join(', ')}.`)
  for (const d of c.decisions) out.push(d.headline)

  out.push('', '### Solar conditions', ...figureLines(c, [c.at_a_glance[0]?.metric, c.at_a_glance[1]?.metric], 'Solar'))
  out.push('', '### Communication', ...figureLines(c, [c.at_a_glance[2]?.metric, c.at_a_glance[3]?.metric], 'Earth'))
  out.push('', '### Mission requirements', ...c.scenarios.flatMap((s) => scenarioVerdict(c, s)))

  const tradeoffs = c.decisions.flatMap((d) => d.tradeoffs).filter(Boolean).slice(0, 3)
  out.push('', '### Main trade-off', ...(tradeoffs.length ? tradeoffs.map((t) => `- ${t}`) : ['- No meaningful measured trade-off between the compared scenarios.']))

  const uncertainty = c.decisions.flatMap((d) => d.uncertainty).slice(0, 2)
  out.push('', '### Conclusion')
  const rec = c.decisions.filter((d) => d.recommended).map((d) => `Scenario ${d.recommended}`)
  out.push(c.state !== 'ready' ? 'Wait for the results to finish updating before drawing a conclusion.'
    : rec.length ? `The page's assessment recommends ${rec.join(' and ')} under the selected requirements.`
      : 'The page makes no recommendation: no scenario is proven to meet every requirement.')
  if (uncertainty.length) out.push(...uncertainty.map((u) => `- ${u}`))
  return out.join('\n')
}

/** Requirements explanation for one scenario ("Why did C fail?"). */
export function basicRequirements(c: AssistantContext, label: string): string | null {
  const s = c.scenarios.find((x) => x.label === label)
  if (!s) return null
  const lines = scenarioVerdict(c, s)
  const note = stateNote(c)
  return [...(note ? [note] : []), ...lines.map((l) => l.replace(/^ {2}/, ''))].join('\n')
}

/** "How / where / what does … mean" questions about the page itself (not about a result). */
export const isNavigationQuestion = (q: string) =>
  /\b(how (do|can|to|should) (i|we|you)|where (can|do|is|are)|restart|what (does|do|is|are) .*\b(mean|means)\b|what is (an? |the )?(unknown|canonical|baseline|eligib))/i.test(q)

/** The Mission Rescue story, as the "from problem to decision" panel tells it. */
export function basicRescue(c: AssistantContext): string | null {
  const r = c.rescue
  if (!r) return null
  const s = (l: string | null) => (l ? c.scenarios.find((x) => x.label === l) : undefined)
  const out = ['### Mission Rescue', ...r.change.map((x) => `- ${x}`)]
  const orig = s(r.original), changed = s(r.changed)
  if (orig) out.push(`- **Original plan:** Scenario ${orig.label}, ${status(orig)}`)
  if (changed) {
    const p = r.changed_problems
    const probs = p ? [...p.failed.map((f) => `fails ${f}`), ...p.undecided.map((u) => `cannot decide ${u}`)] : []
    out.push(`- **Changed plan:** Scenario ${changed.label}, ${status(changed)}${probs.length ? ` (${probs.join('; ')})` : ''}`)
  }
  for (const a of r.alternatives) {
    const fixes = a.fixes.length ? ` Fixes: ${a.fixes.join(', ')}.` : ''
    const rem = a.remaining.length ? ` Still open: ${a.remaining.join(', ')}.` : ''
    const disagree = a.disagrees_with_rescue ? ` (Mission Rescue reported ${a.rescue_verdict?.toUpperCase()}; the re-assessment here differs.)` : ''
    out.push(`- **Alternative ${a.rescue_rank ?? ''} (Scenario ${a.label}):** ${a.outcome_text}.${fixes}${rem}${disagree}`.replace('Alternative  (', 'Alternative ('))
  }
  if (stateNote(c)) out.push(stateNote(c)!)
  return out.join('\n')
}

/** A basic answer to the user's question, or the summary when the question is not one it can answer exactly. */
export function basicAnswer(question: string, c: AssistantContext): string {
  // Questions about the report's content are answered from the report snapshot, never from the live comparison.
  if (isReportQuestion(question)) return basicReportAnswer(question, c.report ?? null)
  // Questions about using the page are answered from the interface guide, with or without a comparison.
  const guide = isNavigationQuestion(question) ? guideFor(question) : null
  if (guide) return guideAnswer(guide)
  if (c.state === 'empty') return NOTHING_SELECTED
  if (/rescu/i.test(question)) {
    const rescue = basicRescue(c)
    if (rescue) return rescue
    const g = guideFor('rescue')
    if (g) return `No Mission Rescue plans are in this comparison.\n${guideAnswer(g)}`
  }
  const letter = /\bscenario\s+([A-Z])\b/i.exec(question)?.[1]?.toUpperCase()
  if (/fail|violat|requirement|unknown|pass/i.test(question)) {
    if (letter && c.selected.includes(letter)) return basicRequirements(c, letter)!
    return ['### Mission requirements', ...(stateNote(c) ? [stateNote(c)!] : []), ...c.scenarios.flatMap((s) => scenarioVerdict(c, s))].join('\n')
  }
  return basicSummary(c)
}
