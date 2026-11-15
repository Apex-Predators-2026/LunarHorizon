// Basic answers about the Mission Report when the AI is unavailable. Every line is taken from the report snapshot as
// the assistant receives it (reportContext.ts): its plans, decisions, decisive differences, trade-off sentences and
// uncertainty. Nothing is recomputed from the live comparison, and an out-of-date report always says so first.
import { fmtWhen } from '../missionTime'
import type { AssistantReport } from './reportContext'

const VERDICT: Record<string, string> = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN' }
const verdict = (v: string | null) => (v ? VERDICT[v] ?? v : 'not assessed')

export const NO_REPORT = 'No Mission Report has been generated yet. Click **Generate Mission Report** at the top of the page (it is available once every selected scenario has been assessed and ranked); the report then opens as a preview. [[go:report]]'

/** Questions about the report's content (not how to generate, open or download it: those are how-to questions). */
export const isReportQuestion = (q: string) =>
  /\breport\b/i.test(q) && !/\b(generate|create|make|download|pdf|print|save|open|reopen)\b|\bhow (do|can) (i|we)\b/i.test(q)

function status(r: AssistantReport): string[] {
  const when = `Generated ${fmtWhen(r.generated_at)} for Scenarios ${r.scenarios.join(', ')}.`
  return r.out_of_date
    ? [`**Out of date:** the scenarios or their results changed after this report was generated, so it describes the earlier comparison, not the one on screen. Generate a new report for the current comparison. ${when}`]
    : [`${when} It matches the comparison on screen.`]
}

const planLine = (p: AssistantReport['plans'][number]) =>
  `- **Scenario ${p.label}** (${p.site}): ${verdict(p.verdict)} · ${p.rank}${p.deciding_requirement ? ` · ${p.deciding_requirement}` : ''}`

function decisionLines(r: AssistantReport): string[] {
  if (!r.decisions.length) return ['- No plan has a canonical assessment, so none is judged and nothing is recommended.']
  return r.decisions.flatMap((d) => [
    `- **${d.label}**${d.recommended ? `: Scenario ${d.recommended}` : ''}${r.decisions.length > 1 ? ` (group ${d.group})` : ''}. ${d.headline}`,
    ...d.evidence.slice(0, 2).map((e) => `  - ${e}`),
  ])
}

function differenceLines(r: AssistantReport, only?: RegExp): string[] {
  return r.decisive_differences.filter((row) => !only || only.test(row.row)).map((row) => {
    const vals = r.scenarios.map((l) => {
      const c = row.values[l]
      return c ? `${l} ${c.text}${c.status ? ` (${verdict(c.status)}${c.limit ? `, limit ${c.limit}` : ''})` : ''}` : `${l} unavailable`
    })
    return `- **${row.row}:** ${vals.join('; ')}`
  })
}

const uncertaintyLines = (r: AssistantReport) =>
  [r.main_uncertainty, ...r.decisions.flatMap((d) => d.uncertainty)].filter(Boolean).slice(0, 3).map((u) => `- ${u}`)

/** Sentences of the report's trade-off text ("Scenario B has more sunlight (…). In return, Scenario C has …"). */
const sentences = (t: string) => t.split(/(?<=\.)\s+(?=[A-Z])/)

function strengthsWeaknesses(r: AssistantReport, label: string): string {
  const p = r.plans.find((x) => x.label === label)
  if (!p) return `The report does not include Scenario ${label}. It covers Scenarios ${r.scenarios.join(', ')}.`
  const strengths: string[] = []
  const weaknesses: string[] = []
  for (const row of r.decisive_differences) {
    const c = row.values[label]
    if (!c?.status) continue
    const limit = c.limit ? `, limit ${c.limit}` : ''
    if (c.status === 'pass') strengths.push(`**${row.row}**: meets the requirement (${c.text}${limit})`)
    if (c.status === 'fail') weaknesses.push(`**${row.row}**: fails the requirement (${c.text}${limit})`)
    if (c.status === 'unknown') weaknesses.push(`**${row.row}**: cannot be decided from the data (${c.text}${limit}); this is not a failure`)
  }
  // Measured advantages, as the report's trade-off sentences state them. ("… is at least as good on every metric"
  // is left out: the sentence does not name which plan it is compared with.)
  const own = new RegExp(`^(?:In return, )?Scenario ${label} has `)
  const other = /^(?:In return, )?Scenario ([A-Z]) has /
  for (const t of r.decisions.flatMap((d) => d.tradeoffs).filter((x) => x.includes(`Scenario ${label}`))) {
    for (const s of sentences(t)) {
      if (own.test(s)) strengths.push(s.replace(/^In return, /, ''))
      else if (other.test(s)) weaknesses.push(`Compared with it, ${s.replace(/^In return, /, '')}`)
    }
  }
  return [
    `### Scenario ${label}: ${verdict(p.verdict)}`,
    `${p.site} · ${p.rank}${p.deciding_requirement ? ` · ${p.deciding_requirement}` : ''}`,
    '', '**Strengths (from the report)**', ...(strengths.length ? [...new Set(strengths)].map((x) => `- ${x}`) : ['- The report lists no measured advantage for this plan.']),
    '', '**Weaknesses (from the report)**', ...(weaknesses.length ? [...new Set(weaknesses)].map((x) => `- ${x}`) : ['- The report lists no failed requirement or measured disadvantage for this plan.']),
  ].join('\n')
}

/** Report sections that show what the question asks about, by the topic words it uses. */
const SECTION_TOPICS: [RegExp, string[]][] = [
  [/strength|weakness|advantage|disadvantage/i, ['Strengths and weaknesses']],
  [/disclaimer|official|approval|guarantee/i, ['Disclaimer']],
  [/trade/i, ['Comparison analysis']],
  [/blackout|communication|comms|earth|line of sight|dark|sun|light|solar|power|figure|metric|measure|chart/i, ['Mission performance', 'Comparison analysis']],
  [/requirement|threshold|limit|constraint|margin|fail|violat/i, ['Mission requirements assessment', 'Mission overview']],
  [/decision|recommend|final|conclusion|verdict|winner|suitable/i, ['Final assessment and recommendation', 'Executive summary']],
  [/rank|order|group|compar/i, ['Final assessment and recommendation', 'Appendix: technical record']],
  [/uncertain|unknown|confidence|limitation|assumption/i, ['Mission requirements assessment', 'Data sources and methodology']],
  [/source|data|nasa|jpl|lola|horizons|coverage|dataset|method/i, ['Data sources and methodology']],
  [/baseline|change|weight|preference|pairwise/i, ['Appendix: technical record']],
  [/reproduc|version/i, ['Data sources and methodology', 'Appendix: technical record']],
  [/site|coordinate|location|date|window|duration|spacecraft|battery|panel/i, ['Mission overview']],
  [/summary|overview|finding/i, ['Executive summary']],
]

function sectionAnswer(r: AssistantReport, q: string): string {
  const topic = SECTION_TOPICS.find(([re]) => re.test(q.replace(/\b(report|section|which|where|show|shows)\b/gi, '')))
  const titles = topic ? topic[1] : []
  const found = r.sections.filter((s) => titles.includes(s.title))
  if (!found.length) return ['The report has these sections:', ...r.sections.map((s) => `- **${s.title}** (${s.where}): ${s.contains}`)].join('\n')
  return found.map((s, i) => `${i ? 'Also' : 'See'} the **${s.title}** section (${s.where}): ${s.contains}`).join('\n')
}

function unknownAnswer(r: AssistantReport): string {
  const unknown = r.plans.filter((p) => p.verdict === 'unknown')
  return [
    'In the report, **UNKNOWN** means the data cannot decide at least one requirement and none is violated: it is **not** a failure. An UNKNOWN plan is not ranked or recommended until it can be decided.',
    ...(unknown.length ? ['', 'UNKNOWN in this report:', ...unknown.map(planLine)] : ['', 'No plan in this report is UNKNOWN.']),
    ...(r.unassessed.length ? ['', 'Not assessed (no data):', ...r.unassessed.map((u) => `- Scenario ${u.label}: ${u.reason}`)] : []),
  ].join('\n')
}

/** A basic answer about the report, from the report snapshot only. */
export function basicReportAnswer(question: string, r: AssistantReport | null): string {
  if (!r) return NO_REPORT
  const head = status(r)
  const letter = /\bscenario\s+([A-Z])\b/i.exec(question)?.[1]?.toUpperCase()
  let body: string
  if (/\b(which|what|where)\b.*\bsection\b|\bsection\b.*\b(show|has|contain)/i.test(question)) body = sectionAnswer(r, question)
  else if (/\bunknown\b/i.test(question)) body = unknownAnswer(r)
  else if (letter && /strength|weakness|good|bad|pro|con|advantage|disadvantage/i.test(question)) body = strengthsWeaknesses(r, letter)
  else if (/communication|blackout|earth|comms/i.test(question)) {
    body = ['### Communication in the report', ...differenceLines(r, /earth|communication|blackout/i),
      '', 'Earth line of sight is geometric visibility, not a confirmed radio link.'].join('\n')
  } else if (/sun|solar|dark|power|light/i.test(question)) {
    body = ['### Solar conditions in the report', ...differenceLines(r, /sun|solar|dark|power/i)].join('\n')
  } else if (/final|assessment|decision|recommend|conclusion|why/i.test(question)) {
    body = ['### Final assessment', ...decisionLines(r), '', '### Plans', ...r.plans.map(planLine), '', '### Uncertainty', ...uncertaintyLines(r)].join('\n')
  } else {
    body = ['### Decision', ...decisionLines(r), '', '### Plans evaluated', ...r.plans.map(planLine),
      '', '### Decisive differences', ...differenceLines(r), '', '### Main uncertainty', ...uncertaintyLines(r)].join('\n')
  }
  return [...head, '', body, '', '[[go:report]]'].join('\n')
}
