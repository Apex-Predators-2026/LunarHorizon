# Final recovery progress (branch `integration/final-recovery-20261115`)

Starting point (verified, not trusted from the brief): `origin/main` = `4299b396bf28af407eae51ffa98ed89812145dfb`
(fetched 2026-11-15; local `main` of the primary checkout was still `19aaee5`). The three recovery branches are
ancestors of it (`5eb3316` core, `813e487` workflows, `17275c0` UI/UX: `git merge-base --is-ancestor` all true).
No recovery branch was merged again. Environment: Windows 11, Node 24.16, Python 3.14.10 (the primary checkout's
`.venv`, `PYTHON=` for the gate), Chrome, terrain cache merged into this worktree's git-ignored `data/cache`.

## Baseline on the unmodified starting point (`4299b39`)

| Check | Result |
|---|---|
| Backend `pytest -q -p no:cacheprovider` (`LUNAR_OFFLINE=1`) | **2139 passed, 0 failed, 0 skipped** (671 s). The seven historical failures no longer occur |
| `npx tsc -b` | clean |
| `npx oxlint` | 0 errors, 21 warnings (react-hooks / fast-refresh kinds, none new) |
| `npx vitest run` | 61 files, **658 passed**, 0 failed, 0 skipped |
| `npm run build` | OK |
| Production browser journeys on the unmodified code | guided: **18/19, FAILED** (script could not find the scenario checkboxes, now behind "Manage scenarios"); strict smoke: **6/10, FAILED** (script written for the pre-redesign UI); time/missing: 27/31 (two checks looked for content now behind the "Evidence" tab) |

So the app worked, but **two of the three browser journeys and the gate were stale against the progressive-disclosure
redesign**, and one real layout defect was found by them (below).

## Checkpoint 1: release gate and browser journeys

| Item | State |
|---|---|
| Release gate rebuilt from `66ede4b` (compatible parts) | `scripts/release-gate.mjs` + `scripts/release-gate-lib.mjs` + `scripts/release-gate.test.mjs` |
| Gates | backend tests, frontend tests, TypeScript, lint, production build (all required by default; `--quick` leaves them INCOMPLETE); strict production smoke journey; guided journey (both viewports); hourly-grid / missing-data journey; offline journey with a **proof** the backend is offline; evidence checks for engine PASS / FAIL / UNKNOWN, mission story (including `verify_mission_story.py` replay), Show why, Planner / Playback, Comparison, Atlas, export, frozen report, scientific validation, navigation |
| Skipped / unavailable evidence | INCOMPLETE, never PASS. A test run that skips tests, runs none, or prints no readable summary does not pass. A partial run (`--only`, `--quick`, `--no-browser`) is never a release pass and writes `*-partial*` records that are not committed |
| Source identity | HEAD, branch, uncommitted files and diff hash recorded before and after; dirty tree is not a release pass; a change during the run is INVALID. Port already in use = refuse (never test a foreign backend) |
| Records | exact commands, working directory, env, exit status, counts (passed / failed / skipped), mode of every browser run |
| Gate logic tests | `node --test "scripts/*.test.mjs"` (8 tests; also run by the frontend CI job) |
| `e2e-guided.mjs` | opens "Manage scenarios" before unticking a scenario (the redesign keeps it closed once two are compared) |
| `smoke-prod.mjs` | taken from `66ede4b` (plan-card canonical verdict, `--strict`, run id) and reconciled with the current UI: verdict badge, Comparison "Detailed analysis" tab and closed "Trade-off analysis", Export on the Overview tab, "Feasibility Atlas" tab, Atlas requirement and neighbour disclosures; failures now report the locator waited for. No assertion was weakened |
| `e2e-time-missing.mjs` | `--serve-dist`, `--run-id`, `report.json`; metrics and timeline are checked in the Evidence view |
| Real defect found by the browser run (cross-owner item C) | the Planner's Map / Sky tab pill lay over the "Methodology" tab and the "Try a mission" button at 1366x768 (and over the button at 1600x900). The side column now starts below the header under 1760 px (`Scene.tsx`) |

Browser results on this checkpoint (production build, real Chrome, run through the gate with `--only`): strict smoke
**10/10**, time/missing **31/31**, offline guided **60/60** with the offline proof; guided on the online backend
60/60 (run directly). The full gate on the final commit is recorded in `release-gate/LATEST.md`.

## Checkpoint 2: the cross-owner items (A to E)

| Item | Result | What was done |
|---|---|---|
| A. Report provenance wording | **Fixed** | Gracy & Lee is now described as the source of the Connecting Ridge and Peak Near Shackleton coordinates and explicitly "not a validation of this model" (report preview, report card, `docs/data-sources.md`, `docs/judging-and-submission.md`); the LROC map is described as something the model is compared with. Unit tests pin the wording. `CLAUDE.md` and `AGENTS.md` (assistant instruction files) still list Gracy & Lee as a "validation reference" and were not edited: they should be corrected by their owner |
| B. Partial-coverage explanation | **Fixed** | Checked against the engine: a 3 d mission with one hour past the data PASSES in Comparison, Rescue and Atlas; a long uncovered tail FAILS. "Can show a fail, never a pass" was wrong in `compare/service.py` (docstring, comment, the note shown to users) and in the Mission Assistant's prompt (`assistant/prompt.py`); corrected to the bounded-evidence policy, test comments corrected, new regression test `test_one_missing_hour_can_still_prove_a_pass` |
| C. Responsive header overlap | **Fixed** (found by the browser run) | At 1366x768 the Map/Sky tab pill covered "Methodology" and "Try a mission" (and "Try a mission" at 1600x900). The Planner's side column starts below the header under 1760 px; measured: no overlap at 1366x768, 1600x900, 1760x990 and 1920x1080 |
| D. Assessment evidence return | **Fixed** | "Show in 3D" in a plan's assessment dialog used to return to the running plan's panel. `EvidenceOrigin.returnTo` now reopens that dialog; unit tests, and a real-browser smoke step (Show in 3D, Back, the same dialog reopens) |
| E. Release-gate coverage | **Fixed** | Guided, time/missing and the recovered Show-why journey are required gate evidence; see checkpoint 1 |

## Checkpoint 3: the mission journey against the final code

The journey (load, requirements, delay, changed assessment, Show why, Rescue, Compare, frozen report) is exercised end to end by `e2e-guided.mjs` on the production build at both viewports: **62 of 62 checks**. Added in this recovery: a plan the user saved earlier is seeded and must survive repeated restarts and leaving the guide unchanged; CSV and JSON of a frozen snapshot are two views of one evaluated snapshot (requested and evaluated times in separate columns); two coverage edge cases (one isolated known hour; a window with no known data) never give a PASS, an exact zero or an invented darkness/blackout window. Also recovered (row 24 of the ledger): `e2e-evidence.mjs`, the cross-screen Show-why journey from the Comparison (**30 of 30**).

Edge cases covered by named tests: empty and no-data windows, an isolated known sample, an internal coverage gap, off-grid requested times, delayed missions, partially covered mission windows, missions starting inside and running past the data (`test_timegrid.py`, `test_compare_evidence.py`, `test_rescue_*`, `tests/viability/*`, `missingData.test.tsx`).

## Checkpoint 4: source reconciliation and release-readiness documents

- `final-recovery-ledger.md`: all 45 source commits (38 regular, 7 merges), each with the full SHA, original purpose, disposition, code / test / browser evidence, current equivalent and limitation. 21 integrated, 2 already present, 4 superseded, 3 documentation-only, 1 deliberately excluded, 7 partially recovered, 7 merges without functionality of their own, **0 unresolved**.
- Overnight documents (`TEAM_HANDOFF.md`, the overnight ledger and log) are marked HISTORICAL; their "local only / not integrated" statements were reconciled in the ledger.
- `README.md` rewritten for the final state (status, one time policy, partial-coverage policy, testing, gate, judge walkthrough); `docs/demo-setup.md` covers the journeys and the gate; `docs/rehearsal-checklist.md` recovered from `efac9bf`.

Pre-existing, not caused by this work, recorded not hidden: `ruff check --line-length 120 app/viability tests/viability` reports 5 findings, `ruff format --check` would reformat 2 files and `mypy --strict --follow-imports=silent app/viability tests/viability` reports 7 errors (all in `app/viability/compat/headroom.py` and two test files of the viability package; these checks are documented as optional in `docs/viability-engine.md` and are not in CI or the gate).

## Remaining (updated at each checkpoint)

See the final section of this file once the last checkpoint is written.
