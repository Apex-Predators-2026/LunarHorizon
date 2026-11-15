# "Try a mission": the verified guided story

The guided mission (landing page **Try a mission**, or the button in the navigator header) walks through one real
decision with the live tools: load a plan, read its requirements, apply a launch delay, see what broke, inspect the
evidence in 3D, run Mission Rescue, compare the plans and export a report. Every verdict, number and alternative it
shows comes from the current engine and Rescue responses; nothing is scripted.

## The mission

Definition: [`frontend/src/features/guide/missions/pns-launch-delay.json`](../frontend/src/features/guide/missions/pns-launch-delay.json)
(`mission-story-v1`, id `pns-oct-2027-launch-delay`, version 1).

| | |
|---|---|
| Site | Peak Near Shackleton (89.017° S, 126.273° E), Artemis III candidate region |
| Plan | land 2027-10-10 00:00 UTC, 14 days, default solar direct-to-Earth requirements |
| Disruption | launch delay of 4 days → land 2027-10-14 00:00 UTC; duration and requirements unchanged |
| Search | Rescue's default scope: 30-day window after the delayed date, 12 h step, top 5, real data only |

Verified result (2026-11-15, engine `0.6.0-phase6`, scoring `desirability-v1`, site files generator 1.2):

| | Original (10 Oct) | After the delay (14 Oct) | Recovery (Malapert Massif, 14 Oct) |
|---|---|---|---|
| Verdict | **PASS** | **FAIL** | **PASS** |
| Longest Earth blackout (≤ 96 h) | 22 h | **118 h** (to the end of the mission) | 0 h |
| Longest power darkness (≤ 50 h) | 3 h | 3 h | see live result |
| Earth in line of sight (≥ 40 %) | 93.5 % | 64.9 % | see live result |
| Comparison rank (one group) | 2 of 2 passing | not ranked (fails) | **1 of 2 passing** |

- Only one requirement changes status: the direct-to-Earth line-of-sight blackout. It exceeds the limit by 22 h, so
  the story does not rest on a threshold graze or rounding.
- Evidence: Earth is out of line of sight from **2027-10-23 02:00 UTC** until the end of the mission
  (2027-10-28 00:00 UTC). The window is clipped at mission end: the blackout may continue afterwards, so 118 h is what
  the mission experiences, not the full length of the outage.
- Mission Rescue's first alternative keeps the delayed date, the 14-day duration and every requirement and moves to
  Malapert Massif. The canonical assessment (not only Rescue's fast path) confirms it passes, and the comparison
  re-assessment agrees with all three verdicts.

## How the case was chosen (bounded search)

Two real-data candidates already in the repository were replayed through the API (no exhaustive search):

1. `backend/app/rescue/demo_scenario.json` — Connecting Ridge, 2027-02-08, 7 days, +5 days → fails power darkness
   (63 h vs 50 h), Rescue moves to Malapert 3.5 days later. Reproduces, but the original plan scores 100 and stays
   ranked above the recovery in the comparison, which makes the final decision read oddly ("the plan you can no
   longer fly is ranked first").
2. The existing guide's case, Peak Near Shackleton 2027-10-10 +4 days (chosen). Wide margins on both sides of the
   transition, a single failing requirement, a same-date recovery that needs no requirement change, and a comparison
   that ranks the recovery first.

The Malapert/Connecting Ridge example in `docs/member2-part2-demo.md` documents two passing missions and was not used:
it has no disruption.

## Stable vs incidental expectations

`expected` and `assertions` in the definition separate what the story depends on from details that may move:

- **Stable** (any change = the example is outdated): the three verdicts, the failing requirement set, ≥ 12 h over
  the limit, the evidence interval, a passing recovery with unchanged duration and requirements on real data, the
  comparison agreeing and ranking the recovery first in one group.
- **Incidental** (reported, never a failure): scores and exact values, which recovery Rescue lists first, generated
  ids/labels/colours/timestamps, dataset hashes and method versions (a change flags re-verification).

In the browser the guide checks the same stable statements against the live responses. If the current calculation
no longer produces them it shows an "outdated example" state with the actual verdicts and does not narrate the
expected failure.

## Reproduce

```bash
cd backend
python scripts/verify_mission_story.py                      # replay through the API, check every expectation
python scripts/verify_mission_story.py --write-provenance   # after a deliberate data/engine update
pytest tests/test_mission_story.py                          # the same checks as a regression test
```

The provenance block records the SHA-256 of each site file the API evaluated and the method versions it reported.
Historical site files are not bundled, so a future engine or data change can change the numbers; the hashes make
such a change detectable, they do not guarantee numerical reproduction.

## The journey in the app

Eight stages on one card (progress, Back, Restart, Exit, Minimise). A stage advances only when its real result is
available; slow requests offer Retry / Exit, failures offer Retry.

1. **Your mission** – the definition's site, objective, duration and requirements; loaded as the running plan.
2. **The original plan** – the canonical assessment: PASS and the margins a delay could eat into.
3. **A launch delay** – entered through Mission Rescue's own "Plan change" control; the assessment panel shows
   "After change".
4. **What changed** – only the requirements whose status changed, before and after, against the limit.
5. **Inspect the evidence** – Show why opens the blackout window in the 3D view (the stage waits until the view
   shows it).
6. **Find a recovery** – real Mission Rescue with the declared scope; the first alternative that keeps the duration
   and requirements is selected and re-checked by the canonical engine.
7. **Make the decision** – original, delayed and recovery plans go to Scenario Comparison with their roles and
   provenance; the comparison's own re-assessment and recommendation are read back.
8. **Export the decision** – the summary report for exactly that evaluated selection (print / save as PDF, JSON).

State: the story owns only its stage, a request token and the ids of what it created. Results stay in the
assessment, Rescue, comparison and evidence stores. Editing the plan, the delay or the imported comparison plans
pauses the story ("inputs changed"); restart removes only what it created (no duplicate saved plans); exit leaves
everything as it is; the feature tutorial and the story never run at once.

## The summary report

`Generate Summary Report` (comparison decision area, or stage 8) freezes the evaluated selection into an immutable
snapshot (`summary-report-v1`). The preview renders only the snapshot; if the live comparison changes afterwards it
says so and offers Regenerate. The JSON download is the same snapshot, including the comparison export
(`comparison-export-v1`, revision 2) with scenario revisions, requested and evaluated intervals, dataset files and
SHA-256, method versions and the inputs needed to rerun the comparison. Page 1 is a decision brief; supporting pages
hold configuration, requirement margins and evidence windows, baseline changes, ranking method and pairwise
evidence, preferences (labelled as preferences), sources, limitations and the reproduction block.

## Environments

- **Verified (2026-11-15):** local offline demonstration — backend with `LUNAR_OFFLINE=1` on the committed
  `data/sites/` files, production frontend build served by `vite preview` (and the dev server), Chrome 1366×768 and
  1920×1080, `frontend/scripts/e2e-guided.mjs` 46/46 including A4 and Letter PDFs of the report. No live JPL Horizons
  request is needed anywhere in the story. 3D terrain tiles come from the local tile cache or Moon Trek (see
  docs/demo-setup.md to warm the cache for a fully offline 3D view).
- **Not verified here:** a publicly hosted deployment (it needs the backend and the site files deployed with it).
