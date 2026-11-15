> **HISTORICAL: the overnight log.** Later work (core, workflow and UI/UX recovery, then the final recovery) superseded its "not done" list; see [final-recovery-progress.md](final-recovery-progress.md) and [final-recovery-ledger.md](final-recovery-ledger.md).

# Overnight recovery - progress log

Resume here. Baseline/SHAs: `docs/integration/overnight-source-manifest.md`. Per-commit disposition:
`docs/integration/overnight-change-ledger.md`.

Environment (inside this worktree only): `.venv/` (Python 3.14, `backend/requirements.txt`), `frontend/node_modules`
(`npm ci`). Backend tests: `cd backend && LUNAR_OFFLINE=1 ../.venv/Scripts/python -m pytest -q -p no:cacheprovider`.
Frontend: `cd frontend && npx vitest run && npx oxlint && npm run build`.

## Baseline results (d200087)

| Check | Result |
|---|---|
| `npm ci` | **FAILS** on baseline: lockfile missing `@emnapi/core` / `@emnapi/runtime` (pre-existing; fixed by G0) |
| vitest (baseline code + G0 lockfile only) | 40 files, 381 tests passed |
| oxlint | 0 errors (warnings in `src/viz/RoverFlag.tsx`) |
| `npm run build` (tsc -b + vite) | OK |
| backend pytest (full) | 2033 passed, 7 failed (451 s) - the 7 listed below |
| Pre-existing backend failures (verified on a pristine `git archive d200087` copy) | 7: `test_real_sites_phase6_compat.py::{test_rescue_withholds_verdicts_outside_coverage[landing1,landing2], test_canonical_bounded_policy_can_prove_what_rescue_withholds, test_last_sample_hour_is_unknown_never_flipped, test_rescue_past_end_of_data_stays_unknown_on_canonical_engine}`, `test_phase6_rescue_compat.py::test_missions_shorter_than_two_samples_evaluate[0.48,1.44]` - caused by main's `ada6c42`/`3cc2355` (Rescue judges partial missions on covered hours; durations snapped) without updating these tests |

## Key audit decisions

1. **Time policy (conflict).** Main's `backend/app/timegrid.py` (teammate `3cc2355` 22:55, `ada6c42` 23:22) rounds
   landing to nearest UTC hour / duration to whole hours, reports `evaluated_landing_utc`, `evaluated_duration_days`,
   `time_note`, and judges missions running past data end on covered hours (FAIL provable, never PASS). MDR's
   `backend/app/mission_time.py` (`a733b85` 20:57, `a7213eb` 23:25) evaluates the exact interval and never rounds.
   MDR last synced main at `16de7cf` (22:51) and never saw timegrid. The user's own later EVT commit (`74ab073`,
   00:04) builds on main's grid. **Decision: main's grid policy stays authoritative; MDR's exact-interval policy is
   not reintroduced.** Separable missing-data improvements from a733b85 are ported on top of the grid.
2. **Atlas.** Already decided by the user in MDR merge `0f07ca6`: the team's `backend/app/atlas` is served at
   `/api/atlas`; `backend/app/viability/atlas` is an unmounted, tested library. Honour that.
3. **Methodology.** Decided in `0f07ca6`: one view (team's MethodologyView) + MDR's `ViabilityChecks` section.
4. **Planner verdict source.** PLN (`2432dba`, compare-based adapter) and MDR `9b32a4a` (assessment store over
   `/api/viability/assess-scenario`) implement the same plan-card behaviour. Only one may survive: MDR's assessment
   store (it also powers MissionAssessment, guided mission, Show why). `assess_request_for_scenario` must apply
   main's timegrid so Planner == Comparison == Rescue == Atlas.
5. **Mission Playback.** Both main and MDR still manufacture a client-side PASS (`MissionPlayback.tsx`:
   `track.failures.length>0 ? 'fail' : unknownHours>0 ? 'unknown' : 'pass'`). PLN fixes it. Port: PLN's descriptive
   `viz/mission.ts`, drop `deriveHeadroomFromTrack`, small adapter from MDR's AssessResponse (threshold in seconds,
   windows in UTC → hours), playback reads the assessment store.
6. **EVT (`74ab073`).** Keep MDR's additive export (`comparison-export-v1` rev. 2, `landing_utc`/`duration_days`
   kept as requested values, report tests depend on it); skip EVT's v2 bump. Port EVT's evaluated-snapshot idea on
   main's `evaluated_landing_utc`/`evaluated_duration_days`/`time_note`: axis/cursor origin, cards, Rescue story,
   editor "requested" labels, assistant context/fallback.
7. **Missing data (main gaps).** Main draws unknown as darkness on the 3D TimeBar (`visible_fraction ?? 0`, Earth
   `visible === true`), Comparison charts connect across nulls (`connectNulls`), lanes show unknown as dark, and a
   Sun gap withholds valid Earth statistics. Port separable parts: TimeBar unknown band, SeriesChart step/no-connect,
   per-body withholding + unknown windows + gap-safe events + bucket-aware decimation, `bestPool`.
8. **`1de7e73`** (status endpoint uses held sample) only makes sense with MDR's held-sample 3D view → superseded by
   main's `_grid_index` (grid policy).

## STATE AT STOP (user ordered stop; usage nearly exhausted)

Integration branch `integration/overnight-recovery-20261115-012252`, base `d200087` (= origin/main). Nothing pushed.
Working tree clean except the untracked instruction file `OVERNIGHT_MASTER_PROMPT.md` (never commit) and
`docs/integration/` (these notes, committed with the handoff).

### Local commits (oldest first)

| SHA | Group | What |
|---|---|---|
| b6e9c17 | G0 | cherry-pick -x of 802e7ae: complete frontend lockfile (`npm ci` fails on main without it) + `.nvmrc`, CI Node pin |
| dc55eb9 | G1a | Rescue compat validated-sample cache (fbeaaab), canonical score metadata on ViabilityResult (631d489 backend), null flags stay unknown + `sun_visible` flag (a733b85 missing-data part) |
| 2a90183 | G1b | `/api/viability/assess`, `/assess-scenario`, `/validation-summary` (e02f103, 809c482 backend, 6fbff54) + router registration + grid snap in `assess_request_for_scenario` + regression test |
| 3037d8b | G2/G8 backend | Comparison backend: engine evidence windows (1b5f5f3), per-body missing-data withholding, unknown windows, gap-safe events, bucket-aware decimation (a733b85 part), dataset file + SHA-256 (62d1357 backend); rebased onto main's hourly grid |
| 737e61d | G3/G8 frontend | No client-side PASS on plan cards and Mission Playback (`lib/planVerdict.ts`), SeriesChart steps/no-connect over unknown, nullable engine gap values |
| 87ea09f | G9 (part) | 3D-view cursor uses the evaluated hourly-grid landing |

### Last tested stable checkpoint

Backend: after 3037d8b the targeted run `tests/test_timegrid.py tests/viability/test_api_assess_scenario.py
tests/test_compare*.py tests/test_assistant.py` = **66 passed**; after 2a90183 `test_api_viability.py +
test_api_assess_scenario.py + test_api.py` = **60 passed + 1 fixed**; after dc55eb9 the rescue/compat targeted run =
**180 passed, 7 failed (the 7 pre-existing)**.
**The full backend suite was NOT completed on the final tree.** A full run was started after 3037d8b; its output
file stopped partway and no result was recorded. Treat full-suite status of HEAD as **unverified**.
Frontend (HEAD 87ea09f): `npx tsc -b` clean; `npx vitest run src/features/compare` 127 passed; after 737e61d
`src/viz src/features/plans` 150 passed. **Full vitest, `npm run build`, browser/e2e were NOT run on HEAD.**
oxlint after 737e61d: no errors (11 pre-existing warnings, RoverFlag.tsx).

### Not done

G2 frontend (decision-first Comparison, bestPool, report), G3 full (assessment panel, Show-why, evidence banner),
G4 Rescue UNKNOWN sensitivity, G5 Methodology checks, G6 Atlas, G7 guided mission, G8 TimeBar/lane unknown bands,
G9 rest (evaluated snapshot in cards/export/assistant), G10 docs/README/release-gate, final merge of newer origin/main.
`git fetch origin` was not repeated after the start; final origin/main SHA not recorded.

### Known risks created by this branch

- Backend CompareResult now omits `solar`/`power` when only the Sun is unknown and `earth` when only Earth is
  unknown (before: all-or-nothing). Frontend tolerates null per field, but UI copy for "withheld" reasons
  (`withheld`, `sun_known_hours`, `unknown_windows`) is not rendered anywhere yet.
- `app/mission_time.py` is now a helper used only by compare; Rescue's engine on main still snaps its own way
  (same grid, no behavioural change expected, but untested on the full suite).
- Two tests that pinned the old client-side PASS were replaced (MissionPlayback.test.tsx); review that change.
- The new cursor test was not mutation-checked.
