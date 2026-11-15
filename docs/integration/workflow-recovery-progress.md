# Workflow recovery progress (role FRIEND, branch `recovery/workflows-remaining`)

Base: `origin/main` @ `565147e`. Source objects imported from `lunar-recovery-sources.bundle` under `refs/recovery/*`;
the three tips match the manifest (`efac9bf`, `2432dba`, `74ab073`) and every source commit used below was inspected
as a real patch. Nothing from the source branches was merged wholesale. `backend/app/timegrid.py`, the hourly-grid
policy and the served `backend/app/atlas` are unchanged.

## Prompt 1: Rescue and Atlas

| Source | Recovered | How |
|---|---|---|
| `b693a47` (backend) | Sensitivity of an UNKNOWN plan: neighbouring dates are judged, each on its own data | `rescue/sensitivity.py`: the early return for an UNKNOWN base is gone; points carry `reason` + `undecided_constraints`, counts carry `by_reason` |
| `b693a47` (frontend) | Undecided points labelled by reason, "What changed" summary, alternatives vs engineering compromise headings, Compare link | `SensitivityView`, `AlternativeCard` (tooltips), `RescuePanel` (`WhatChanged`, `whatChanged`), `format.ts` (`REASON_LABEL`, `reasonBreakdown`) |
| `be2c307` | Demo scenario version 2: explicit requirements, recomputed and recorded outcome | `rescue/demo_scenario.json`, `tests/test_rescue_real_data.py`, Methodology text, `docs/rescue.md` |
| `524de77` (frontend) | Atlas map snapshots and stale-transfer protection; narratives keep PASS / FAIL / UNKNOWN / NOT_EVALUATED apart | `features/atlas/session.ts` (+ tests), `AtlasView.tsx`, `atlas.ts` (+ tests); conflict resolved keeping main's `time_note` line |
| `524de77` (backend) | **Excluded**: reporting between-hour landings to the second is the exact-interval policy; main's Atlas snaps landings to the hourly grid, so the response already carries the evaluated instant | `backend/app/atlas/service.py`, `tests/test_atlas.py` left as on main |

Not taken from `b693a47`: the `nav.ts` store and its `App.tsx` change (main routes with `appRoute.ts`), and its own
Compare import (main's Comparison already imports Rescue results with roles through `RescueImport`). The "Compare
them" button only opens Scenario Comparison, where that import lives. The Explain walkthrough keeps its prose; the new
"What changed" block is the always-visible verdict and requirement summary, not a second walkthrough.

### Sensitivity contract (additive, older responses still render)

| Field | Values | Meaning |
|---|---|---|
| `SensitivityPoint.reason` | `incomplete_data` | evaluated on real data, but samples are missing (a gap, or the mission runs past the end of the data) |
| | `outside_coverage` | the site has real data, but not for this mission's dates |
| | `no_real_data` | the site has no real data at all |
| | `position_unsupported` | landing-position check skipped: no real terrain data around the site (status `not_evaluated`) |
| `SensitivityPoint.undecided_constraints` | requirement ids | requirements the data can't decide (unknown points; undecided extras on a failing point) |
| `SensitivityCounts.by_reason` | `{reason: n}` | unknown + not_evaluated points by reason |
| `DateSlipCheck.reason` | as above | unknown slips in Rescue's quick robustness |

Rules kept: unknown is never a pass or a fail; pass rates use decided points only; no safe window and no robustness
verdict around an undecided plan (`verdict: "unknown"`); date slips never stand in for landing-position robustness.

### Seven baseline backend failures: resolved as contract/test mismatches

They were tests pinning the policy that main's `ada6c42` / `3cc2355` replaced (Rescue now judges missions that run
past the data on the real hours, like the Comparison and the Atlas; lengths are snapped to whole hours). The tests now
assert the current contract (canonical source, real samples only, never an exact score, a verdict only where the
bounds prove it); missions that start outside the data are still asserted UNKNOWN. Nothing was weakened or skipped.

Finding while doing this: at the data-end boundary the canonical engine can **prove a PASS** (Connecting Ridge 3 d and
7 d ending one hour past the data: 12 h longest darkness against a 50 h battery, so even a dark final hour passes).
That is correct bounded semantics, but the phrase "never a pass" overstates the policy. Fixed in Rescue's own comment
(`rescue/engine.py`). **Cross-owner, not edited:** `backend/app/compare/service.py` lines 84-86 and 477-481 say "it can
show a fail, never a pass", and line 481 is shown to users. Suggested wording: "a verdict only where the hours that
exist prove it (usually a fail)".

### Demo scenario (verified, `backend/app/rescue/demo_scenario.json` version 2)

Requirements written out (equal to today's defaults): sunlight >= 0.5, battery darkness <= 50 h at panel threshold
0.25, Earth in view >= 0.4, Earth blackout <= 96 h, >= 24 h sunlight and >= 12 h Earth contact after landing.

| Step | Recomputed result (real data, hourly grid) |
|---|---|
| Connecting Ridge, 2027-02-08 00:00 UTC, 7 d | PASS, score 100 |
| + 5-day launch delay (2027-02-13 00:00 UTC) | FAIL, `battery_hours`: 63 h against 50 h (score 64.8) |
| Rescue | `rescued`, 488 candidates, 48 pass, 5 alternatives; #1 Malapert Massif 2027-02-16 12:00 UTC (+84 h), score 100 |

`test_demo_scenario_transition` recomputes every value under `verified` and every number quoted in `story`;
`test_demo_scenario_does_not_depend_on_default_requirements` checks all requirements are written out.

### Stable entry points for the guided mission (prompt 3)

- Demo definition: read `original`, `change`, `verified` from `backend/app/rescue/demo_scenario.json`; run it with
  `POST /api/rescue` (`RescueRequest` = `{original, change}`). Never copy its numbers into the UI.
- Rescue UI pieces with plain props: `RescueResults`, `WhatChanged` / `whatChanged(res)`, `SensitivityView`.
- Atlas: `atlasSession` (vanilla zustand store) with `submit(request, site)` and `transfer()`; `transferFor(snapshot,
  row, col, pending)` is the only path from a cell to a `Scenario`; `openInPlanner(name, scenario)` runs it.

### Checks actually run (worktree, Node 25 with `NODE_OPTIONS=--no-experimental-webstorage`; the repo pins Node 24)

| Check | Result |
|---|---|
| Rescue/sensitivity targeted backend (`test_sensitivity_compromise`, `test_rescue_coverage`, `test_api`, `test_rescue*`, `test_headroom_contracts`) | 17 + 84 passed |
| The 7 former baseline failures (`tests/viability/test_real_sites_phase6_compat.py`, `test_phase6_rescue_compat.py`) | 139 passed |
| Demo tests (`test_rescue_real_data.py -k demo`) | 3 passed |
| Full backend suite | not completed (stopped on request); targeted Rescue/Atlas runs above only |
| `npx tsc -b` | clean |
| Full vitest | 43 files, 421 tests passed |
| `npx oxlint` | 0 errors (13 warnings, all pre-existing kinds; one new `only-export-components` warning for `whatChanged` in `RescuePanel.tsx`) |
| `npm run build` | OK |

Browser checks were not run for this stage. After merging origin/main @ 72e08a8 (no overlap with these files) nothing was re-run.

### Remaining issues

- `compare/service.py` "never a pass" wording (above), for the Comparison owner.
- The frontend fixture `sensitivity-response.json` (a passing plan) was captured before `reason` / `by_reason`
  existed; it is kept as the "older response" case. `sensitivity-unknown-response.json` was regenerated from the
  current backend and `sensitivity-unknown-neighbours-response.json` was added (real responses).

Commits: made locally, not pushed (the owner pushes manually).

---

## Milestone 2: the guided mission ("Try a mission") and its browser verification

Milestone 1 (Rescue and Atlas, above) was published as `982edac` on `recovery/workflows-remaining`. This milestone is
built on top of it plus a merge of the published core branch (`origin/recovery/core-remaining` @ `5eb3316`, which
provides the shared assessment store, evidence navigation, `missionTime` and the frozen report). The final SHA of this
milestone is stated in the completion report (a document cannot contain the SHA of the commit that contains it).

### Source classification (workflow items)

| Source | Status | What was done |
|---|---|---|
| `c6fde69`, `00974a5`, `06e1c04` guided mission | **integrated** (adapted) | `frontend/src/features/guide/` taken from the source tip (`efac9bf`, which contains the later fixes). Two small helpers replace files that do not exist on main: `guide/nav.ts` (a view store mirroring the URL hash through `appRoute.ts`; main has no `nav.ts`) and `guide/openPlan.ts` (open a scenario as the running plan, never duplicating the saved plan). The evidence is opened with `origin.kind: 'guide'` (core handoff) so "Exit evidence view" returns to the story |
| `489ec99` verified mission definition + replay | **integrated as is** | `guide/missions/pns-launch-delay.json`, `backend/app/mission_story.py`, `backend/scripts/verify_mission_story.py`, `backend/scripts/make_mission_fixtures.py`, `backend/tests/test_mission_story.py`, `test_guided_mission.py`, `docs/mission-story.md` |
| `4a813d6` LoadingIndicator crash + e2e | **already present** / **integrated** | the clamp exists on main (`ui/loadingMorph.ts`: `Math.max(0, elapsedMs)`, tested in `loadingMorph.test.ts`); verified, not duplicated. `scripts/e2e-guided.mjs` integrated and adapted (below) |
| `ba0a6dd` time + missing-data browser check | **adapted** | the source asserted the obsolete exact-interval policy. `scripts/e2e-time-missing.mjs` is rewritten for the hourly grid (expected values restated from `timegrid.py`, never copied from output) and keeps the missing-data checks |
| `86773a0` visual polish | **partly integrated, partly superseded** | the card no longer covers the Ask Rover launcher (card docked left on Comparison, Atlas and Methodology, instead of hiding the launcher) and no longer clips the evidence banner at 1366 px (card width 25 rem). Plan-card badge in the header: already on main. Report "Gracy & Lee" wording: see cross-owner items |
| `1f81e10` Methodology viability checks | **already present** | `methodology/ViabilityChecks.tsx` and `api.ts` read `/api/viability/validation-summary` and say so when the report is missing, stale or failed |
| `b693a47`, `be2c307`, `524de77` | **integrated** (milestone 1) | see above |
| `b177ec8`, `19595ca`, `4ec3363`, `700b4ca` Atlas library/view | **superseded, not taken** | main serves `backend/app/atlas`; no second Atlas backend or view was added (ledger rows 6, 7, 14, 15) |

### Mission definition (committed, versioned)

`frontend/src/features/guide/missions/pns-launch-delay.json`: id **`pns-oct-2027-launch-delay`**, version **1**,
schema `mission-story-v1`. Peak Near Shackleton, landing 2027-10-10 00:00 UTC, 14 days, every requirement written out
(sunlight >= 0.5, battery darkness <= 50 h at panel threshold 0.25, Earth in view >= 0.4, Earth blackout <= 96 h,
>= 24 h sunlight and >= 12 h Earth contact after landing); a 4-day launch delay; Rescue search scope (30-day window,
12 h step, top 5); real data only (no synthetic, no demonstration data); dataset SHA-256 and engine/method versions
recorded in `provenance`; stable and incidental assertions kept apart.

### Canonical engine outcomes (replayed now with `python scripts/verify_mission_story.py`: VERIFIED, 17 checks passed)

| Step | Result on real data and the hourly grid |
|---|---|
| Original plan | PASS (score 88.2); Earth blackout 22 h against 96 h, darkness 3 h against 50 h, Earth in view 93.5% |
| After the 4-day delay (2027-10-14) | FAIL on `max_communication_blackout` only: 118 h against 96 h (22 h over); the other requirements still pass |
| Evidence | communication blackout 2027-10-23 02:00Z to 2027-10-28 00:00Z, clipped at the mission end |
| Mission Rescue | `rescued`, 5 alternatives, all meeting the recovery criteria; #1 Malapert Massif 2027-10-14 00:00Z (`site_change`), score 100, canonical assessment PASS |
| Comparison | agrees with all three verdicts; ranks the recovery first, in one comparability group |
| Datasets | hashes unchanged since recording; engine `0.6.0-phase6`, scoring `desirability-v1`, ranking `ranking-phase5b-v1` |

The story is read live: if any stable assertion stops holding, the card says the example is outdated instead of
narrating it. No verdict is hardcoded in the UI.

### Routes and entry points

- **Entry:** the landing hero button "Try a mission" (`data-testid="landing-try-mission"`, `App.tsx: tryMission`) and
  the header button "Try a mission" / "Restart the mission" (`TryMissionButton`). `GuideCard` is mounted in `App.tsx`.
- **Stages** (`guide/mission.ts: STAGES`): mission, original plan, launch delay, what changed, inspect the evidence,
  find a recovery, make the decision, summary report. Views used: `#app/planner` and `#app/compare`; Atlas and
  Methodology are separate tabs the story does not force.
- **Consumes core contracts unchanged:** `useAssessmentStore` / `scenarioKey` (assessment), `evidenceForConstraint` and
  `showEvidence` (evidence), `sendToComparison` / `comparisonView` (Comparison), `useReportStore` /
  `reportHooks.mission` (frozen report). Nothing in Comparison, assessment or visualization was edited.
- The feature tutorial and the story never run together (`TutorialOfferChip` is hidden while the story is active).

### Browser verification (real Chrome via playwright-core; exact commands and results)

Environment: Windows 11, Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`), Node 25 (the repo pins 24),
backend on :8000 from this tree, fresh browser profile per run. Exit code is non-zero on any failed expectation, page
error or API 5xx.

| Command (from `frontend/`) | What it is | Result |
|---|---|---|
| `node scripts/e2e-guided.mjs --url http://localhost:5173` | **dev server** + live backend | 60/60 |
| `node scripts/e2e-guided.mjs --serve-dist --api http://127.0.0.1:8000` | **production build** (`dist/`, served by the script) + live backend | 60/60 |
| same, with the backend started as `LUNAR_OFFLINE=1` | production build + **backend offline mode** | 60/60 |
| `node scripts/e2e-time-missing.mjs --url http://localhost:5173` | hourly-grid time consistency + incomplete-data display, 1366x768 and 1920x1080 | 31/31 |

`e2e-guided` covers, at **1366x768 and 1920x1080**: the mission loaded from the committed definition; original PASS; the
Planner plan card's canonical verdict; the delay through Rescue's own change control; the "After change" assessment;
PASS to FAIL on the 118 h blackout; Show why opens the blackout window in 3D; the Rescue recovery re-assessed as PASS;
Comparison recommends it; the frozen report (decision, plans, requirements, uncertainty, attribution); JSON equal to
the snapshot (same id, verdicts, recommendation, dataset hashes, revisions, mission id); A4 and Letter PDF (print
stylesheet); Escape closes the preview; finish; a changed comparison marks the report stale and keeps its snapshot;
regenerate; **repeated restarts create exactly one guided plan card** (user plans preserved); exit; then an Atlas cell
opened in the Planner as the mission the map evaluated, even after the search form was edited without re-mapping (Enter
and button), with the Planner's canonical verdict matching the cell; no page errors; no failed API requests.

`e2e-time-missing` covers: a mission requested at 00:30 UTC for 1.01 d is evaluated at 01:00 UTC for 24 h by the
Comparison, the canonical assessment and Rescue (same verdict), with the request kept distinct from the evaluation and
explained (`time_note`); a temporary 6 h gap (a test copy under `data/sites/custom/`, always removed) gives withheld
whole-mission statistics, 162 of 168 known hours, canonical bounds, its own unknown windows, no darkness or blackout
window across the gap and finite JSON; and in the UI the coverage note, a dataset file and hash, the grey "Unknown (no
data; not darkness or blackout)" stretches on the Sun and Earth lanes, bounds instead of numbers in Key metrics, and no
"best solar" claim.

Two real defects were found by these runs and fixed in the guide (neither is visible to unit tests): the new **Ask
Rover** launcher covered the card's primary button on Comparison at 1366x768, and at 1366 px the card clipped the left
of the evidence banner ("Exit evidence view" read "xit evidence view").

**What these runs do not prove:** the machine was not disconnected and fonts were not blocked, so "offline" means the
backend's offline mode (precomputed site data, no live JPL call), not an air-gapped browser; terrain tiles were not
checked offline (that is `demo-tour.mjs --verify`, unchanged). Browser Back/Forward is exercised only where the scripts
use it (Atlas back to the Planner); there is no dedicated Back/Forward test across the guided stages. The mocked unit
tests (`guide.test.tsx`, which replay real captured API responses) are a separate layer from these real-browser runs.

### Other checks (this milestone)

| Check | Result |
|---|---|
| `npx tsc -b` | clean |
| `npx vitest run` (Node 25 with `NODE_OPTIONS=--no-experimental-webstorage`) | 55 files, 614 tests passed |
| `npx oxlint` | 0 errors, 21 warnings (pre-existing kinds, none in the guide) |
| `npm run build` | OK |
| `pytest tests/test_mission_story.py tests/test_guided_mission.py` | 4 passed |
| milestone 1 backend set (Rescue, demo, Atlas, the 7 former baseline failures) | 210 passed |
| full backend suite on the merged tree | **not run in this milestone** (about 15 minutes); no backend code changed here beyond the new mission-story module and its tests |

### Cross-owner items and dependencies (for the final integrator)

- `frontend/src/features/compare/ReportPreview.tsx` line 280 lists Gracy & Lee (LPSC 2024) as a "Validation reference
  (south-polar illumination of ...)". The Methodology view says it is the **source of two sites' coordinates**, not a
  quantitative validation (`86773a0` fixed the report's wording on the source branch). Not edited here (core-owned file).
- `backend/app/compare/service.py` lines 84-86 and 477-481 say a mission running past the data "can show a fail, never a
  pass"; the engine can prove a pass when the missing hours cannot change it (found in milestone 1). Suggested wording:
  "a verdict only where the hours that exist prove it (usually a fail)".
- At 1366x768 in the Planner the Scene's "Snap" control overlaps the "Methodology" tab text in the header (seen in the
  screenshots; not caused by this work, not fixed).
- The release gate (`scripts/release-gate.mjs`) does not yet run `e2e-guided.mjs` or `e2e-time-missing.mjs`, and the
  production smoke is not run with `--strict` there; that is the final integrator's `66ede4b` work.
- Core recovery is a hard dependency: this branch contains the merge of `recovery/core-remaining` @ `5eb3316`. If the
  core branch changes (assessment store, evidence, report snapshot shape), re-run `e2e-guided.mjs`.
