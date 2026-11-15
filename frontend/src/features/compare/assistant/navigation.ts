// How to use the Scenario Comparison page: a factual guide to controls that exist (checked against the components
// they name). It is sent to the AI as the only description of the interface, answers navigation questions when the
// AI is unavailable, and defines the "Go to" links an answer may contain.
import { COMPARE_SECTIONS } from '../sections'

/** Places an answer may link to: the page's sections, starting the guided tour, and opening the Mission Report. */
export type NavTarget = (typeof COMPARE_SECTIONS)[number][0] | 'tour' | 'report'

export const NAV_TARGETS: Record<NavTarget, string> = {
  ...(Object.fromEntries(COMPARE_SECTIONS.map(([id, label]) => [id, label])) as Record<(typeof COMPARE_SECTIONS)[number][0], string>),
  tour: 'Start the guided tour',
  report: 'Open the Mission Report',
}

/** Links that do something (shown with their own label) rather than go to a section ("Go to …"). */
export const ACTION_TARGETS: ReadonlySet<NavTarget> = new Set<NavTarget>(['tour', 'report'])

/** `[[go:cmp-metrics]]` in an answer becomes a button that scrolls to that section (unknown targets are dropped). */
export const NAV_TOKEN = /\[\[go:([a-z-]+)\]\]/g

export const isNavTarget = (id: string): id is NavTarget => Object.prototype.hasOwnProperty.call(NAV_TARGETS, id)

export interface GuideEntry {
  id: string
  /** Words that identify a question about this (used by the no-AI answers). */
  keywords: RegExp
  title: string
  steps: string[]
  go: NavTarget[]
}

export const INTERFACE_GUIDE: GuideEntry[] = [
  {
    id: 'select', title: 'Select plans to compare',
    keywords: /\b(select|choose|tick|pick)\b.*\b(?:plan|scenario)s?\b|\bstart (a )?comparison|\bcompare (two|2|more)/i,
    steps: [
      'In **Plans** (Plan workspace), tick the checkbox next to each saved plan: two to four can be compared at once.',
      'The counter on the right shows how many are compared; **clear** unticks them all.',
    ],
    go: ['cmp-scenarios'],
  },
  {
    id: 'add', title: 'Add another plan',
    keywords: /\b(add|new|create)\b.*\b(scenario|plan|mission)|\banother (scenario|plan|mission)/i,
    steps: [
      'In **Plans**, click **+ Add plan** to open **Mission Planner**. Use the **+** button on the map to create and save your plan.',
      'In Mission Planner, tick the saved plans you want and click **Compare** to open them here.',
      'To try a variation of a plan already in Plan Comparison, click **Duplicate** on its row.',
    ],
    go: ['cmp-scenarios'],
  },
  {
    id: 'remove', title: 'Remove or edit a plan',
    keywords: /\b(remove|delete|edit|change|modify)\b.*\b(scenario|plan|date|site|requirement)/i,
    steps: [
      'In **Plans**, each plan row has **Edit** (opens the editor: site, landing date, duration, requirements, solar panel), **Duplicate**, **Duplicate & shift date ▾**, **Set baseline** and **Remove**.',
      'Untick the checkbox to leave a plan out of the comparison without deleting it.',
    ],
    go: ['cmp-scenarios'],
  },
  {
    id: 'dates', title: 'Compare different landing dates',
    keywords: /\b(date|dates|delay|later|earlier|shift|launch slip)\b/i,
    steps: [
      'On a plan row in **Plans**, open **Duplicate & shift date ▾** and pick a shift, or enter a custom date and click **Add**: it creates a copy at the new date.',
      'Or click **Same site, 3 dates (14 d apart)** under **Quick comparisons** for a ready-made date comparison at Malapert Massif.',
      'Use **Align timelines by → Mission elapsed time** (top of the page) to line the missions up from their landing.',
    ],
    go: ['cmp-scenarios'],
  },
  {
    id: 'sites', title: 'Compare different landing sites',
    keywords: /\b(site|sites|location|locations|place)\b/i,
    steps: [
      'Click **Same date, 3 sites** under **Quick comparisons** in **Plans** (Peak Near Shackleton, Malapert Massif and Connecting Ridge on the same date).',
      'Or add a plan and choose another **Landing site** in its editor.',
    ],
    go: ['cmp-scenarios'],
  },
  {
    id: 'blackout', title: 'Find the longest communication blackout',
    keywords: /\b(blackout|communication|comms|earth (visibility|in line of sight)|line of sight)\b/i,
    steps: [
      '**At a glance** shows each plan\'s longest communication blackout next to its limit.',
      '**Key metrics** has the full Earth communication group (visibility, longest blackout, Earth elevation and margin).',
      'In **Timeline**, click **Go to longest blackout** to zoom the shared timeline to it.',
    ],
    go: ['cmp-overview', 'cmp-timeline'],
  },
  {
    id: 'darkness', title: 'Find the longest darkness',
    keywords: /\b(dark|darkness|night|sunlight|sun|illuminat|solar|power)\b/i,
    steps: [
      '**At a glance** shows sunlight and the longest continuous darkness for each plan.',
      '**Key metrics** lists all solar and power figures.',
      'In **Timeline**, click **Go to longest darkness** to zoom to it; **Whole mission** zooms back out.',
    ],
    go: ['cmp-overview', 'cmp-timeline'],
  },
  {
    id: 'requirements', title: 'See the mission requirements',
    keywords: /\b(requirement|requirements|constraint|constraints|threshold|limit|limits|violat)\b/i,
    steps: [
      '**Key metrics** starts with the requirements: each one with every plan\'s status, measured value and limit.',
      'Each plan card under **At a glance** lists its limits; change them with **Edit** on the plan in **Plans**.',
    ],
    go: ['cmp-metrics'],
  },
  {
    id: 'decision', title: 'See which mission is more suitable, and why',
    keywords: /\b(decision|recommend|suitable|best|winner|better|reasoning|why)\b/i,
    steps: [
      '**At a glance** gives the verdict; **Read the reasoning** jumps to **Decision**.',
      '**Decision** explains it in four parts: requirements, ranking evidence, measured trade-offs and uncertainty.',
      '**Ranking** shows the canonical ranking and the availability charts.',
    ],
    go: ['cmp-overview', 'cmp-summary'],
  },
  {
    id: 'rank', title: 'What canonical rank means',
    keywords: /\b(canonical|rank|ranking|ranked)\b/i,
    steps: [
      'Only plans that PASS every requirement are ranked, and only against plans with the same requirements, mission length and data basis (a ranking group).',
      'The rank is the assessment engine\'s official order from its evidence, not any single metric. FAIL and UNKNOWN plans get no rank.',
      'See it in **Ranking** and **Decision**.',
    ],
    go: ['cmp-performance', 'cmp-summary'],
  },
  {
    id: 'unknown', title: 'What UNKNOWN means',
    keywords: /\bunknown\b|\bundecided\b|cannot be decided/i,
    steps: [
      'UNKNOWN means the data cannot decide at least one requirement (for example the mission runs past the end of the stored NASA data) and none is violated.',
      'It is **not** a failure, but an UNKNOWN plan is not ranked or recommended until it can be decided.',
    ],
    go: ['cmp-metrics'],
  },
  {
    id: 'rescue', title: 'Compare a rescued mission with the original',
    keywords: /\b(rescue|rescued|alternative|alternatives|original plan|original)\b/i,
    steps: [
      'Run **Mission rescue** in the Mission Planner first.',
      'Back here, **Plans** shows "Mission Rescue has N alternatives…": click **Compare …** to bring in the original plan, the changed plan and the top alternatives (the changed plan becomes the baseline).',
      'Every plan is re-assessed here; **At a glance** then shows **Mission Rescue: from problem to decision**.',
    ],
    go: ['cmp-scenarios', 'cmp-overview'],
  },
  {
    id: 'baseline', title: 'Compare everything against one plan',
    keywords: /\bbaseline\b|\bbetter or worse than\b/i,
    steps: [
      'Click **Set baseline** on a ticked plan in **Plans**: **Key metrics** then shows how much every other plan improves or worsens on it.',
    ],
    go: ['cmp-scenarios', 'cmp-metrics'],
  },
  {
    id: 'export', title: 'Export the comparison',
    keywords: /\b(export|download|csv|json|save)\b/i,
    steps: ['In **At a glance**, under the decision summary, click **Export JSON** or **Export CSV** (available once every selected plan is assessed and ranked).'],
    go: ['cmp-overview'],
  },
  {
    id: 'report', title: 'Generate and preview the Mission Report',
    keywords: /\b(generate|create|make|open|see|view|preview|reopen|get)\b.*\breport\b|\b(mission|summary) report\b|\breport card\b/i,
    steps: [
      'Click **Generate Mission Report** at the top of the page (the same button is under the decision in **At a glance**). It is available once every selected plan has been assessed and ranked.',
      'The report opens as a document preview over the page: the bar at the top jumps between its sections and shows the page. **Close** returns to the comparison, and **Reopen last report** brings it back.',
      'It is a frozen snapshot of the comparison: if you change the plans afterwards it is marked out of date, and you can generate a new one.',
    ],
    go: ['report'],
  },
  {
    id: 'pdf', title: 'Download the report as a PDF',
    keywords: /\b(download|save|export|get|print)\b.*\bpdf\b|\bpdf\b|\bprint\b/i,
    steps: [
      'Generate the Mission Report (or click **Reopen last report**).',
      'In the preview, click **Download PDF**: the report is saved as a PDF file (lunar-mission-report-….pdf). **Print** is there too, for the browser print dialog.',
    ],
    go: ['report'],
  },
  {
    id: 'view3d', title: 'See the terrain in 3D',
    keywords: /\b(3d|three|terrain|horizon|view in)\b/i,
    steps: [
      '**Terrain** shows each site\'s terrain horizon with the Sun and Earth positions at the selected time.',
      'In **Timeline**, under "Conditions at the selected time", **View in 3D ↗** opens the 3D terrain view at that site and moment.',
    ],
    go: ['cmp-terrain', 'cmp-timeline'],
  },
  {
    id: 'tour', title: 'Restart the tutorial',
    keywords: /\b(tutorial|tour|walkthrough|guide|how does this page work|how to use)\b/i,
    steps: ['Click **How to compare plans** at the top of the page: the guided tour opens at Act 2, the comparison (it loads the example mission\'s three plans and selects them). In the Mission Planner, **More (⋮) → Quick tour** (about 90 seconds) or **Full guided tour** on the map toolbar starts it from the beginning.'],
    go: ['tour'],
  },
  {
    id: 'explain', title: 'Show explanations of the science',
    keywords: /\b(educational|explanation|explain the science|learn)\b/i,
    steps: ['Turn on **Educational mode** at the top of the page: short explanations appear under the panels.'],
    go: [],
  },
]

/** The best guide entry for a question, or null when none clearly matches. */
export function guideFor(question: string): GuideEntry | null {
  // More specific topics first: the order of INTERFACE_GUIDE goes from setup to concepts, so prefer the entry whose
  // keywords match, choosing the one with the longest matched text.
  let best: { e: GuideEntry; n: number } | null = null
  for (const e of INTERFACE_GUIDE) {
    const m = e.keywords.exec(question)
    if (m && (!best || m[0].length > best.n)) best = { e, n: m[0].length }
  }
  return best?.e ?? null
}

/** The guide as sent to the AI: compact, with the link tokens the answer may use. */
export function guideForAI(): { topic: string; steps: string[]; links: string[] }[] {
  return INTERFACE_GUIDE.map((e) => ({ topic: e.title, steps: e.steps, links: e.go.map((g) => `[[go:${g}]]`) }))
}

export function guideAnswer(e: GuideEntry): string {
  return [`**${e.title}**`, ...e.steps.map((s, i) => `${i + 1}. ${s}`), e.go.map((g) => `[[go:${g}]]`).join(' ')].filter(Boolean).join('\n')
}
