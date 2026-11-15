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
