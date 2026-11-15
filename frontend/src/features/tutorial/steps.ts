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
  { act: 2, label: 'Decide', title: 'Make the decision' },
  { act: 3, label: 'Trust', title: 'Trust the science, then try it' },
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
      `Ice hides in craters that never see sunlight, but a lander needs both sunlight and Earth in sight. This ${DAYS}-day landing in the Artemis III region is loaded from real NASA data.`,
    tryPrompt: 'The plan below: every requirement must hold for the whole mission.',
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
    title: 'Real LOLA terrain, real shadows',
    badge: 'NASA LOLA',
    whyItMatters:
      'The surface is NASA LOLA laser-altimeter elevation. Near the pole the Sun skims the horizon, so crater rims cast shadows kilometres long.',
    tryPrompt: 'Drag the Moon to orbit, or choose Sun under Camera position.',
    promptKind: 'try',
    targetSelectors: ['[data-tour="camera-menu"]', '[data-tour="top-down"]'],
    preferredPlacement: 'top',
    triggers: ['orbit-3d', 'camera-view', 'top-down'],
  },
  {
    id: 'timeline',
    act: 1,
    view: 'planner',
    title: 'Watch a lunar day pass',
    badge: 'Illumination',
    whyItMatters:
      'Move through time and the shadows sweep across the terrain as the Sun circles the horizon.',
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
    title: 'Time left before sunset and Earthset',
    badge: 'Countdown',
    whyItMatters:
      'Operators plan around these countdowns: the next sunset, and the next time Earth drops behind the terrain. At the pole the Sun stays within a few degrees of the horizon, so a small ridge decides power.',
    tryPrompt: "Next sunset, next Earthset, and the Sun's elevation against the terrain.",
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
      'The sky plot draws the terrain horizon against the Sun and Earth paths. Wherever a path dips below it, power or comms drop out.',
    tryPrompt: 'Open the Sky tab or toggle a blocker layer.',
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
    title: 'Checked against NASA JPL Horizons',
    badge: 'JPL Horizons',
    whyItMatters:
      'Sun and Earth positions come from NASA JPL Horizons. When online, Verify with JPL re-queries Horizons for this hour and compares it with an independent DE421 ephemeris.',
    tryPrompt: 'Click Verify with JPL.',
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
    whyItMatters: `The engine checks every requirement against the terrain and ephemerides across all ${DAYS} days.`,
    tryPrompt: 'The margins below: they are what a delay can eat into.',
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
    whyItMatters: `Same site and requirements, landing ${DELAY} days later. The engine re-checks the whole plan.`,
    tryPrompt: 'Each value below, before and after, against its limit.',
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
      'Near the pole Earth hangs low and bobs up and down each month (libration). The camera stands at the lander looking toward Earth; the band on the time strip marks how long it stays out of sight.',
    tryPrompt: 'Where Earth sits relative to the terrain horizon.',
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
      'Rescue searches other candidate sites and later dates for a plan that still meets every requirement. The engine then double-checks it.',
    tryPrompt: 'The recovery Rescue selected, and its margins below.',
    promptKind: 'look',
    targetSelectors: SIDEBAR,
    preferredPlacement: 'left',
    triggers: [],
    nextLabel: 'Compare the plans',
    prep: { sidebarOpen: true },
  },

  // Act 2 – Make the decision
  {
    id: 'compare',
    act: 2,
    view: 'compare',
    story: 'compare',
    title: 'Three plans, side by side',
    badge: 'Live result',
    whyItMatters:
      'The original, delayed and recovered plans are re-assessed together here. Saved plans stay synced with Mission Planner, and Manage plans adds quick presets.',
    tryPrompt: "Each plan's verdict and role below; use Manage plans to add or load presets.",
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
    whyItMatters: 'A PASS is not the whole story: headroom shows how close each plan runs to its limits.',
    tryPrompt: 'The plan with the most headroom.',
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
    title: 'One synchronized timeline',
    badge: 'Timeline',
    whyItMatters:
      'Sunlight, darkness and Earth visibility for every plan share one time axis. You can see exactly when each plan loses power or comms.',
    tryPrompt: 'When each plan has sunlight and can see Earth.',
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
      'The comparison recommends a plan and explains the evidence behind it, including what is still uncertain.',
    tryPrompt: 'Why the recommended plan wins, and what is uncertain.',
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
      'The recovery moved the landing to another site. Science wants to stay near shadowed ice, engineering wants sunlight and Earth in sight, and this search finds the best balance or what each side gives up.',
    tryPrompt: 'Find best compromise: say what science needs, then search.',
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
    title: 'A frozen Mission Report',
    badge: 'Live result',
    whyItMatters:
      'The decision is frozen into a report with every verdict, margin and data source. Save it as a PDF to share.',
    tryPrompt: 'Print / Save as PDF in the preview toolbar.',
    promptKind: 'look',
    targetSelectors: ['[data-testid="report-preview"]', '[data-tour="compare-report"]'],
    preferredPlacement: 'right',
    triggers: [],
  },

  // Act 3 – Trust the science
  {
    id: 'atlas',
    act: 3,
    view: 'atlas',
    title: 'Feasibility Atlas: when can you go?',
    badge: 'Atlas',
    whyItMatters:
      'Each cell is a landing date and mission length checked against the same requirements, so open launch windows stand out at a glance.',
    tryPrompt: 'Open launch windows; pick a cell to see that mission.',
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
      'Sun and Earth positions are checked against an independent DE421 ephemeris, and modelled sunlight against LROC orbital illumination maps. Known limitations are listed.',
    tryPrompt: 'Methods & sources and the limitations, one click away.',
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
      'A passing plan broke on a short delay, and the engine found a fix elsewhere. Now pick another site, or drop and remove custom pins from 80° S to the pole.',
    tryPrompt: 'Open Select site or press Drop pin, then press Play plan.',
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
