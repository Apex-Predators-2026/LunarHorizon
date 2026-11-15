// Copy for the landing page. Every figure comes from the app, its data or docs/validation-engine.md;
// nothing is a placeholder. Keep it in sync if those change.

export const REPO_URL = 'https://github.com/Apex-Predators-2026/Nasa-Space-Apps-Challenge'

/** The hero headline, one entry per line: each line rises from behind its own mask on load. */
const HEADLINE_LINES = ['The right place on the Moon,', 'at the right time']

export const HERO = {
  headlineLines: HEADLINE_LINES,
  headline: HEADLINE_LINES.join(' '),
  lead: 'See when a south-pole landing site has sunlight and a radio line to Earth, on a 3D Moon built from NASA terrain and JPL Horizons data',
}

export interface Beat {
  id: string
  /** Short name for the step bar and the header. */
  short: string
  source: string
  title: string
  body: string
  facts: { label: string; value: string }[]
  /** Share of the scroll film this beat occupies. */
  start: number
  end: number
  /** The picture in the side rail that goes with this beat. */
  picture: string
}

/** The scroll film, start to end. Beat 0 is the hero; its copy is HERO. storyRender.ts draws each beat. */
export const BEATS: Beat[] = [
  {
    id: 'orbit', short: 'Orbit', source: '', title: HERO.headline, body: HERO.lead, facts: [],
    start: 0, end: 0.09, picture: 'planner',
  },
  {
    id: 'sites', short: 'Sites', source: 'Artemis III candidate regions',
    title: 'Eight south-pole sites, each with real data',
    body: 'Ridges near the pole see the Sun for most of the year, a few kilometres from craters that never do. The navigator holds hourly conditions for eight Artemis III candidates.',
    facts: [
      { label: 'Candidates', value: '8 sites' },
      { label: 'Period', value: '2026–2031' },
      { label: 'Sampling', value: 'Hourly' },
    ],
    start: 0.09, end: 0.18, picture: 'planner',
  },
  {
    id: 'terrain', short: 'Terrain', source: 'NASA Moon Trek · LRO LOLA',
    title: 'The ground, from laser altimetry',
    body: 'Elevation comes from the Lunar Orbiter Laser Altimeter in three tiers: fine near each site, coarser toward the far horizon, so a rim 200 km away still counts.',
    facts: [
      { label: 'Near', value: '5 m to 5 km' },
      { label: 'Middle', value: '30 m to 45 km' },
      { label: 'Far', value: '200 m to 300 km' },
    ],
    start: 0.18, end: 0.28, picture: 'planner',
  },
  {
    id: 'horizon', short: 'Horizon', source: 'Horizon engine',
    title: 'What the terrain hides',
    body: 'From each site, rays are traced through the terrain in every direction, with the Moon’s curvature, to find how high the horizon stands. That mask decides when the Sun and Earth are really in view.',
    facts: [
      { label: 'Directions', value: '720' },
      { label: 'Step', value: '0.5°' },
      { label: 'Curvature', value: 'Included' },
    ],
    start: 0.28, end: 0.38, picture: 'planner',
  },
  {
    id: 'sun', short: 'Sun', source: 'NASA JPL Horizons',
    title: 'The Sun skims the horizon',
    body: 'At the pole the Sun circles a degree or two above the horizon. Its position comes from JPL Horizons every hour, and it is treated as a 0.53° disk, so a half-hidden Sun gives half the light.',
    facts: [
      { label: 'Ephemeris', value: 'JPL Horizons' },
      { label: 'Sun model', value: '0.53° disk' },
      { label: 'Sampling', value: 'Hourly' },
    ],
    start: 0.38, end: 0.48, picture: 'sky',
  },
  {
    id: 'earth', short: 'Earth', source: 'NASA JPL Horizons',
    title: 'Earth, for talking home',
    body: 'Direct-to-Earth radio needs Earth above the local terrain. Earth hangs low at the pole and drifts with libration, so contact comes and goes over days.',
    facts: [
      { label: 'Link', value: 'Direct to Earth' },
      { label: 'Measured', value: 'Margin over terrain' },
      { label: 'Reported', value: 'Longest blackout' },
    ],
    start: 0.48, end: 0.58, picture: 'sky',
  },
  {
    id: 'verdict', short: 'Verdict', source: 'Viability engine',
    title: 'Pass or fail, and exactly why',
    body: 'Each plan is checked against its sunlight, darkness and Earth-contact requirements. A failing plan names the rule it breaks and by how much; a plan without real data is unknown, never guessed.',
    facts: [
      { label: 'Checks', value: 'Sun, dark, Earth' },
      { label: 'Outcomes', value: 'Pass, fail' },
      { label: 'No data', value: 'Unknown' },
    ],
    start: 0.58, end: 0.68, picture: 'compare',
  },
  {
    id: 'delay', short: 'Delay', source: 'Mission Rescue',
    title: 'The launch slips four days',
    body: 'Four days later the same site loses sight of Earth for days, and the communication blackout runs far past its limit. The plan that passed now fails.',
    facts: [
      { label: 'Change', value: '+4 days' },
      { label: 'Breaks', value: 'Earth contact' },
      { label: 'Verdict', value: 'Fails' },
    ],
    start: 0.68, end: 0.78, picture: 'rescue',
  },
  {
    id: 'rescue', short: 'Rescue', source: 'Mission Rescue & Optimization',
    title: 'Rescue finds the next good landing',
    body: 'It searches nearby dates and sites, ranks the ones that pass, checks how robust they are to another slip, and says what each alternative fixes and what it trades away.',
    facts: [
      { label: 'Searches', value: 'Dates and sites' },
      { label: 'Checks', value: 'Robustness' },
      { label: 'Trade-off', value: 'Science vs power' },
    ],
    start: 0.78, end: 0.9, picture: 'rescue',
  },
  {
    id: 'landed', short: 'Landed', source: 'Validation',
    title: 'Checked against data it never saw',
    body: 'Positions agree with an independent ephemeris, sunlight matches what orbiters photographed, and fifteen past landings come out the way they happened.',
    facts: [
      { label: 'Ephemeris', value: '0.0007°' },
      { label: 'LROC sunlight', value: 'r 0.66–0.88' },
      { label: 'Past landings', value: '15' },
    ],
    start: 0.9, end: 1, picture: 'rescue',
  },
]

/** Beats the header links to. */
export const NAV_BEATS = ['sites', 'terrain', 'sun', 'verdict', 'rescue']

export interface Picture {
  id: string
  title: string
  caption: string
  src: string
  alt: string
}

/** Real app screenshots shown in the feature carousel. */
export const PICTURES: Picture[] = [
  {
    id: 'planner',
    title: 'Mission Planner',
    caption: 'Explore lunar terrain in 3D and see where ridges block sunlight or the radio link to Earth.',
    src: '/landing/planner.jpg',
    alt: 'Three-dimensional lunar terrain in the Mission Planner',
  },
  {
    id: 'sky',
    title: 'Sky plot and timeline',
    caption: 'Scrub the timeline to see when the Sun or Earth drops below the local horizon.',
    src: '/landing/sky.jpg',
    alt: 'Polar sky plot and an hourly visibility timeline',
  },
  {
    id: 'compare',
    title: 'Plan Comparison',
    caption: 'Compare up to four plans side by side and see which meet your mission limits.',
    src: '/landing/compare.jpg',
    alt: 'Mission plans and their viability metrics shown side by side',
  },
  {
    id: 'rescue',
    title: 'Mission Rescue',
    caption: 'Find alternative dates or sites when a delay puts power or communications at risk.',
    src: '/landing/rescue.jpg',
    alt: 'Ranked recovery options in the Mission Rescue panel',
  },
]

export const DATA_SOURCES = [
  { name: 'NASA JPL Horizons', use: 'Sun and Earth topocentric positions (CENTER=coord@301)', url: 'https://ssd.jpl.nasa.gov/horizons/' },
  { name: 'NASA Moon Trek · LRO LOLA', use: 'South-pole elevation models and permanently shadowed regions', url: 'https://trek.nasa.gov/moon/' },
  { name: 'NASA LROC', use: 'WAC polar illumination maps used for validation', url: 'https://quickmap.lroc.asu.edu/' },
]
