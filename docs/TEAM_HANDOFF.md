> **HISTORICAL (written at the overnight stop on 2026-11-15). Its "local only / not pushed / not integrated" statements are no longer true.** The recovered work reached main through the core, workflow and UI/UX recovery branches; the current account is [integration/final-recovery-progress.md](integration/final-recovery-progress.md) and the per-commit ledger is [integration/final-recovery-ledger.md](integration/final-recovery-ledger.md).

# TEAM HANDOFF - overnight recovery (PARTIAL, local only)

**Status: partially verified, stopped early on the user's instruction. NOT pushed, NOT merged into `main`.**

| | |
|---|---|
| Date | 2026-11-15 |
| Base (`origin/main` at start) | `d2000874f2fc2ff37fbaf8bbde26de0f80b1fc78` (final origin/main was **not** re-fetched) |
| Branch | `integration/overnight-recovery-20261115-012252` (local) |
| Worktree | `C:\Users\b\Documents\Nasa-Space-Apps-Challenge-overnight-20261115-012252` |
| Source work | 45 unpublished commits (7 merges): `feature/mission-decision-report` (43; it contains the evidence-time, final-release and member2 branches), `fix/planner-canonical` (1), `fix/evaluated-times` (1). Frozen SHAs: `docs/integration/overnight-source-manifest.md` |
| New local commits | 6 + this documentation commit (`git log --oneline d200087..HEAD`) |

## What is integrated (new, local only)

| Area | Source | Change | Where |
|---|---|---|---|
| Install / CI | 802e7ae | `npm ci` **fails on current main** (lockfile lacks `@emnapi/*`). Lockfile completed, Node 24 pinned. Cherry-pick `-x`. | `frontend/package-lock.json`, `.nvmrc`, `ci.yml` |
| Canonical viability API | e02f103, 809c482 (backend), 6fbff54 | `POST /api/viability/assess`, `/assess-scenario`, `GET /validation-summary`; router registered | `backend/app/viability/api/`, `main.py` |
| Time consistency | integration work (not in any source) | `/assess-scenario` snaps to the hourly grid (`app/timegrid.py`) so the Planner agrees with Comparison. The new test fails without the snap. | `viability/api/service.py`, `tests/viability/test_api_assess_scenario.py` |
| Comparison backend | 1b5f5f3, a733b85 (missing-data part), 62d1357 (backend part) | Engine evidence windows. A Sun gap no longer erases valid Earth stats, and the reverse. Unknown windows. No rise/set invented at a gap. Chart decimation keeps gaps. Dataset file + SHA-256. | `backend/app/compare/*` |
| Rescue | fbeaaab, a733b85 (part), 631d489 (backend) | Validated-sample cache. Null flags stay unknown. `sun_visible` flag honoured. Canonical score metadata on `ViabilityResult`. | `viability/compat/rescue.py`, `rescue/timeline/*`, `models.py` |
| Planner / Playback | intent of 2432dba and 9b32a4a | Plan cards and Playback never show a client-derived PASS or headroom. Verdict comes from Rescue's canonical result or `/assess-scenario`, else "Not assessed". | `frontend/src/lib/planVerdict.ts`, `plans/PlansPanel.tsx`, `viz/MissionPlayback.tsx` |
| Charts | a733b85 | Step lines that break at unknown samples | `compare/SeriesChart.tsx` |
| Time | intent of 74ab073 | 3D cursor uses the evaluated landing (00:15 becomes 00:00) | `compare/useCompareStore.ts` |

## Already on main, or superseded (not redone)

- Hourly-grid time policy, `evaluated_landing_utc`, `time_note`, Atlas time policy: on main (`timegrid.py`, `3cc2355`, `ada6c42`). **MDR's opposite exact-interval policy (a733b85, a7213eb, `mission_time` POLICY) was deliberately NOT integrated.**
- Canonical ranking in Comparison (cc9ecb7), Validation & Methodology view (101ae45), Atlas served from `backend/app/atlas`: on main. MDR's own merge `0f07ca6` had already chosen these.
- `1de7e73` (status uses the held sample): superseded by main's `_grid_index`.

## NOT integrated (only on the source branches)

Decision-first Comparison, bestPool, summary report, export rev. 2 (5c518fe, 6f2bc5f, 62d1357, 983e54d). Assessment panel and Show-why navigation (809c482, 1b5f5f3). Rescue UNKNOWN sensitivity and demo scenario (b693a47, be2c307). Methodology viability checks (1f81e10). Atlas library and session fixes (b177ec8, 19595ca, 4ec3363, 700b4ca, 524de77). Guided "Try a mission" (c6fde69, 00974a5, 489ec99, 06e1c04, 4a813d6). TimeBar and lane unknown bands (UI part of a733b85). Evaluated-time snapshot in cards, export and assistant (rest of 74ab073). README, release gate, e2e scripts, submission docs (3aa7e30, c261db9, 66ede4b, efac9bf, ba0a6dd). Per-commit table: `docs/integration/overnight-change-ledger.md`.

## Risks and review priorities

1. **Full suites were not run on HEAD** (table below). Baseline on main: backend 2033 pass and **7 pre-existing failures**; frontend 381 pass.
2. Backend `CompareResult` now returns `solar`/`power` and `earth` independently null. The frontend tolerates null per field, but nothing displays `withheld`, `sun_known_hours` or `unknown_windows` yet.
3. **Main still draws unknown time as darkness** on the 3D TimeBar (`visible_fraction ?? 0`) and in the Comparison lanes. This is a scientific-display defect that was not fixed here (source fix: a733b85, `viz/TimeBar.tsx`, `compare/lanes.ts`).
4. Two tests that pinned the old client-side PASS were rewritten (`viz/MissionPlayback.test.tsx`). The Planner owner should review that change.
5. `docs/viability-api.md` describes the API accurately for this branch. Other MDR docs describe features that are not here.
6. The new cursor test (`compare.test.tsx`) was not mutation-checked against the old line.
7. Likely reviewers by commit history (not assigned): Comparison (the "Vision for Change" commits), Rescue and time policy (Arush), Planner and 3D (Andrew, FRCJavisT).

## Verification actually performed

| Check | Result |
|---|---|
| Baseline d200087, backend full | 2033 passed, 7 failed (all pre-existing, verified on a pristine `git archive` copy) |
| Baseline frontend vitest / oxlint / build | 381 passed / 0 errors / OK, after the G0 lockfile (`npm ci` fails without it) |
| After G1a, rescue/compat targeted | 180 passed, the same 7 pre-existing failures |
| After G1b, API tests | 60 passed, plus the new grid test (verified to fail without the snap) |
| After comparison backend: timegrid, compare, assistant, assess-scenario | 66 passed |
| Frontend `tsc -b` on HEAD | clean |
| `vitest src/features/compare` on HEAD | 127 passed |
| `vitest src/viz src/features/plans` after 737e61d | 150 passed |
| oxlint after 737e61d | no errors (11 pre-existing warnings in `RoverFlag.tsx`) |
| **Full backend on HEAD** | **NOT COMPLETED** (a started run produced no result) |
| **Full vitest, `npm run build`, browser/e2e on HEAD** | **NOT RUN** |

## Review commands (read-only; none of these touch `main`)

```powershell
cd C:\Users\b\Documents\Nasa-Space-Apps-Challenge-overnight-20261115-012252
git log --oneline d200087..HEAD
git diff --stat d200087..HEAD
git show --stat <sha>
git diff d200087..HEAD -- backend/app/compare frontend/src/viz/MissionPlayback.tsx

# re-run checks inside the worktree (.venv and node_modules are local to it)
cd backend; $env:LUNAR_OFFLINE=1; ..\.venv\Scripts\python -m pytest -q -p no:cacheprovider
cd ..\frontend; npx tsc -b; npx vitest run; npx oxlint; npm run build

# source branches (unchanged)
git log --oneline d200087..feature/mission-decision-report
git log -1 fix/planner-canonical
git log -1 fix/evaluated-times
```

To share it later (needs the user's approval, not done): push this branch and open a PR, or cherry-pick single commits. Do not merge the source branches wholesale. They predate main's time policy and conflict in 6 files (`compare/service.py`, `main.py`, `rescue/engine.py`, `AtlasView.tsx`, `ComparisonDashboard.tsx`, `Landing.tsx`).

## Resume

Read `docs/integration/overnight-progress.md` ("STATE AT STOP"). Next, in order: full backend and frontend runs on HEAD, TimeBar unknown band, Rescue UNKNOWN sensitivity (G4), Methodology checks (G5), decision-first Comparison (G2 frontend). `TEAM_MESSAGE_DRAFT.md` and `OVERNIGHT_INTEGRATION_REPORT.md` were **not** produced.
