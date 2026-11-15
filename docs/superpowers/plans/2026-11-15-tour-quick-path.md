# Guided Tour Quick Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 7-step quick path and a 19-step full path through one tour, three new steps (countdown, science vs
engineering, your turn), accurate claims and plain-language live cards.

**Architecture:** Paths are lists of step ids over the one `TUTORIAL_STEPS` array; the store navigates within the
active path; the coachmark shows path-relative progress. Live-card wording changes live in the story engine's
`stageModel` (`features/guide/mission.ts`).

**Tech Stack:** React 19, TypeScript, Zustand 5, Tailwind 4, Vitest 5 (node environment, `renderToString`), oxlint.

**Spec:** `docs/superpowers/specs/2026-11-15-tour-quick-path-design.md`

## Global Constraints

- No restyling: reuse the existing coachmark / offer classes. No new dependencies.
- Step copy: `whyItMatters` ≤ 2 sentences and ≤ 240 characters; `tryPrompt` ≤ 120 characters; no measured values in
  static copy (mission facts via `SITE`, `DAYS`, `DELAY` from the mission definition).
- No step copy may contain "Gracy", "direct link", "nearby" or "WAC_POLE".
- TDD: every task writes its failing test first. Final gate in `frontend/`: `npx vitest run`, `npm run build`,
  `npm run lint`, 0 errors. Nothing is committed (the user has not asked).

## Review Focus

1. Quick path jumping (act tab 2 from step 1) must catch the story up to the comparison exactly as the full path
   does. → Task 3 test `quick path: Act 2 tab catches up`.
2. The last step of either path must not auto-advance after a try action (site picked): it stays until "Explore on
   my own". → Task 2 test `your-turn never auto-advances`.
3. Picking a site on `your-turn` changes the running plan: the story must already be stopped (Act 3 needs no story),
   so no "inputs changed" message appears. → Task 3 test `your-turn stops the story`.
4. `startTour(actStart(2), 'full')` (Comparison button) and `?tour=1` keep working. → Task 2 tests.
5. The recap shows nothing (not wrong verdicts) when the story never reached the comparison (full path entered at
   Act 3). → Task 3 test `recap is empty without a comparison`.

---

### Task 1: Live text and accuracy outside the tour core (parallel subagent)

**Files:** `frontend/src/features/guide/mission.ts`, `frontend/src/features/guide/guide.test.tsx`,
`frontend/src/features/landing/content.ts` (+ `landing.test.tsx` if it asserts the old copy),
`frontend/src/features/compare/methodology/ComparisonMethodology.tsx` (+ its test if any),
`frontend/src/viz/ViewerHud.tsx`. Do not touch `features/tutorial/*`.

**Interfaces – Produces:**
- `stageModel` facts / rows / headroom text use plain labels by `constraint_id`:
  `max_continuous_darkness` "Longest dark spell (battery only)", `max_communication_blackout` "Longest time Earth is
  out of sight", `min_earth_visibility_percent` "Time with Earth in sight", `min_mean_solar_disk_fraction` "Average
  share of the Sun's disk visible", `min_initial_sunlight` "Sunlight right after landing",
  `min_initial_earth_visibility` "Earth in sight right after landing"; other ids keep `c.name`. Export
  `plainName(c: ConstraintEvaluation): string` from `mission.ts`.
- Durations ≥ 48 h in those values also show days: `118 h (4.9 days)`, `96 h (4 days)`. Export
  `withDays(text: string): string` (adds the days to an "N h" value; leaves others unchanged).
- The rescue stage's facts gain `{ label: 'Moved', value: '143 km from the original site' }` from the selected
  alternative's `distance_km` (rounded to whole km).
- Evidence lead: "…: N h without Earth in line of sight, against a limit of M h…" (no "direct-to-Earth link"); the
  clipped-window note uses the live hours: "…so this mission experiences at least N h."
- Landing story card `delay`: "The launch slips four days", body and fact `+4 days` (match the tour).
- Comparison methodology: Gracy & Lee role "Site coordinates source"; text says it locates the sites and is not a
  validation of this model.
- `ViewerHud.tsx`: the readout `<dl>` gets `data-tour="hud-readout"`.

- [ ] Write failing tests in `guide.test.tsx`: the `changed` row `name` is "Longest time Earth is out of sight",
  `after` is "118 h (4.9 days)"; the rescue model's facts contain "Moved" with "143 km"; the evidence model's lead
  does not contain "direct-to-Earth link" and contains "line of sight"; `withDays('22 h') === '22 h'`,
  `withDays('118 h') === '118 h (4.9 days)'`, `withDays('96 h') === '96 h (4 days)'`.
- [ ] Run `npx vitest run src/features/guide` – they fail. Implement. Run – pass. Update any landing / methodology test
  that asserted the old copy. Run `npx vitest run src/features/guide src/features/landing src/features/compare`.

### Task 2: Paths, new steps and path-aware store

**Files:** `frontend/src/features/tutorial/steps.ts`, `useTutorialStore.ts`, `index.ts`, `tutorial.test.tsx`.

**Interfaces – Produces:**
```ts
export type TourPath = 'quick' | 'full'
export const TOUR_PATHS: Record<TourPath, string[]> // quick: mission, delay, evidence, rescue, compare, science, your-turn; full: every id in order
export function pathSteps(path: TourPath): number[] // indices into TUTORIAL_STEPS
// store
path: TourPath                                   // default 'full'
startTour(startIndex?: number, path?: TourPath)  // default: first step of the path, path 'full'
nextStep / prevStep / goToAct                    // move within the path; past the path's last step = finish
```
`initTutorialFromSearch`: `tour=quick` starts the quick path; `tour=1|true` the full path. `recordInteraction` keeps
the path's last step open (no auto-advance).

Steps (full order, 19): Act 1 mission, terrain, timeline, **countdown**, sky, jpl, original, delay, evidence, rescue;
Act 2 compare, headroom, sync, tradeoffs, **science**, report; Act 3 atlas, method, **your-turn**. `assistant` removed.
Act 3 title "Trust the science, then try it".

New / rewritten copy (exact):
- countdown (look, target `[data-tour="hud-readout"]`, placement right, badge "Countdown"): title "Time left before
  sunset and Earthset"; why "Operators plan around these countdowns: the next sunset, and the next time Earth drops
  behind the terrain. At the pole the Sun stays within a few degrees of the horizon, so a small ridge decides power.";
  prompt "Next sunset, next Earthset, and the Sun's elevation against the terrain."
- science (look, `reveal: 'cmp-science'`, target `#cmp-science`, placement top, badge "Trade-off"): title "Science vs
  engineering"; why "The recovery moved the landing to another site. Science wants to stay near shadowed ice,
  engineering wants sunlight and Earth in sight, and this search finds the best balance or what each side gives up.";
  prompt "Find best compromise: say what science needs, then search."
- your-turn (try, triggers site-select + drop-pin, view planner, targets `[data-tour="site-select"]`,
  `[data-tour="drop-pin"]`, placement top, badge "Explore", nextLabel "Explore on my own"): title "Your turn"; why
  "A passing plan broke on a short delay, and the engine found a fix elsewhere. Now pick another site, or drop a pin
  anywhere from 80° S to the pole."; prompt "Open the site picker or press Drop pin, then press Play."
- mission why: "Ice hides in craters that never see sunlight, but a lander needs both sunlight and Earth in sight.
  This ${DAYS}-day landing in the Artemis III region is loaded from real NASA data."
- evidence why: "Near the pole Earth hangs low and bobs up and down each month (libration). The camera stands at the
  lander looking toward Earth; the band on the time strip marks how long it stays out of sight."
- rescue why: "Rescue searches other candidate sites and later dates for a plan that still meets every requirement.
  The engine then double-checks it."
- jpl why: "Sun and Earth positions come from NASA JPL Horizons. When online, Verify with JPL re-queries Horizons for
  this hour and compares it with an independent DE421 ephemeris."
- method why: "Sun and Earth positions are checked against an independent DE421 ephemeris, and modelled sunlight
  against LROC orbital illumination maps. Known limitations are listed."

- [ ] Failing tests in `tutorial.test.tsx`:
```ts
it('defines 19 steps in 3 acts and two paths', () => {
  expect(TUTORIAL_STEPS.map((s) => s.act)).toEqual([1,1,1,1,1,1,1,1,1,1,2,2,2,2,2,2,3,3,3])
  expect(TOUR_PATHS.quick).toEqual(['mission','delay','evidence','rescue','compare','science','your-turn'])
  expect(TOUR_PATHS.full).toEqual(TUTORIAL_STEPS.map((s) => s.id))
  expect(TUTORIAL_STEPS.some((s) => s.id === 'assistant')).toBe(false)
})
it('quick tour moves only through its steps and finishes after Your turn', () => { /* startTour(undefined,'quick') → mission; next → delay; prev → mission; goToAct(2) → compare; goToAct(3) → your-turn; next → closed + completed */ })
it('your-turn never auto-advances after a try action', () => { /* quick path at your-turn, recordInteraction('site-select'), advance 2000 ms → still your-turn, actionDone true */ })
it('tour=quick starts the quick path; tour=1 the full path', () => { /* initTutorialFromSearch */ })
it('Comparison entry still opens the full path at Act 2', () => { /* startTour(actStart(2),'full') → compare, next → headroom */ })
it('copy claims only what the engine computes', () => { /* no Gracy / direct link / nearby / WAC_POLE in any title, why or prompt; method mentions DE421 and LROC */ })
```
Keep and update the existing concise-copy, keyboard and persistence tests (indices by id).
- [ ] Run – fail; implement; run `npx vitest run src/features/tutorial` – pass.

### Task 3: Card, recap and the quick path across routes

**Files:** `frontend/src/features/tutorial/TutorialSpotlight.tsx`, `storyBridge.ts`, `tour.test.tsx`,
`tutorial.test.tsx` (card tests).

**Interfaces – Produces:**
- `recapFacts(snap = snapshot()): { label: string; value: string; tone: 'pass' | 'fail' | 'unknown' | 'neutral' }[] | null`
  in `storyBridge.ts`: the three story plans in the comparison (labels "Original plan", "After the delay",
  "Recovery"; value `${site} · PASS|FAIL|UNKNOWN`); `null` when the story has no comparison set.
- `useRecap(on: boolean)` hook (subscribes to guide / comparison stores) returning `recapFacts()` or null.
- `TutorialSpotlightView` props gain `path?: TourPath` (default 'full'), `recap?: Fact[] | null`,
  `onStartFull?: () => void`. Progress is `pos / total` within the path; on the quick path a "Quick tour" label sits
  beside it; act tabs list only acts the path contains; dots list the path's steps in the current act; on
  `your-turn` the recap renders as a "Live result" group above the prompt and, on the quick path, a secondary
  "Take the full tour" button calls `onStartFull` (`startTour(0, 'full')`).

- [ ] Failing tests:
  - `tour.test.tsx`: `quick path walks the whole story across routes` (startTour quick → next ×6 with flush /
    viewerShows: delay row after contains "118 h"; rescue recovery `malapert-massif`; compare view + 3 compareIds;
    science view compare; your-turn view planner and `recapFacts()` roles PASS / FAIL / PASS);
    `quick path: Act 2 tab catches up`; `your-turn stops the story` (no catch-up running, view planner);
    `recap is empty without a comparison` (fresh full path, goToAct(3), `recapFacts()` null).
    Update the existing `118 h` assertion to `toContain('118 h')` and the `assistant` requiredStage line to `science`.
  - `tutorial.test.tsx` card: quick path renders `1 / 7` and "Quick tour"; quick act-1 dots = 4; your-turn renders the
    recap values, "Take the full tour" (quick only) and Next "Explore on my own".
- [ ] Run – fail; implement; run `npx vitest run src/features/tutorial src/features/guide` – pass.

### Task 4: Entry points

**Files:** `frontend/src/features/tutorial/TutorialOfferChip.tsx`, `frontend/src/viz/MapTools.tsx` (menu),
`frontend/src/App.tsx` (`openGuidedTour`), `frontend/src/features/compare/tour/TourButton.tsx`,
`frontend/src/features/compare/assistant/MissionAssistant.tsx`, `tutorial.test.tsx`.

- Offer: primary gradient button "Quick tour · 90 s" (`startTour(undefined,'quick')`), secondary outline "Full tour"
  (`startTour(0,'full')`); copy "Follow one real south-pole mission from landing site to decision."; anchored line
  unchanged.
- ⋮ menu: item "Quick tour" (`data-tour="menu-tour"`, right label "90 s") and item "Full guided tour" (right label
  "19 steps").
- Landing button and `openGuidedTour` → quick. Comparison button and assistant `tour` target →
  `startTour(actStart(2), 'full')`.
- [ ] Failing test: offer chip HTML contains "Quick tour · 90 s" and "Full tour". Run – fail; implement; pass.

### Task 5: Docs, full gate, live check

- [ ] `docs/mission-story.md`: the two paths and the new steps.
- [ ] From `frontend/`: `npx vitest run`, `npm run build`, `npm run lint` – 0 failures / exit 0 / 0 errors.
- [ ] Live screenshots (dev server :5173, fresh profile): offer card with both buttons; quick path steps 1, 3, 6, 7.
