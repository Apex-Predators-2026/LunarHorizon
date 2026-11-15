// The Scenario Comparison tour: five short stops on the real interface (~30-45 s). Separate from the Mission
// Planner's tour (features/tutorial), which it does not touch.
import type { TutorialPlacement } from '../../tutorial/steps'

export interface CompareTourStep {
  id: 'select' | 'viability' | 'conditions' | 'tradeoffs' | 'assistant'
  title: string
  body: string[]
  /** Selectors tried in order; the first visible match is highlighted. */
  targets: string[]
  placement: TutorialPlacement
  /** Shown only when its target exists (e.g. the assistant once it is on the page). */
  optional?: boolean
}

export const COMPARE_TOUR_STEPS: CompareTourStep[] = [
  {
    id: 'select',
    title: 'Select your missions',
    body: [
      'Choose two or more lunar mission plans to compare different landing sites, dates and mission configurations.',
      'Tick up to four plans. “Duplicate & shift date” and the quick comparisons create new plans in one click.',
    ],
    targets: ['[data-tour="compare-select"]', '#cmp-scenarios'],
    placement: 'bottom',
  },
  {
    id: 'viability',
    title: 'Understand mission viability',
    body: [
      'Each mission is checked against its requirements. PASS means every applicable requirement is met. FAIL means at least one is violated. UNKNOWN means the data cannot decide it: it is not a failure.',
      'Eligibility and ranking are separate: only plans that PASS are ranked, and only against plans with the same requirements and mission length.',
    ],
    targets: ['[data-tour="compare-verdict"]', '#cmp-overview'],
    placement: 'bottom',
  },
  {
    id: 'conditions',
    title: 'Compare the conditions',
    body: [
      'Compare sunlight, continuous darkness, Earth visibility and communication blackouts to see how the missions differ in operation.',
      'Watch the direction: more sunlight is better, but a longer darkness or blackout is worse. The icon shows whether each figure meets its requirement.',
    ],
    targets: ['[data-tour="compare-headlines"]', '#cmp-metrics'],
    placement: 'top',
  },
  {
    id: 'tradeoffs',
    title: 'Understand the trade-offs',
    body: [
      'Two missions can do better on different things. This panel explains which option is more suitable, the evidence behind it, and what is still uncertain.',
    ],
    targets: ['[data-tour="compare-decision"]', '#cmp-summary'],
    placement: 'top',
  },
  {
    id: 'assistant',
    title: 'Ask the Mission Assistant',
    body: [
      'Ask the assistant to summarise the results, explain why a mission performs better, or help you find your way around this page.',
    ],
    targets: ['[data-tour="compare-assistant"]'],
    placement: 'left',
    optional: true,
  },
]

/** Steps available on the page right now: an optional step is left out when its target is not rendered. */
export function availableSteps(find: (selectors: string[]) => Element | null): CompareTourStep[] {
  return COMPARE_TOUR_STEPS.filter((s) => !s.optional || find(s.targets) !== null)
}
