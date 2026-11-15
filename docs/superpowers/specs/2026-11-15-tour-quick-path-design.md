# Guided Tour: quick path, coverage gaps and accuracy – design

Approach B chosen 2026-11-15 after a three-seat review (NASA SME, educator, presentation judge).

## Intent

Judges give an entry 3–5 minutes, often without narration. The full tour takes about 6 minutes, its strongest
moment (delay → FAIL → 3D evidence → Rescue) arrives around 2.5 minutes in, and Act 3 is rarely reached. It also
misses challenge objectives the brief names explicitly, and carries a few claims the engine does not support.

## Goals

1. **Two paths through the same steps.** *Quick tour* (7 steps, about 90 s): mission → delay → evidence → rescue →
   compare → science vs engineering → your turn. *Full tour* (19 steps). Same card, same step definitions.
2. **Fill the coverage gaps** (challenge objectives 1, 3, 4, 7; AGENTS.md creativity claims):
   - new `countdown` step: the readout's next sunset / next Earthset and the Sun's elevation against the terrain;
   - new `science` step: the Science vs Engineering resolver (the rescue moved the site 143 km: what does science give up?);
   - new final `your-turn` step: a live recap of the three verdicts, then the site picker / Drop pin (curated
     Artemis, CLPS, international, Apollo sites or any point 80–90° S);
   - "why the south pole" in the mission copy; libration (Earth's monthly wobble) in the evidence copy;
   - remove the `assistant` step (all three reviewers).
3. **Accuracy.** Gracy & Lee is a coordinate source, not a validation; "line of sight to Earth", not "link";
   Malapert is 143 km away, not "nearby"; no typed-in 118 h; the landing page's "ten days" becomes four days; the
   Comparison methodology page's "Published benchmark" label for Gracy & Lee becomes "Site coordinates source".
4. **Plain language on live cards.** Constraint names mapped to plain labels; long durations also in days;
   "direct-to-Earth link" and "canonical" out of the first sentence the card shows.

## Non-goals

Story-first reorder (C); audience branching beyond the two paths; resume-where-you-left-off; prefetching Atlas or
Methodology data; restyling; editing CLAUDE.md / AGENTS.md (the team's submission docs already word Gracy & Lee
correctly).

## Anti-goals

A number in static copy that the live engine could contradict; a claim the engine does not compute (radio links,
antennas, DSN); a try-it action mid-story that changes the running plan (site selection waits for the last step).

## Approaches

- A. Fix and fill, one path (19 steps): cheapest; still ~6 minutes.
- **B. A + a quick path (chosen):** a judge with 3 minutes sees the whole story and the creativity claims; the full
  tour stays for depth. Costs a path list, path-aware navigation and tests.
- C. A + story-first reorder: wow in the first minute, but tool stops would run on the broken plan; riskiest.

## Design

### Steps (full path order)

Act 1 – Plan: mission, terrain, timeline, **countdown**, sky, jpl, original, delay, evidence, rescue.
Act 2 – Decide: compare, headroom, sync, tradeoffs, **science**, report.
Act 3 – Trust the science, then try it: atlas, method, **your-turn**.

Quick path: mission, delay, evidence, rescue, compare, science, your-turn.

New steps:
- `countdown` (act 1, planner, look): target `[data-tour="hud-readout"]` (new attribute on the readout `<dl>`).
- `science` (act 2, compare, look): `reveal: 'cmp-science'`, target `#cmp-science`. The resolver needs the judge to
  press "Find best compromise", so the prompt points at it; no auto-advance.
- `your-turn` (act 3, planner, try, triggers `site-select`, `drop-pin`; last step so it never auto-advances):
  targets `[data-tour="site-select"]`, `[data-tour="drop-pin"]`. Shows a live recap (role, site, verdict of the three
  compared plans) when the story reached the comparison. Next label "Explore on my own". On the quick path a
  secondary button "Take the full tour" starts the full path.

### Store and card

- `TourPath = 'quick' | 'full'`; `TOUR_PATHS: Record<TourPath, string[]>` (step ids); `pathSteps(path): number[]`.
- `startTour(index = first step of path, path = 'full')`; `path` in state; next / prev / goToAct move within the
  path; the last step of the path finishes; `recordInteraction` auto-advance is path-aware.
- Card: progress `n / total` within the path, a small "Quick tour" label on the quick path, act tabs only for acts
  the path contains, dots only for the path's steps in the current act.
- `storyBridge` unchanged in principle: `requiredStage` and catch-up already work on full indices; the quick path's
  story steps are in stage order.

### Entry points

Offer card: primary "Quick tour · 90 s" (the coral gradient button), secondary "Full tour". ⋮ menu: "Quick tour"
and "Full guided tour". Landing "Take the guided tour" → quick. `?tour=1` → full, `?tour=quick` → quick.
Comparison "How to compare missions" → full path, Act 2.

### Live text (stageModel)

Plain labels by constraint id: `max_continuous_darkness` "Longest dark spell (battery only)",
`max_communication_blackout` "Longest time Earth is out of sight", `min_earth_visibility_percent` "Time with Earth
in sight", `min_mean_solar_disk_fraction` "Average share of the Sun's disk visible", `min_initial_sunlight`
"Sunlight right after landing", `min_initial_earth_visibility` "Earth in sight right after landing"; anything else
keeps the engine name. Hours of 48 or more also show days: "118 h (4.9 days)". Rescue facts add
"Moved: 143 km from the original site" from the response's `distance_km`. Evidence lead: "…without Earth in line of
sight…"; the clipped-window note uses the live hours ("at least N h").

## Left to the builder

Exact copy within the 2-sentence / 240-character limits; card label placement; test structure.
