# Overnight recovery - source manifest

Frozen at session start, 2026-11-15 (~01:25 local). All audit work uses these SHAs, not branch names.

## Baseline

| Item | Value |
|---|---|
| Repository | `C:\Users\b\Documents\Nasa-Space-Apps-Challenge` (remote `origin` = github.com/Apex-Predators-2026/Nasa-Space-Apps-Challenge) |
| Integration worktree | `C:\Users\b\Documents\Nasa-Space-Apps-Challenge-overnight-20261115-012252` |
| Integration branch | `integration/overnight-recovery-20261115-012252` (local only, never pushed) |
| Starting `origin/main` (after `git fetch origin`) | `d2000874f2fc2ff37fbaf8bbde26de0f80b1fc78` |
| Integration branch original `HEAD` | `d2000874f2fc2ff37fbaf8bbde26de0f80b1fc78` (== origin/main; created from it) |
| Initial worktree state | clean except untracked `OVERNIGHT_MASTER_PROMPT.md` (instruction file; never committed) |

## Frozen source branch tips

| Short | Branch | Tip SHA | Ahead of baseline | Merge-base with baseline |
|---|---|---|---|---|
| MDR | `feature/mission-decision-report` | `efac9bf36164038051e044c033990dab071e020c` | 43 | `16de7cf` |
| PLN | `fix/planner-canonical` | `2432dba7f3e3f3155f1378f72d3b9aeb48a412e9` | 1 | `3c1208e` |
| EVT | `fix/evaluated-times` | `74ab07386782122417641f3c332b9b44c2bf84c5` | 1 | `3c1208e` |
| ETM | `feature/evidence-time-missing-data` | `ba0a6dd21026282a1e9617a31e3d10e8e70f3a74` | 26 | `7aefa61` |
| FR | `integration/final-release` | `87b6267b3b7ced06649e65b9a4736521c5346908` | 22 | `b6e2aab` |
| M2 | `feature/member2-post-audit` | `a93211609f6786619b8aeeee9130a689fa0d5a23` | 4 | `a2add64` |

None of the source branches exist on `origin`.

### Containment (verified with `git merge-base --is-ancestor`)

`M2 ⊂ FR ⊂ ETM ⊂ MDR`. Every commit on M2/FR/ETM is also on MDR. PLN and EVT are single commits on top
of main's `3c1208e` and are **not** on MDR (they were written against main, in parallel with MDR's tip).

### Deduplicated unpublished set

`git rev-list efac9bf 2432dba 74ab073 ba0a6dd 87b6267 a932116 ^d200087` → **45 unique commits** (38 regular,
7 merges). This matches the reported "approximately 45" exactly: 43 (MDR, which subsumes ETM/FR/M2) + 1 (PLN)
+ 1 (EVT). Adding the per-branch ahead counts (43+1+1+26+22+4 = 97) would double-count.

`git cherry` reports **no** source commit as patch-equivalent to anything on main (all `+`).

### Main topology note (why "behind" counts look huge)

`git rev-list --count efac9bf..d200087` = 158, but most of that is a **duplicate lineage**: main contains both
`16de7cf` and a rebased copy `a86db2f` with an **identical tree** (`a9a92727…`). The genuine teammate delta that
MDR has not seen is `git diff 16de7cf d200087` - **39 files** (Mission Assistant, landing polish, the
`timegrid` one-time-policy work, atlas/compare/rescue time-policy edits). MDR's own net contribution is
`git diff 16de7cf efac9bf` - **182 files, +49 706 / −1 070** (most of the line count is JSON fixtures and
`data/validation/viability_validation.json`).

A non-destructive trial merge (`git merge-tree --write-tree d200087 efac9bf`) conflicts in only 6 files:
`backend/app/compare/service.py`, `backend/app/main.py`, `backend/app/rescue/engine.py`,
`frontend/src/features/atlas/AtlasView.tsx`, `frontend/src/features/compare/ComparisonDashboard.tsx`,
`frontend/src/features/landing/Landing.tsx`.

## Related earlier integration session (reference only)

`integration/planner-canonical-evaluated-times` @ `f242c29` in
`C:\Users\b\Documents\Nasa-Space-Apps-Challenge-integration` (clean working tree at inspection time):
`8c1235d` (port of 2432dba) and `f242c29` (port of 74ab073) on top of `d200087`. Not modified; used only as a
reference for how PLN/EVT apply to main. Its correctness is verified independently here.

## Uncommitted work in source worktrees (inspected with `git --no-optional-locks status`, nothing modified)

| Worktree | Branch / HEAD | Uncommitted / untracked | Disposition |
|---|---|---|---|
| `Nasa-Space-Apps-Challenge` (main checkout) | MDR `efac9bf` | none | - |
| `.claude/worktrees/evidence-time-missing` | ETM `ba0a6dd` | 18 untracked files under `.e2e-output/` (PNG screenshots + `report.json`) | Generated e2e output - not recovered |
| `.claude/worktrees/member2-post-audit` | M2 `a932116` | none | - |
| `Nasa-Space-Apps-Challenge-planner` | PLN `2432dba` | none | - |
| `Nasa-Space-Apps-Challenge-times` | EVT `74ab073` | none | - |
| `nasa-run` | detached `983e54d` (an MDR commit) | `backend.log`, `frontend.log` | Run logs - not recovered |

`integration/final-release` has no checked-out worktree.

Other local branches (`worktree-phase4-*`, `worktree-phase5-*`, `worktree-phase6-*`, `worktree-part2-*`,
`worktree-atlas-a1-core`, `worktree-atlas-a2-windows`, `feature/feasibility-atlas`, `feature/viability-algorithm`)
were checked: `worktree-atlas-*` and `feature/feasibility-atlas` point at `19595ca`, which is already in the
inventory; the phase/part2 branches are ancestors of main's history (pre-existing published work). They add no
commits outside this set.

## The 45 commits (topological order)

Columns: SHA · parents · branches containing it · subject. Full per-commit disposition lives in
`docs/integration/overnight-change-ledger.md`.

| # | SHA | P | Branches | Subject |
|---|---|---|---|---|
| 1 | `e02f103` | 1 | MDR ETM FR M2 | Add canonical viability assessment API and validation summary (Member 2) |
| 2 | `fbeaaab` | 1 | MDR ETM FR M2 | Speed up Rescue compatibility layer with a validated-sample cache (Member 2) |
| 3 | `6a4b68f` | 1 | MDR ETM FR M2 | Add Member 2 integration handoffs: comparison, UI and main.py registration |
| 4 | `a932116` | 1 | MDR ETM FR M2 | Point Member 2 UI handoff at Andrew's evidence.ts "Show me why" helper |
| 5 | `6ae8b5b` | 2 | MDR ETM FR | Merge Member 2 Checkpoints A-C (viability API, Rescue cache, handoffs) into integration |
| 6 | `b177ec8` | 1 | MDR ETM FR | docs(atlas): Mission Feasibility Atlas design and implementation plan |
| 7 | `19595ca` | 1 | MDR ETM FR | feat(atlas): A0 contracts, protocols and test helpers for the Mission Feasibility Atlas |
| 8 | `3757d46` | 2 | MDR ETM FR | Merge Mission Feasibility Atlas A0 (contracts, spec, plan) into integration |
| 9 | `6fbff54` | 1 | MDR ETM FR | Register canonical viability API router in app.main with smoke test |
| 10 | `631d489` | 1 | MDR ETM FR | Fix comparison ranking to follow the canonical viability contract |
| 11 | `809c482` | 1 | MDR ETM FR | Add Mission assessment panel with canonical 'Show why' evidence navigation |
| 12 | `b693a47` | 1 | MDR ETM FR | Rescue: preserve UNKNOWN in sensitivity, explain what changed, link to comparison |
| 13 | `1f81e10` | 1 | MDR ETM FR | Add Validation & Methodology view built from the stored validation reports |
| 14 | `4ec3363` | 1 | MDR ETM FR | feat(atlas): I1 demo slice - grid, evaluator, windows, durations, build, demo and /api/atlas |
| 15 | `700b4ca` | 1 | MDR ETM FR | Add Mission Feasibility Atlas view: landing-date x duration heatmap |
| 16 | `c6fde69` | 1 | MDR ETM FR | Add 'Try a mission': a guided real-data mission through the actual tools |
| 17 | `6d616ec` | 2 | MDR ETM FR | Merge origin/main (Member 4 canonical comparison ranking, Rescue fast path and walkthrough, landing refresh) into integration |
| 18 | `3aa7e30` | 1 | MDR ETM FR | Add README, asset/licensing review and submission kit |
| 19 | `00974a5` | 1 | MDR ETM FR | Guided mission: keep the delayed plan in view until the Rescue step; clear the time strip |
| 20 | `4a813d6` | 1 | MDR ETM FR | Fix LoadingIndicator crash on first frame; add browser end-to-end journey check |
| 21 | `c261db9` | 1 | MDR ETM FR | README: document the browser end-to-end journey check |
| 22 | `87b6267` | 2 | MDR ETM FR | Merge origin/main (comparison canonical metric states and evidence, guided tutorial, offline JPL checks) into integration |
| 23 | `1c54ea0` | 2 | MDR ETM | Merge origin/main (URL routes, comparison sections, camera poses) into evidence/time/missing-data work |
| 24 | `1b5f5f3` | 1 | MDR ETM | Show why: reliable evidence navigation into the 3D view from any screen |
| 25 | `a733b85` | 1 | MDR ETM | One mission-time policy across tools; missing data stays unknown end to end |
| 26 | `ba0a6dd` | 1 | MDR ETM | Browser check: one mission across tools and incomplete data in API and UI |
| 27 | `5fe43bb` | 2 | MDR | Merge origin/main (decision evidence, Rescue story, JSON/CSV export) with the evidence/time/missing-data work |
| 28 | `489ec99` | 1 | MDR | Verified, versioned mission definition for "Try a mission" with a replay check |
| 29 | `06e1c04` | 1 | MDR | "Try a mission": a guided decision workflow over the live tools, driven by the verified definition |
| 30 | `5c518fe` | 1 | MDR | Comparison redesign: the first screen answers the decision |
| 31 | `62d1357` | 1 | MDR | Summary report: a frozen snapshot of the evaluated comparison, with print / save-as-PDF and matching JSON |
| 32 | `983e54d` | 1 | MDR | Docs for the guided mission journey and summary report; lint fixes in the mission verifier |
| 33 | `0f07ca6` | 2 | MDR | Merge origin/main (CI, release gate, Atlas, Methodology, At a glance, tour, assistant, headroom) with the mission story, report and evidence/time work |
| 34 | `802e7ae` | 1 | MDR | Fix frontend CI: complete the lockfile so npm ci accepts it |
| 35 | `524de77` | 1 | MDR | Atlas: a transferred mission comes from one evaluated map; narratives keep PASS / FAIL / UNKNOWN / NOT_EVALUATED apart |
| 36 | `6f2bc5f` | 1 | MDR | Comparison: real and synthetic results never compete for "best"; bounds and missing values cannot fake a lead |
| 37 | `a7213eb` | 1 | MDR | Mission time: the Feasibility Atlas evaluates the same exact interval as the assessment and Comparison |
| 38 | `be2c307` | 1 | MDR | Rescue demo scenario: explicit requirements and recomputed numbers |
| 39 | `9b32a4a` | 1 | MDR | Planner: each plan card shows its canonical decision; "Running" no longer stands in for feasibility |
| 40 | `1de7e73` | 1 | MDR | Site status answers for the held sample, so the 3D view's next sunset / Earthset appear between hours |
| 41 | `86773a0` | 1 | MDR | Polish from the 1366x768 / 1920x1080 browser review |
| 42 | `66ede4b` | 1 | MDR | Release gate: labels match what each check proves; strict browser journeys on the production build |
| 43 | `efac9bf` | 1 | MDR | README and submission docs for the integrated release |
| 44 | `74ab073` | 1 | EVT | Comparison: one evaluated mission snapshot everywhere (backend-evaluated time, request kept separately) |
| 45 | `2432dba` | 1 | PLN | Planner and Mission Playback: canonical verdicts only, no client-side PASS |
