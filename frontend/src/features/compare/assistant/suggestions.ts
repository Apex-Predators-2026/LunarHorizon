// Suggested questions shown when the Mission Assistant opens. With no comparison loaded, the navigation questions
// come first (the spec: "if no comparison is loaded, prioritize navigation questions").
import type { ContextState } from './context'

const COMPARISON = [
  'Summarize my current comparison.',
  'Which mission is more suitable?',
  'Explain the biggest trade-off.',
  'Which requirements are being violated?',
]

const NAVIGATION = [
  'Where can I see the longest blackout?',
  'How do I compare another landing date?',
  'What does UNKNOWN mean?',
  'What does canonical rank mean?',
]

const GETTING_STARTED = [
  'How do I select scenarios to compare?',
  'How do I add another scenario?',
  'How do I compare different landing dates?',
  'How do I restart the tutorial?',
]

export function suggestedQuestions(state: ContextState): string[] {
  if (state === 'empty') return [...GETTING_STARTED, NAVIGATION[2]]
  return [...COMPARISON, ...NAVIGATION.slice(0, 2)]
}
