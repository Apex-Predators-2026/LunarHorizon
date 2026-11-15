import type { StageId } from '../guide/mission'
import { MISSION, originalScenario } from '../guide/missionDefinition'

export type TutorialActionKey =
  | 'site-select'
  | 'orbit-3d'
  | 'drop-pin'
  | 'camera-view'
  | 'top-down'
  | 'time-scrub'
  | 'time-play'
  | 'date-pick'
  | 'minimap-tab'
  | 'layer-toggle'
  | 'measure-arm'
  | 'measure-waypoint'
  | 'jpl-verify'
  | 'rescue-run'
  | 'rescue-tab'
  | 'compromise-run'
  | 'plan-create'
  | 'plan-play'
  | 'compare-open'

export type TutorialPlacement = 'left' | 'right' | 'top' | 'bottom' | 'auto'

export type TourView = 'planner' | 'compare' | 'atlas' | 'method'
export type TourAct = 1 | 2 | 3

export const TOUR_ACTS: { act: TourAct; label: string; title: string }[] = [
  { act: 1, label: 'Plan', title: 'Plan a south-pole landing' },
  { act: 2, label: 'Decide', title: 'Compare the options' },
  { act: 3, label: 'Explore', title: 'Check the data and explore' },
]

export interface TutorialStep {
  id: string
  act: TourAct
  view: TourView
  title: string
  badge: string
  /** One or two sentences. Story steps contain no measured values: live facts come from the story engine. */
  whyItMatters: string
  tryPrompt: string
  /** 'try' asks for an action (has triggers); 'look' asks for an observation (no triggers). */
  promptKind: 'try' | 'look'
  /** CSS selectors checked in order for the first visible target element. */
  targetSelectors: string[]
  /** Preferred side relative to the highlighted target. */
  preferredPlacement: TutorialPlacement
  /** Action keys that count as interactive completion for this step ([] on 'look' steps). */
  triggers: TutorialActionKey[]
  /** Story stage the tour enters on this step. */
  story?: StageId
  /** Comparison section id opened before targeting. */
  reveal?: string
  /** Defaults to true; false keeps the view fully visible. */
  scrim?: boolean
  /** 'left': the card docks at the left edge instead of next to the target (keeps the 3D view's centre clear). */
  dock?: 'left'
  /** Next button label on this step. */
  nextLabel?: string
  /** Optional UI preparation applied automatically when entering the step. */
  prep?: {
    sidebarOpen?: boolean
    showTimeBar?: boolean
    miniMapTab?: 'map' | 'sky'
  }
}

// Mission facts in the copy come from the versioned mission definition, never typed in by hand.
const SITE = originalScenario().site.name
const DAYS = originalScenario().duration_days
const DELAY = MISSION.disruption.launch_delay_days

// Planner story steps frame the whole sidebar card (its Rescue panel is too cramped to frame on its own); the live
// numbers themselves are on the tour card.
const SIDEBAR = ['[data-tour="sidebar-card"]', '[data-tour="mission-rescue"]']

export const TUTORIAL_STEPS: TutorialStep[] = [
  // Act 1 – Plan a south-pole landing
  {
    id: 'mission',
    act: 1,
    view: 'planner',
    story: 'mission',
    title: `Your mission: ${SITE}`,
    badge: 'Live result',
    whyItMatters:
      `Can this ${DAYS}-day mission get enough sunlight for power and keep Earth in view for communication?`,
    tryPrompt: 'The planned landing date and the mission’s limits.',
    promptKind: 'look',
    targetSelectors: SIDEBAR,
    preferredPlacement: 'left',
    triggers: [],
    prep: { sidebarOpen: true },
  },
  {
    id: 'terrain',
    act: 1,
    view: 'planner',
    title: 'Why the terrain matters',
    badge: 'NASA LOLA',
    whyItMatters:
      'NASA measured the terrain with its LOLA laser altimeter. Near the pole, even a low ridge can block the Sun.',
    tryPrompt: 'Drag the 3D view to look around the landing site.',
    promptKind: 'try',
    targetSelectors: ['[data-tour="camera-menu"]', '[data-tour="top-down"]'],
    preferredPlacement: 'top',
    triggers: ['orbit-3d', 'camera-view', 'top-down'],
  },
  {
    id: 'timeline',
    act: 1,
    view: 'planner',
    title: 'See how sunlight changes',
    badge: 'Illumination',
    whyItMatters:
      'Change the time to see when terrain shadows reach the landing site.',
    tryPrompt: 'Drag the time slider or press Play.',
    promptKind: 'try',
    targetSelectors: ['[data-tour="time-bar"]', '[data-tour="time-scrubber"]'],
    preferredPlacement: 'top',
    triggers: ['time-scrub', 'time-play', 'date-pick'],
    prep: { showTimeBar: true },
  },
  {
    id: 'countdown',
    act: 1,
    view: 'planner',
    title: 'When do the Sun and Earth rise or set?',
    badge: 'Countdown',
    whyItMatters:
      'The countdowns show when the Sun or Earth next comes into view or drops behind the terrain.',
    tryPrompt: 'The next rise or set for each body.',
    promptKind: 'look',
    targetSelectors: ['[data-tour="hud-readout"]'],
    preferredPlacement: 'right',
    triggers: [],
  },
  {
    id: 'sky',
    act: 1,
    view: 'planner',
    title: 'Where the horizon blocks the sky',
    badge: 'Horizon mask',
    whyItMatters:
      'The Sky plot shows the terrain horizon and the paths of the Sun and Earth. Below the horizon, terrain can block sunlight or direct contact with Earth.',
    tryPrompt: 'Switch between Map and Sky, or toggle a blocker layer.',
    promptKind: 'try',
    targetSelectors: ['[data-tour="minimap-panel"]', '[data-tour="map-layers"]'],
    preferredPlacement: 'left',
    triggers: ['minimap-tab', 'layer-toggle'],
    prep: { miniMapTab: 'sky' },
  },
  {
    id: 'jpl',
    act: 1,
    view: 'planner',
    title: 'Check the sky positions with NASA',
    badge: 'JPL Horizons',
    whyItMatters:
      'Verify with JPL makes a live NASA Horizons request to check the Sun and Earth positions for the selected hour.',
    tryPrompt: 'Select Verify with JPL while online.',
    promptKind: 'try',
    targetSelectors: ['[data-tour="jpl-verify"]'],
    preferredPlacement: 'top',
    triggers: ['jpl-verify'],
  },
  {
    id: 'original',
    act: 1,
    view: 'planner',
    story: 'original',
    title: 'Assess the original plan',
    badge: 'Live result',
    whyItMatters: 'The app checks the plan’s sunlight and Earth visibility against its limits.',
    tryPrompt: 'How much room the plan has before it reaches a limit.',
    promptKind: 'look',
    targetSelectors: SIDEBAR,
    preferredPlacement: 'left',
    triggers: [],
    nextLabel: `Apply a ${DELAY}-day delay`,
    prep: { sidebarOpen: true },
  },
  {
    id: 'delay',
    act: 1,
    view: 'planner',
    story: 'changed',
    title: `A ${DELAY}-day launch delay`,
    badge: 'Live result',
    whyItMatters: `Move the landing ${DELAY} days later to see how the conditions change at the same site.`,
    tryPrompt: 'Which requirement crosses its limit after the delay.',
    promptKind: 'look',
    targetSelectors: SIDEBAR,
    preferredPlacement: 'left',
    triggers: [],
    nextLabel: 'Show me why',
    prep: { sidebarOpen: true },
  },
  {
    id: 'evidence',
    act: 1,
    view: 'planner',
    story: 'evidence',
    scrim: false,
    dock: 'left',
    title: 'See why in 3D',
    badge: 'Live result',
    whyItMatters:
      'The camera looks toward Earth from the landing site. The shaded part of the timeline marks when Earth is out of sight.',
    tryPrompt: 'The terrain between the lander and Earth.',
    promptKind: 'look',
    targetSelectors: ['[data-tour="time-bar"]'],
    preferredPlacement: 'top',
    triggers: [],
    nextLabel: 'Find a recovery',
    prep: { showTimeBar: true },
  },
  {
    id: 'rescue',
    act: 1,
    view: 'planner',
    story: 'rescue',
    title: 'Search for a recovery',
    badge: 'Live result',
    whyItMatters:
      'Mission Rescue checks other sites and dates for a landing that meets the same limits.',
    tryPrompt: 'The suggested site and date.',
    promptKind: 'look',
    targetSelectors: SIDEBAR,
    preferredPlacement: 'left',
    triggers: [],
    nextLabel: 'Compare the plans',
    prep: { sidebarOpen: true },
  },

  // Act 2 – Compare the options
  {
    id: 'compare',
    act: 2,
    view: 'compare',
    story: 'compare',
    title: 'Three plans, side by side',
    badge: 'Live result',
    whyItMatters:
      'Compare the original plan, the delayed plan, and the recovery using the same limits.',
    tryPrompt: 'Which plans pass and which fail.',
    promptKind: 'look',
    targetSelectors: ['[data-tour="compare-select"]', '#cmp-scenarios'],
    preferredPlacement: 'bottom',
    triggers: [],
  },
  {
    id: 'headroom',
    act: 2,
    view: 'compare',
    reveal: 'cmp-overview',
    title: 'Comfortable or borderline?',
    badge: 'Headroom',
    whyItMatters: 'Headroom is the room left before a limit is reached. A plan can pass with very little room to spare.',
    tryPrompt: 'Which limit each passing plan comes closest to.',
    promptKind: 'look',
    targetSelectors: ['[data-tour="compare-verdict"]', '#cmp-overview'],
    preferredPlacement: 'bottom',
    triggers: [],
  },
  {
    id: 'sync',
    act: 2,
    view: 'compare',
    reveal: 'cmp-timeline',
    title: 'Compare conditions over time',
    badge: 'Timeline',
    whyItMatters:
      'The timeline lines up when each site has sunlight and when Earth is in view.',
    tryPrompt: 'The longest stretches of darkness or time with Earth out of view.',
    promptKind: 'look',
    targetSelectors: ['#cmp-timeline'],
    preferredPlacement: 'top',
    triggers: [],
  },
  {
    id: 'tradeoffs',
    act: 2,
    view: 'compare',
    reveal: 'cmp-summary',
    title: 'The decision and its trade-offs',
    badge: 'Decision',
    whyItMatters:
      'The comparison explains its recommendation and flags what the available data cannot tell you.',
    tryPrompt: 'What makes the recommended plan a better choice.',
    promptKind: 'look',
    targetSelectors: ['#cmp-summary', '[data-tour="compare-tradeoffs"]'],
    preferredPlacement: 'top',
    triggers: [],
  },
  {
    id: 'science',
    act: 2,
    view: 'compare',
    reveal: 'cmp-science',
    title: 'Science vs engineering',
    badge: 'Trade-off',
    whyItMatters:
      'A site close to a shadowed crater may be good for science and harder to operate from. The search compares science access with sunlight and Earth visibility.',
    tryPrompt: 'Select Find best compromise to compare the options.',
    promptKind: 'look',
    targetSelectors: ['#cmp-science'],
    preferredPlacement: 'top',
    triggers: [],
    nextLabel: 'Generate the report',
  },
  {
    id: 'report',
    act: 2,
    view: 'compare',
    story: 'report',
    scrim: false,
    title: 'Save the Mission Report',
    badge: 'Live result',
    whyItMatters:
      'The report captures the results, recommendation, and data sources for the plans you just compared.',
    tryPrompt: 'Select Print in the preview, then choose Save as PDF.',
    promptKind: 'look',
    targetSelectors: ['[data-testid="report-preview"]', '[data-tour="compare-report"]'],
    preferredPlacement: 'right',
    triggers: [],
  },

  // Act 3 – Check the data and explore
  {
    id: 'atlas',
    act: 3,
    view: 'atlas',
    title: 'Find a landing window',
    badge: 'Atlas',
    whyItMatters:
      'Each Atlas cell checks one landing date and mission length against the same limits.',
    tryPrompt: 'A passing cell. Select it to see the plan.',
    promptKind: 'look',
    targetSelectors: ['[data-tour="atlas-grid"]'],
    preferredPlacement: 'left',
    triggers: [],
  },
  {
    id: 'method',
    act: 3,
    view: 'method',
    title: 'Validation & Methodology',
    badge: 'Validation',
    whyItMatters:
      'We checked Sun and Earth positions against a second model (DE421) and compared predicted sunlight with NASA’s LROC maps.',
    tryPrompt: 'Where the checks agree and where the model has limits.',
    promptKind: 'look',
    targetSelectors: ['[data-tour="method-overview"]'],
    preferredPlacement: 'bottom',
    triggers: [],
  },
  {
    id: 'your-turn',
    act: 3,
    view: 'planner',
    title: 'Your turn',
    badge: 'Explore',
    whyItMatters:
      'Try a different landing site to see how sunlight and Earth visibility change.',
    tryPrompt: 'Use the site picker or select Drop pin.',
    promptKind: 'try',
    targetSelectors: ['[data-tour="site-select"]', '[data-tour="drop-pin"]'],
    preferredPlacement: 'top',
    triggers: ['site-select', 'drop-pin'],
    nextLabel: 'Explore on my own',
  },
]

export type TourPath = 'quick' | 'full'

/** The two routes through the same steps: a ~90 s story for busy judges, and the whole site. */
export const TOUR_PATHS: Record<TourPath, string[]> = {
  quick: ['mission', 'delay', 'evidence', 'rescue', 'compare', 'science', 'your-turn'],
  full: TUTORIAL_STEPS.map((s) => s.id),
}

/** The path's steps as indices into TUTORIAL_STEPS, in order. */
export function pathSteps(path: TourPath): number[] {
  return TOUR_PATHS[path].map((id) => TUTORIAL_STEPS.findIndex((s) => s.id === id)).filter((i) => i >= 0)
}

/** Index of the act's first step. */
export function actStart(act: TourAct): number {
  const i = TUTORIAL_STEPS.findIndex((s) => s.act === act)
  return i < 0 ? 0 : i
}
