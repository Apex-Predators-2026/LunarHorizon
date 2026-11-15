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

export interface TutorialStep {
  id:
    | 'site-selection'
    | 'camera-views'
    | 'solar-timeline'
    | 'sky-obstructions'
    | 'traverse-measure'
    | 'jpl-verify'
    | 'viability-rescue'
    | 'plans-compare'
  title: string
  badge: string
  whyItMatters: string
  tryPrompt: string
  /** CSS selectors checked in order for the first visible target element. */
  targetSelectors: string[]
  /** Preferred side relative to the highlighted target. */
  preferredPlacement: TutorialPlacement
  /** Action keys that count as interactive completion for this step. */
  triggers: TutorialActionKey[]
  /** Optional UI preparation applied automatically when entering the step. */
  prep?: {
    appView?: 'planner' | 'compare'
    sidebarOpen?: boolean
    showTimeBar?: boolean
    miniMapTab?: 'map' | 'sky'
  }
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'site-selection',
    title: 'Mission & Site Selection',
    badge: 'Landing Target',
    whyItMatters:
      'Near the lunar south pole, elevated crater rims catch sunlight for days while nearby floors remain permanently frozen. Shifting a pin by 500 m can flip a mission from viable to shadowed.',
    tryPrompt: 'Choose an Artemis III candidate from the Site picker, drag to orbit the 3D Moon, or click Drop Pin.',
    targetSelectors: ['[data-tour="site-select"]', '[data-tour="drop-pin"]'],
    preferredPlacement: 'left',
    triggers: ['site-select', 'orbit-3d', 'drop-pin'],
    prep: { appView: 'planner', sidebarOpen: true },
  },
  {
    id: 'camera-views',
    title: 'Camera & Lander-Eye Views',
    badge: 'Perspective',
    whyItMatters:
      'Inspect terrain from orbit or drop to lander height (2 m) looking straight toward the Sun or Earth to see the exact crater ridge blocking sunlight or telemetry.',
    tryPrompt: 'Hover Camera Position to try Globe, Region, Site, Sun, or Earth view — or toggle Top-Down.',
    targetSelectors: ['[data-tour="camera-menu"]', '[data-tour="top-down"]'],
    preferredPlacement: 'top',
    triggers: ['camera-view', 'top-down'],
    prep: { appView: 'planner' },
  },
  {
    id: 'solar-timeline',
    title: 'Time & Solar Shadow Simulation',
    badge: 'Illumination',
    whyItMatters:
      'Because sunlight grazes almost horizontally at the south pole, dynamic 3D shadows sweep across hills over the 29.5-day lunar cycle, driving battery blackout limits.',
    tryPrompt: 'Drag the mango lunar-cycle slider, press Play, or pick a new date from the timeline.',
    targetSelectors: ['[data-tour="time-bar"]', '[data-tour="time-scrubber"]'],
    preferredPlacement: 'top',
    triggers: ['time-scrub', 'time-play', 'date-pick'],
    prep: { appView: 'planner', showTimeBar: true },
  },
  {
    id: 'sky-obstructions',
    title: 'Sky Plot & Terrain Obstructions',
    badge: 'Horizon Mask',
    whyItMatters:
      'The polar sky dome overlays the 360° terrain horizon curve against Sun and Earth trajectories — wherever a path dips behind the rim, power or direct-to-Earth comms drop out.',
    tryPrompt: 'Explore the polar Sky plot or toggle Sun/Earth terrain blocker lines under Map Layers.',
    targetSelectors: ['[data-tour="minimap-panel"]', '[data-tour="map-layers"]'],
    preferredPlacement: 'left',
    triggers: ['minimap-tab', 'layer-toggle'],
    prep: { appView: 'planner', miniMapTab: 'sky' },
  },
  {
    id: 'traverse-measure',
    title: 'Traverse, Slope & Relay LOS',
    badge: 'EVA / Rover',
    whyItMatters:
      'Safely routing rovers or astronauts near permanently shadowed ice requires checking terrain slope hazards and line-of-sight clearance to a 2 m lander communications mast.',
    tryPrompt: 'Click the Ruler tool to arm surface measurement and place elevation waypoints on the Moon.',
    targetSelectors: ['[data-tour="measure-tool"]'],
    preferredPlacement: 'top',
    triggers: ['measure-arm', 'measure-waypoint'],
    prep: { appView: 'planner', miniMapTab: 'map' },
  },
  {
    id: 'jpl-verify',
    title: 'Live NASA Ephemeris Verification',
    badge: 'JPL Horizons',
    whyItMatters:
      'Audit local DE421 solar and terrestrial angles on the spot against live NASA JPL Horizons topocentric ephemerides for sub-degree scientific transparency.',
    tryPrompt: 'Click Verify with JPL on the toolbar to run a live Sun/Earth azimuth and elevation check.',
    targetSelectors: ['[data-tour="jpl-verify"]'],
    preferredPlacement: 'top',
    triggers: ['jpl-verify'],
    prep: { appView: 'planner' },
  },
  {
    id: 'viability-rescue',
    title: 'Viability & Mission Rescue',
    badge: 'Optimization',
    whyItMatters:
      'When launch windows slip or power budgets tighten, Mission Rescue scans nearby terrain and alternate dates for a plan that still works.',
    tryPrompt: 'Tweak a requirement or a launch delay, then run Find Rescue.',
    targetSelectors: ['[data-tour="mission-rescue"]', '[data-tour="sidebar-card"]'],
    preferredPlacement: 'left',
    triggers: ['rescue-run'],
    prep: { appView: 'planner', sidebarOpen: true },
  },
  {
    id: 'plans-compare',
    title: 'Saved Plans & Scenario Compare',
    badge: 'Compare',
    whyItMatters:
      'Save landing options with the + FAB, play back real mission timelines with the Flag button, and benchmark up to 6 plans side-by-side in Scenario Comparison.',
    tryPrompt: 'Click the + FAB to create a plan, play a saved plan, or open Scenario Comparison.',
    targetSelectors: [
      '[data-tour="plan-fab"]',
      '[data-tour="plans-panel"]',
      '[data-tour="compare-dashboard"]',
      '[data-tour="nav-compare"]',
    ],
    preferredPlacement: 'left',
    triggers: ['plan-create', 'plan-play', 'compare-open'],
    prep: { appView: 'planner', sidebarOpen: true },
  },
]
