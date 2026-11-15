# Unified Guided Tour – design

Approved 2026-11-15.

## Intent

Judges explore the app with little time and no narration. Today three separate guides compete (the 8-stop planner
tutorial, the "Try a mission" story card, the 6-stop Comparison tour), and none of them visits the Feasibility Atlas or
Validation & Methodology. Replace them with ONE guided tour that tells the real "Try a mission" story and introduces
every view along the way, so a judge sees the whole product as one decision (Presentation, Relevance, Validity).

## Goals / non-goals / anti-goals

- Goals: one entry point (header, ⋮ menu, welcome chip, landing page); three acts across `#app/planner`,
  `#app/compare`, `#app/atlas`, `#app/method`; 1–2 sentences + one action or observation per step; act tabs for
  jumping, progress, Back/Next, Skip (Esc) at any time; spotlight only the active control.
- Non-goals: new science, new engine calls, restyling.
- Anti-goals: scripted numbers (every mission fact comes from the live stores via `guide/mission.ts`); two guides
  visible at once; a judge trapped in a step that cannot advance.

## Approaches considered

- **A. Mission as the backbone (chosen).** Story stages interleaved with spotlight stops on the controls the story
  uses. Every click moves one story forward.
- B. Feature tour, then the mission as a second chapter: simpler, but ~20 "this button does X" stops before the payoff.

## Design

- **Store.** `features/tutorial/` becomes the one tour. `TUTORIAL_STEPS` gains `act` (1 | 2 | 3), `view`
  (planner | compare | atlas | method) and an optional `story` stage id. Store gains `goToAct(act)`.
- **Spotlight steps** keep today's behaviour (target selectors, try-it triggers, auto-advance after the action).
- **Story steps** call the headless story engine (`useGuide`) to enter the stage; the coachmark renders the live
  `stageModel` lead (shortened) and up to 3 facts; Next is disabled ("Working…") until `status === 'ready'`; error
  shows Retry; outdated/modified show the engine's message and let the judge continue. Jumping forward into a story
  step whose prerequisites have not run runs the earlier stages in order first ("Preparing the mission…").
- **One card.** The existing M3 coachmark (opal card, coral strip) gains an act tab row; dots show steps of the
  current act. The dark `GuideCard` and the `CompareTour` card/offer are no longer rendered; `guide/mission.ts` stays
  as the engine.
- **Entry points.** Header "Try a mission" → "Guided tour" (same coral pill). ⋮ menu item, welcome chip and the
  landing page's new secondary button ("Take the guided tour" → `#app/planner?tour=1`) start the same tour. The
  Comparison page's tour button starts it at Act 2.
- **Overlay.** The evidence step (Show in 3D) drops the scrim so the 3D view stays fully visible.
- **Persistence.** One key (`lunar-tutorial-prefs`) for completed / don't-show-again.

### Steps

Act 1 – Plan a south-pole landing (planner): 1 mission (story `mission`), 2 LOLA terrain (orbit), 3 time bar,
4 sky plot, 5 Verify with JPL, 6 original PASS (story `original`), 7 4-day delay → FAIL (story `changed`, which
applies the delay), 8 Show in 3D (story `evidence`), 9 Mission Rescue (story `rescue`).
Act 2 – Make the decision (compare): 10 three plans imported (story `compare`), 11 verdict & headroom, 12 synchronized
timeline, 13 decision & trade-offs, 14 Mission Report / PDF (story `report`), 15 Mission Assistant (optional).
Act 3 – Trust the science: 16 Feasibility Atlas (atlas), 17 Validation & Methodology (method).

## Left to the builder

Exact selectors, copy wording within the length limit, card dimension tweaks, test structure.
