# Unified Guided Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the planner tutorial, the "Try a mission" card and the Comparison tour with one 17-step, 3-act guided
tour that runs the live mission story across `#app/planner`, `#app/compare`, `#app/atlas`, `#app/method`.

**Architecture:** `features/tutorial/` stays the one tour (steps + Zustand store + M3 coachmark). A new
`storyBridge.ts` drives the existing headless story engine (`features/guide/mission.ts`, `useGuide`) from the tour's
step changes and navigates views; the coachmark renders live `stageModel` facts on story steps. The dark `GuideCard`
and `features/compare/tour/` card are deleted; their entry points start the unified tour.

**Tech Stack:** React 19, TypeScript, Zustand 5, Tailwind 4, Vitest 5 (node environment, `renderToString`), oxlint.

**Spec:** `docs/superpowers/specs/2026-11-15-unified-guided-tour-design.md`

## Global Constraints

- No visual restyling: reuse the existing coachmark classes (`lp-light`, `bg-opal-50`, `border-opal-300`, `md-compact`,
  `bg-coral`, `InteractiveGrainGradient` strip). No new dependencies.
- Every mission number shown comes from the live stores via `stageModel(snapshot())`; static copy on story steps
  contains no measured values.
- Step copy: `whyItMatters` ≤ 2 sentences and ≤ 240 characters; `tryPrompt` ≤ 120 characters.
- Vitest runs in the node environment: no DOM. Navigation in testable code goes through `goTo()` from
  `features/guide/nav.ts` (store-backed; touches `window` only when it exists).
- Final gate in `frontend/`: `npx vitest run`, `npm run build`, `npm run lint` all with 0 errors.

## Review Focus

1. Jumping to Act 2 (tabs or dots) from a fresh tour: the story must catch up (mission → … → compare) instead of
   showing an empty comparison or a "Run the recovery first" error. → Task 3 test `catches up the story when jumping to Act 2`.
2. The report preview (z-index 80, `aria-modal`) left open when moving to Act 3 would cover the Atlas. → Task 3 test
   `leaving the report step closes the report preview`; Task 4 raises the tour layer to `z-[90]`.
3. Keyboard ArrowRight while a story step is still working must not skip past an unfinished result. → Task 2 test
   `ArrowRight is ignored while next is blocked`.
4. Skip / Esc mid-story must stop the story engine (no later navigation from a pending Rescue). → Task 3 test
   `skipping stops the story`.
5. Back from a story step to an earlier story step re-enters the earlier stage (delay removed when returning to
   "The plan passes"). → Task 3 test `Back re-enters the earlier story stage`.

---

### Task 1: Story engine can be driven by the tour

**Files:**
- Modify: `frontend/src/features/guide/mission.ts` (`GuideState`, `start`, `go`, remove the `useTutorialStore.subscribe` block at the end of the store section and the tutorial calls in `start`)
- Create: `frontend/src/features/guide/__fixtures__/mockApi.ts`
- Modify: `frontend/src/features/guide/guide.test.tsx`

**Interfaces:**
- Produces: `useGuide.getState().begin(): void` – `set({ ...initial, active: true, run: run + 1 })`, no navigation, no stage entry.
- Produces: `useGuide.getState().go(i: number): Promise<void>` – same behaviour as today, returns the stage-entry promise (resolves after the stage's ENTER settles, errors already caught into `error`).
- Produces: `start()` = `begin()` then `go(0)`; it no longer touches `useTutorialStore`. `mission.ts` no longer imports `useTutorialStore`.
- Produces (`mockApi.ts`): `resetMissionStores(): void`, `stubMissionFetch(): MissionApiControls` where `MissionApiControls = { setRescueBody(b: unknown): void; setRescueGate(p: Promise<void> | null): void; setFailRescue(v: boolean): void }`, `flush(n?: number): Promise<void>`, `viewerShows(): void`. Behaviour copied verbatim from the current top of `guide.test.tsx` (lines 34–87).

- [ ] **Step 1:** Move the fetch mock, store resets, `flush` and `viewerShows` from `guide.test.tsx` into `mockApi.ts`; `guide.test.tsx` imports them (its `beforeEach` calls `resetMissionStores()` and `stubMissionFetch()`).
- [ ] **Step 2:** In `guide.test.tsx` delete the tests `opening the feature tutorial stops the story…` and `the card renders progress…` (the card is retired in Task 4) and add:

```ts
it('begin() activates the story without entering a stage or navigating', () => {
  useNav.setState({ view: 'atlas' })
  useGuide.getState().begin()
  expect(useGuide.getState()).toMatchObject({ active: true, stage: 0, planId: null })
  expect(useNav.getState().view).toBe('atlas')
})
it('go() resolves once the stage has its live result', async () => {
  useGuide.getState().start()
  await flush()
  await useGuide.getState().go(stageIndex('original'))
  expect(model().status).toBe('ready')
})
```
- [ ] **Step 3:** Run `npx vitest run src/features/guide` – the two new tests fail.
- [ ] **Step 4:** Implement `begin`, make `go` return the promise, make `start` = begin + go(0), remove the tutorial coupling.
- [ ] **Step 5:** Run `npx vitest run src/features/guide` – all pass.
- [ ] **Step 6:** Commit `refactor(guide): let the guided tour drive the mission story`.

### Task 2: 17-step, 3-act tour definition and store

**Files:**
- Modify: `frontend/src/features/tutorial/steps.ts`, `frontend/src/features/tutorial/useTutorialStore.ts`, `frontend/src/features/tutorial/utils.ts`, `frontend/src/features/tutorial/index.ts`
- Modify: `frontend/src/features/tutorial/tutorial.test.tsx`

**Interfaces:**
- Produces in `steps.ts`:

```ts
export type TourView = 'planner' | 'compare' | 'atlas' | 'method'
export type TourAct = 1 | 2 | 3
export const TOUR_ACTS: { act: TourAct; label: string; title: string }[] = [
  { act: 1, label: 'Plan', title: 'Plan a south-pole landing' },
  { act: 2, label: 'Decide', title: 'Make the decision' },
  { act: 3, label: 'Trust', title: 'Trust the science' },
]
export interface TutorialStep {
  id: string            // ids below
  act: TourAct
  view: TourView
  title: string
  badge: string
  whyItMatters: string  // 1–2 sentences
  tryPrompt: string
  promptKind: 'try' | 'look'
  targetSelectors: string[]
  preferredPlacement: TutorialPlacement
  triggers: TutorialActionKey[]   // [] on 'look' steps
  story?: StageId                 // from '../guide/mission' (type-only import)
  reveal?: string                 // comparison section id opened before targeting
  scrim?: boolean                 // default true; false keeps the view fully visible
  nextLabel?: string              // Next button label on this step
  prep?: { sidebarOpen?: boolean; showTimeBar?: boolean; miniMapTab?: 'map' | 'sky' }
}
export function actStart(act: TourAct): number   // index of the act's first step
```
`TutorialActionKey` is unchanged (callers elsewhere still record those keys).
- Produces in the store: `goToAct(act: TourAct): void` (= `goToStep(actStart(act))`), `nextBlocked: boolean` (initial `false`, reset to `false` on every step change), `setNextBlocked(b: boolean): void`.
- `handleTutorialKeyDown`: `ArrowRight` returns `false` and does nothing while `nextBlocked`.

The steps (exact copy; `story` steps use `promptKind: 'look'`, `triggers: []`, `badge: 'Live result'`):

| # | id | act | view | story / reveal / scrim | targetSelectors | placement | title | whyItMatters | prompt (kind) | triggers | nextLabel | prep |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | mission | 1 | planner | story `mission` | `[data-tour="mission-rescue"]`, `[data-tour="sidebar-card"]` | left | Your mission: Peak Near Shackleton | A 14-day landing in the Artemis III region at the lunar south pole, loaded from real NASA data. Can it keep both sunlight and a direct link to Earth? | Read the plan and its requirements in the panel. (look) | – | – | sidebarOpen |
| 2 | terrain | 1 | planner | – | `[data-tour="camera-menu"]`, `[data-tour="top-down"]` | top | Real LOLA terrain, real shadows | The surface is NASA LOLA laser-altimeter elevation. Near the pole the Sun skims the horizon, so crater rims cast shadows kilometres long. | Drag the Moon to orbit, or choose Sun view under Camera Position. (try) | orbit-3d, camera-view, top-down | – | – |
| 3 | timeline | 1 | planner | – | `[data-tour="time-bar"]`, `[data-tour="time-scrubber"]` | top | Watch a lunar day pass | Move through time and the shadows sweep across the terrain as the Sun circles the horizon. | Drag the time slider or press Play. (try) | time-scrub, time-play, date-pick | – | showTimeBar |
| 4 | sky | 1 | planner | – | `[data-tour="minimap-panel"]`, `[data-tour="map-layers"]` | left | Where the horizon blocks the sky | The sky plot draws the terrain horizon against the Sun and Earth paths. Wherever a path dips below it, power or comms drop out. | Open the Sky tab or toggle a blocker layer. (try) | minimap-tab, layer-toggle | – | miniMapTab 'sky' |
| 5 | jpl | 1 | planner | – | `[data-tour="jpl-verify"]` | top | Checked against NASA JPL Horizons | Sun and Earth positions are computed locally, then cross-checked live against NASA JPL Horizons ephemerides. | Click Verify with JPL. (try) | jpl-verify | – | – |
| 6 | original | 1 | planner | story `original` | `[data-tour="mission-rescue"]`, `[data-tour="sidebar-card"]` | left | The plan passes | The engine checks every requirement against the terrain and ephemerides across all 14 days. | Note the margins: they are what a delay can eat into. (look) | – | Apply a 4-day delay | sidebarOpen |
| 7 | delay | 1 | planner | story `changed` | same as 6 | left | A 4-day launch delay | Same site and requirements, landing 4 days later. The engine re-checks the whole plan. | Compare each value before and after against its limit. (look) | – | Show me why | sidebarOpen |
| 8 | evidence | 1 | planner | story `evidence`, scrim false | `[data-tour="time-bar"]` | top | See why in 3D | The camera stands at the lander and looks toward Earth when the link is lost. The band on the time strip marks how long the blackout lasts. | Look for Earth below the terrain horizon. (look) | – | Find a recovery | showTimeBar |
| 9 | rescue | 1 | planner | story `rescue` | same as 6 | left | Mission Rescue finds a fix | Rescue searches nearby sites and later dates for a plan that still meets every requirement. The engine then double-checks it. | See which recovery Rescue selected. (look) | – | Compare the plans | sidebarOpen |
| 10 | compare | 2 | compare | story `compare` | `[data-tour="compare-select"]`, `#cmp-scenarios` | bottom | Three plans, side by side | The original, delayed and recovered plans are re-assessed together under the same requirements. | Check each plan's verdict. (look) | – | – | – |
| 11 | headroom | 2 | compare | reveal `cmp-overview` | `[data-tour="compare-verdict"]`, `#cmp-overview` | bottom | Comfortable or borderline? | A PASS is not the whole story: headroom shows how close each plan runs to its limits. | Find the plan with the most headroom. (look) | – | – | – |
| 12 | sync | 2 | compare | reveal `cmp-timeline` | `#cmp-timeline` | top | One synchronized timeline | Sunlight, darkness and Earth visibility for every plan share one time axis. You can see exactly when each plan loses power or comms. | Find where the delayed plan's Earth blackout begins. (look) | – | – | – |
| 13 | tradeoffs | 2 | compare | reveal `cmp-summary` | `[data-tour="compare-tradeoffs"]`, `#cmp-summary` | top | The decision and its trade-offs | The comparison recommends a plan and explains the evidence behind it, including what is still uncertain. | Read why the recommended plan wins. (look) | – | Generate the report | – |
| 14 | report | 2 | compare | story `report`, scrim false | `[data-testid="report-preview"]`, `[data-tour="compare-report"]` | right | A frozen Mission Report | The decision is frozen into a report with every verdict, margin and data source. Save it as a PDF to share. | Scroll the preview, or use Print / Save as PDF. (look) | – | – | – |
| 15 | assistant | 2 | compare | – | `[data-tour="compare-assistant"]` | left | Ask the Mission Assistant | Ask in plain English why one plan beats another, or where to find something on the page. | Open the assistant from its corner button any time. (look) | – | – | – |
| 16 | atlas | 3 | atlas | – | `[data-tour="atlas-grid"]` | left | Feasibility Atlas: when can you go? | Each cell is a landing date and mission length checked against the same requirements, so open launch windows stand out at a glance. | Pick a cell to see that mission. (look) | – | – | – |
| 17 | method | 3 | method | – | `[data-tour="method-overview"]` | bottom | Validation & Methodology | Results are cross-checked against JPL Horizons, LROC WAC_POLE_ILL_TWI_SOUTH sunlight maps and Gracy & Lee (LPSC 2024). Every limitation is stated openly. | Open Sources or the limitations to dig deeper. (look) | – | – | – |

- [ ] **Step 1: Rewrite `tutorial.test.tsx` expectations** (keep the persistence, `?tour=1`, auto-advance, keyboard, coachmark-position tests; update ids/counts):

```ts
it('defines 17 steps in 3 acts covering all four views', () => {
  expect(TUTORIAL_STEPS).toHaveLength(17)
  expect(TUTORIAL_STEPS.map((s) => s.act)).toEqual([1,1,1,1,1,1,1,1,1,2,2,2,2,2,2,3,3])
  expect(new Set(TUTORIAL_STEPS.map((s) => s.view))).toEqual(new Set(['planner','compare','atlas','method']))
  expect(TUTORIAL_STEPS.filter((s) => s.story).map((s) => s.story)).toEqual(['mission','original','changed','evidence','rescue','compare','report'])
})
it('keeps every step concise', () => {
  for (const s of TUTORIAL_STEPS) {
    expect((s.whyItMatters.match(/[.!?](\s|$)/g) ?? []).length).toBeLessThanOrEqual(2)
    expect(s.whyItMatters.length).toBeLessThanOrEqual(240)
    expect(s.tryPrompt.length).toBeLessThanOrEqual(120)
    expect(s.promptKind === 'try' ? s.triggers.length > 0 : s.triggers.length === 0).toBe(true)
  }
})
it('goToAct jumps to the first step of each act', () => {
  useTutorialStore.getState().startTour(0)
  useTutorialStore.getState().goToAct(2); expect(TUTORIAL_STEPS[useTutorialStore.getState().stepIndex].id).toBe('compare')
  useTutorialStore.getState().goToAct(3); expect(TUTORIAL_STEPS[useTutorialStore.getState().stepIndex].id).toBe('atlas')
  expect(actStart(1)).toBe(0)
})
it('ArrowRight is ignored while next is blocked', () => {
  useTutorialStore.getState().startTour(0)
  useTutorialStore.getState().setNextBlocked(true)
  expect(handleTutorialKeyDown({ key: 'ArrowRight' })).toBe(false)
  expect(useTutorialStore.getState().stepIndex).toBe(0)
  useTutorialStore.getState().nextStep()
  expect(useTutorialStore.getState().nextBlocked).toBe(false)
})
```
The existing "progresses steps" test uses `goToStep(16)` for the last step. The existing coachmark render test is replaced in Task 4; in this task only change `'1 / 8'` → `'1 / 17'` and the title to `'Your mission: Peak Near Shackleton'`.
- [ ] **Step 2:** Run `npx vitest run src/features/tutorial` – the new tests fail.
- [ ] **Step 3:** Implement the types, the 17 steps, `actStart`, `goToAct`, `nextBlocked`/`setNextBlocked`, the keyboard rule; export `TOUR_ACTS`, `actStart`, `TourAct`, `TourView` from `index.ts`. Consumers of `prep.appView` (only `App.tsx`) switch to `step.view` in Task 4; keep `App.tsx` compiling by reading `TUTORIAL_STEPS[i]?.view` there now (one-line change, `goToView(view)` unchanged).
- [ ] **Step 4:** Run `npx vitest run src/features/tutorial` – pass.
- [ ] **Step 5:** Commit `feat(tour): 17-step three-act guided tour definition`.

### Task 3: Story bridge – the tour drives the story and the views

**Files:**
- Create: `frontend/src/features/tutorial/storyBridge.ts`
- Create: `frontend/src/features/tutorial/tour.test.tsx`

**Interfaces:**
- Consumes: Task 1 `begin`, `go(): Promise<void>`; Task 2 `TUTORIAL_STEPS`, `actStart`, `goToAct`; `goTo` (`guide/nav`), `stageIndex`, `STAGES`, `useGuide`, `stageModel`, `snapshot`, `showStoryEvidenceAgain` (`guide/mission`), `useReportStore` (`compare/report`).
- Produces:

```ts
export function requiredStage(stepIndex: number): StageId | null // last `story` at or before the step within acts 1–2; null in act 3
export function enterStoryStage(stage: StageId): Promise<void>   // catch-up runner (below)
export function installTourBridge(): () => void                  // subscribe; returns unsubscribe
export function useStoryModel(stage: StageId | undefined): { model: StageModel; catchingUp: boolean } | null
export function runStoryAction(a: StageModel['primary']['action'] | StageModel['secondary'][number]['action']): void
```
- `installTourBridge`: on every `prepNonce` change while `open`: `goTo(step.view)`; if the previous step had `story === 'report'` and this one does not, `useReportStore.getState().close()`; if `requiredStage(i)` is not null, `void enterStoryStage(requiredStage(i))` – except on a non-story step where the story already reached that stage (`active && stage >= stageIndex(required)`), which does nothing. On `open: true → false`: `useGuide.getState().exit()` when active.
- `enterStoryStage(stage)`: a module token cancels older runs. If `!active` → `begin()` and run `go(k)` for `k = 0..target` sequentially (await each). If active and `target <= stage + 1` → `await go(target)`. Otherwise run `go(k)` for `k = stage + 1..target`. Stop when the token changed or the tour closed.
- `useStoryModel(stage)`: subscribe to the same stores `GuideCard.useLiveModel` subscribes to today (copy that list), return `null` when `stage` is undefined; `catchingUp = !active || useGuide.stage !== stageIndex(stage)`.
- `runStoryAction`: `next`/`finish` → tour `nextStep()`; `retry` → `useGuide.retry()`; `view` → `useGuide.go(stage)`; `restart` → `useGuide.restart()` then `enterStoryStage(requiredStage(current step))`; `evidence` → `showStoryEvidenceAgain()`; `report` → `useReportStore.reopen()`; `section` → `document.getElementById('cmp-summary')?.scrollIntoView({ block: 'start' })` (guard `typeof document`).

- [ ] **Step 1: Write `tour.test.tsx`** using `mockApi.ts` (`beforeEach`: `resetMissionStores()`, `stubMissionFetch()`, `resetTutorialStoreForTests(memoryStorage)`, `useNav.setState({ view: 'planner' })`, `unsub = installTourBridge()`; `afterEach`: `useTutorialStore.getState().skipTour()`, `unsub()`, `vi.unstubAllGlobals()`). Helper `goToId(id)` = `goToStep(TUTORIAL_STEPS.findIndex(s => s.id === id))` followed by `await flush(12)` and `viewerShows()` when the id is `evidence`. Tests:

```ts
it('requiredStage maps spotlight steps to the story stage they sit on', () => {
  expect(requiredStage(1)).toBe('mission')          // terrain
  expect(requiredStage(11)).toBe('compare')         // sync
  expect(requiredStage(15)).toBeNull()              // atlas
})
it('starting the tour loads the mission on the planner', async () => {
  useTutorialStore.getState().startTour(0); await flush()
  expect(useGuide.getState()).toMatchObject({ active: true, stage: 0 })
  expect(useNav.getState().view).toBe('planner')
  expect(scenarioKey(useRescueStore.getState().original!)).toBe(scenarioKey(originalScenario()))
})
it('walks Act 1 into Act 2 with live results', async () => {
  useTutorialStore.getState().startTour(0); await flush()
  await goToId('delay')
  expect(stageModel(snapshot()).rows[0]).toMatchObject({ before: '22 h', after: '118 h', to: 'fail' })
  await goToId('evidence'); await goToId('rescue'); await flush(12)
  expect(useGuide.getState().recovery?.site.id).toBe('malapert-massif')
  await goToId('compare'); await useCompareStore.getState().refresh(); await flush()
  expect(useNav.getState().view).toBe('compare')
  expect(useGuide.getState().compareIds).toHaveLength(3)
})
it('catches up the story when jumping to Act 2', async () => {
  useTutorialStore.getState().startTour(0); await flush()
  useTutorialStore.getState().goToAct(2)
  for (let i = 0; i < 8; i++) { await flush(12); viewerShows() }
  expect(STAGES[useGuide.getState().stage].id).toBe('compare')
  expect(useNav.getState().view).toBe('compare')
})
it('Back re-enters the earlier story stage', async () => {
  useTutorialStore.getState().startTour(0); await flush()
  await goToId('delay')
  useTutorialStore.getState().prevStep(); await flush(12)
  expect(STAGES[useGuide.getState().stage].id).toBe('original')
  expect(useRescueStore.getState().change.launch_delay_days).toBe(0)
})
it('Act 3 visits the Atlas then Methodology', async () => {
  useTutorialStore.getState().startTour(0); await flush()
  useTutorialStore.getState().goToAct(3); await flush()
  expect(useNav.getState().view).toBe('atlas')
  useTutorialStore.getState().nextStep(); await flush()
  expect(useNav.getState().view).toBe('method')
})
it('leaving the report step closes the report preview', async () => {
  useTutorialStore.getState().startTour(0); await flush()
  useReportStore.setState({ open: true })
  useTutorialStore.getState().goToStep(TUTORIAL_STEPS.findIndex(s => s.id === 'report'))
  useReportStore.setState({ open: true })
  useTutorialStore.getState().nextStep(); await flush()
  expect(useReportStore.getState().open).toBe(false)
})
it('skipping stops the story', async () => {
  useTutorialStore.getState().startTour(0); await flush()
  useTutorialStore.getState().skipTour()
  expect(useGuide.getState().active).toBe(false)
})
```
- [ ] **Step 2:** Run `npx vitest run src/features/tutorial/tour.test.tsx` – fails (module missing).
- [ ] **Step 3:** Implement `storyBridge.ts` per the Interfaces block.
- [ ] **Step 4:** Run `npx vitest run src/features/tutorial src/features/guide` – pass.
- [ ] **Step 5:** Commit `feat(tour): bridge the guided tour to the live mission story`.

### Task 4: One coachmark, entry points, App wiring

**Files:**
- Modify: `frontend/src/features/tutorial/TutorialSpotlight.tsx`, `TutorialOfferChip.tsx`, `index.ts`
- Create: `frontend/src/features/tutorial/TourHeaderButton.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/viz/MapTools.tsx` (menu item ~line 594–607)
- Modify: `frontend/src/features/atlas/AtlasView.tsx:261` (add `data-tour="atlas-grid"`), `frontend/src/features/methodology/MethodologyView.tsx:291` (add `data-tour="method-overview"`)
- Delete: `frontend/src/features/guide/GuideCard.tsx`
- Test: `frontend/src/features/tutorial/tutorial.test.tsx` (render test)

**Interfaces:**
- Consumes: Task 2 step fields, `TOUR_ACTS`, `goToAct`, `setNextBlocked`; Task 3 `useStoryModel`, `runStoryAction`, `installTourBridge`.
- `TutorialSpotlightView` gains props `story?: { model: StageModel; catchingUp: boolean; slow: boolean } | null`, `onGoToAct: (act: TourAct) => void`, `onStoryAction: (a) => void`; loses `appView`, `onOpenCompare`, `onResetTourView` (and the two last-step convenience buttons).
- `TourHeaderButton(): JSX.Element` – same classes as the old `TryMissionButton`; label `Guided tour` (or `Restart tour` while open); `onClick` → `startTour(0)`; `data-tip`: `One real south-pole mission from landing site to decision, then the Atlas and the validation (3 acts, about 4 minutes)`.

Card rules (inside the existing card markup):
- Header row: act tabs replace nothing visually new – three `md-compact`-sized chips `1 Plan` / `2 Decide` / `3 Trust` (`role="tab"`, `aria-selected`, current act `bg-coral/15 text-coral`, others `border-opal-300 bg-opal-100 text-slate-300`) placed where the `n / total` chip is; the `n / 17` chip and badge move to the line under them. Skip (Esc) stays.
- Dots show only the current act's steps (still jump buttons).
- Prompt pill: `promptKind === 'look'` → lead `Look for: `; `try` → `Try it live: ` (unchanged).
- Story steps (`story` present): below the body, the live block replaces the prompt pill when `status !== 'ready'` or `catchingUp`:
  - catching up / working: coral pulsing dot + `Preparing the mission…` (catching up) or `Working on it…`; after 15 s `This is taking longer than usual.` + `Retry` (`runStoryAction('retry')`).
  - error / outdated / modified / elsewhere: amber/red pill with `model.lead`; button = `model.primary.label` when the action is `retry` / `restart` / `view`.
  - ready: up to 2 `model.rows` as `name: before → after (limit …)` then `model.facts` up to 3 total, in a `dl` with `text-emerald-300` / `text-red-300` tones on the opal card (match the existing pill tones `text-emerald-300`), then the look prompt pill; `model.secondary` as `md-compact` outline buttons.
  - `setNextBlocked(true)` while catching up or working; Next disabled with label `Working…`.
- Next label: `step.nextLabel ?? (isLast ? 'Finish' : 'Next')`.
- `scrim === false`: render no dim `rect` (ring still drawn when a target exists).
- Overlay root `z-[55]` → `z-[90]`, card `z-[56]` → `z-[91]` (above the report preview at 80).
- `TutorialSpotlight` effect: when `step.reveal`, first `useCompareView.getState().setTab(tabOfSection(step.reveal))` (if any) and `useReveal.getState().reveal(step.reveal)` (from `compare/sections`, `compare/disclosure`); for `step.view !== 'planner'` scroll the target with `scrollIntoView({ block: 'start' })` then its scrolling parent by −150 px (move `scrollParent` from `CompareTour.tsx` into `utils.ts`).

App wiring:
- `useEffect(() => installTourBridge(), [])` at the top of `App`; delete the `prepNonce` → `goToView` effect (the bridge navigates).
- Header: `<TourHeaderButton />` replaces `<TryMissionButton />`; remove `<GuideCard />` and the `guideActive` gate on the offer chip.
- `<TutorialSpotlight uiHidden={uiHidden && !pageView} />` (no view props).
- Landing: `<Landing onOpen={openNavigator} onTour={() => { openNavigator(); useTutorialStore.getState().startTour(0) }} />` (prop added in Task 5).
- Offer chip copy: title `Guided Tour`, text `Follow one real south-pole mission from landing site to decision, then see how it was validated. 3 acts, about 4 minutes.`, button `Start tour`.
- MapTools menu item: `data-tip="Guided Tour: one real mission across all four views"`, right label `3 acts`.

- [ ] **Step 1: Replace the render test** in `tutorial.test.tsx`:

```ts
it('renders act tabs, the live story block and a blocked Next while working', () => {
  const base = { stepIndex: 0, total: 17, actionDone: false, box: null, cardPos: { left: 0, top: 0 },
    onPrev() {}, onNext() {}, onSkip() {}, onGoToStep() {}, onGoToAct() {}, onStoryAction() {} }
  const ready = renderToString(<TutorialSpotlightView {...base} step={TUTORIAL_STEPS[0]}
    story={{ catchingUp: false, slow: false, model: { status: 'ready', lead: '', rows: [], note: null, secondary: [],
      facts: [{ label: 'Site', value: 'Peak Near Shackleton (89.02° S)' }], primary: { label: 'Next', action: 'next' } } }} />)
  expect(ready).toContain('Plan'); expect(ready).toContain('Decide'); expect(ready).toContain('Trust')
  expect(ready).toContain('Peak Near Shackleton (89.02° S)')
  expect(ready).toContain('1 / 17')
  const working = renderToString(<TutorialSpotlightView {...base} step={TUTORIAL_STEPS[0]}
    story={{ catchingUp: true, slow: false, model: { status: 'working', lead: '', rows: [], facts: [], note: null, secondary: [], primary: { label: 'Working…', action: 'next', disabled: true } } }} />)
  expect(working).toContain('Preparing the mission')
  expect(working).toMatch(/disabled=""[^>]*>Working…/)
  const look = renderToString(<TutorialSpotlightView {...base} stepIndex={15} step={TUTORIAL_STEPS[15]} story={null} />)
  expect(look).toContain('Look for:')
})
```
(The disabled-attribute regex may need adjusting to the final attribute order; assert the Next button is disabled and reads `Working…`.)
- [ ] **Step 2:** Run `npx vitest run src/features/tutorial` – fails.
- [ ] **Step 3:** Implement the card, spotlight reveal/scroll, header button, offer chip, MapTools copy, `data-tour` hooks, App wiring; delete `GuideCard.tsx`.
- [ ] **Step 4:** Run `npx vitest run src/features/tutorial src/features/guide` and `npx tsc -b` (from `frontend/`) – pass.
- [ ] **Step 5:** Commit `feat(tour): one coachmark for the whole site; header and menu start the unified tour`.

### Task 5: Retire the Comparison tour; Comparison, Assistant and Landing entry points

**Files:**
- Delete: `frontend/src/features/compare/tour/CompareTour.tsx`, `steps.ts`, `useCompareTour.ts`, `tour.test.tsx`
- Modify: `frontend/src/features/compare/tour/TourButton.tsx` (keep `TourButton`, delete `TourOffer`)
- Modify: `frontend/src/features/compare/ComparisonDashboard.tsx` (remove `<TourOffer />` ~line 201, `<CompareTour />` ~line 308 and their imports)
- Modify: `frontend/src/features/compare/assistant/MissionAssistant.tsx:18,111`, `frontend/src/features/compare/assistant/navigation.ts:191-194`
- Modify: `frontend/src/features/landing/Landing.tsx` (`Landing`, `Hero`, `Close` get `onTour?: () => void`)
- Test: `frontend/src/features/compare/assistant/assistant.test.tsx`, `frontend/src/features/landing/landing.test.tsx`

**Interfaces:**
- Consumes: Task 2 `actStart(2)` and `useTutorialStore.startTour(index)`.
- `TourButton` keeps its label `How to compare missions`; `onClick` → `useTutorialStore.getState().startTour(actStart(2))`; `data-tip="Start the guided tour at Act 2: making the decision"`.
- `MissionAssistant` nav target `tour` → same call.
- `navigation.ts` guide topic `Restart the tutorial`: steps text `Click **How to compare missions** at the top of the page: the guided tour opens at Act 2, the comparison. The header's **Guided tour** button starts it from the beginning.`
- Landing: when `onTour` is given, a second button `Take the guided tour` (classes `lnd-btn lnd-btn-nav`) sits right after each `OpenNavigatorButton` in `Hero` and `Close`.

- [ ] **Step 1:** Add to `landing.test.tsx`: render `<Landing onOpen={() => {}} onTour={() => {}} />` (follow the file's existing render pattern) and expect `Take the guided tour`; render without `onTour` and expect it absent. In `assistant.test.tsx` keep the `How to compare missions` / `[[go:tour]]` expectations (they still hold).
- [ ] **Step 2:** Run `npx vitest run src/features/landing src/features/compare` – the landing test fails.
- [ ] **Step 3:** Implement; then `grep -rn "useCompareTour\|CompareTour\|TourOffer\|tour/steps" src` returns nothing.
- [ ] **Step 4:** Run `npx vitest run src/features/landing src/features/compare` – pass.
- [ ] **Step 5:** Commit `feat(tour): comparison, assistant and landing page open the unified tour`.

### Task 6: Interface review, docs, final gate

**Files:** `docs/mission-story.md` ("The journey in the app" section), whatever the review fixes.

- [ ] **Step 1:** Run the `better-interface` review on the coachmark (desktop 1366×768 and 390 px narrow), the offer chip and the header button; fix ranked issues that do not restyle the UI.
- [ ] **Step 2:** Update `docs/mission-story.md`: the story now runs inside the Guided Tour (Act 1 steps 1, 6–9, Act 2 steps 10 and 14); entry points; no separate card.
- [ ] **Step 3:** From `frontend/`: `npx vitest run` (0 failed), `npm run build` (exit 0), `npm run lint` (0 errors).
- [ ] **Step 4:** Commit `docs: guided tour runs the mission story`.
