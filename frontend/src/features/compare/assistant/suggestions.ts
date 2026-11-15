// Suggested questions, chosen from the comparison on screen: they name the scenario that failed, the one that is
// UNKNOWN, the recommended one, the Mission Report, and the Mission Rescue import when there is one. With nothing
// selected, the
// getting-started and navigation questions come first.
import type { AssistantContext } from './context'

const GETTING_STARTED = [
  'How do I select scenarios to compare?',
  'How do I add another scenario?',
  'How do I compare different landing dates?',
  'How do I compare a rescued mission with the original?',
  'What does UNKNOWN mean?',
  'How do I restart the tutorial?',
]

export function suggestedQuestions(c: AssistantContext, max = 6): string[] {
  if (c.state === 'empty') return GETTING_STARTED.slice(0, max)
  const out: string[] = ['Summarize my current comparison.']
  // A generated report: offer it, and say when it no longer matches the comparison on screen.
  if (c.report) out.push(...(c.report.out_of_date ? ['What changed since my report was generated?'] : ['Summarize my report.', 'Explain the final assessment in my report.']))
  else if (c.state === 'ready') out.push('How do I generate a mission report?')
  if (c.rescue) out.push('How does the rescued mission differ from my original plan?')
  const rec = c.scenarios.find((s) => s.recommended)
  const failed = c.scenarios.find((s) => s.eligibility === 'fail')
  const unknown = c.scenarios.find((s) => s.eligibility === 'unknown')
  if (c.state === 'ready' && rec) out.push(`Why is Scenario ${rec.label} recommended?`)
  else if (c.state === 'ready') out.push('Which mission is more suitable?')
  if (failed) out.push(`Why did Scenario ${failed.label} fail?`)
  if (unknown) out.push(`Why is Scenario ${unknown.label} UNKNOWN?`)
  if (c.ranking_groups.length > 1) out.push('Why are some scenarios ranked separately?')
  out.push('Explain the biggest trade-off.', 'Where can I see the longest blackout?', 'How do I compare another landing date?')
  return [...new Set(out)].slice(0, max)
}
