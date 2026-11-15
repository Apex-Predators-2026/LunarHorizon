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

## Remaining (updated at each checkpoint)

See the final section of this file once the last checkpoint is written.
