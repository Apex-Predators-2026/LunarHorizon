> **HISTORICAL: the state at the overnight stop.** Entries such as "LOCAL ONLY" and "NOT integrated" were reconciled against the final code in [final-recovery-ledger.md](final-recovery-ledger.md), which is authoritative.

# Overnight change ledger (45 source commits)

Every source commit is authored by XxHuanghoidSlayerxX (git metadata). Integration SHAs are local commits on `integration/overnight-recovery-20261115-012252`; all integration work is LOCAL ONLY. See `TEAM_HANDOFF.md` and `overnight-progress.md` for validation. Integration-only work with no source commit: grid snap in `/assess-scenario` (2a90183) and the rebase of the Comparison backend onto main's hourly grid (3037d8b).

| # | Source SHA | Subject | Disposition | Integration SHA(s) |
|---|---|---|---|---|
| 1 | `e02f103` | Canonical viability API | newly integrated | 2a90183 |
| 2 | `fbeaaab` | Rescue validated-sample cache | newly integrated | dc55eb9 |
| 3 | `6a4b68f` | Member 2 handoff docs | NOT integrated (docs only; describe unmerged UI) | - |
| 4 | `a932116` | Member 2 UI handoff doc | NOT integrated (docs) | - |
| 5 | `6ae8b5b` | Merge Member 2 A-C | merge, not replayed (contents: e02f103, fbeaaab, 6a4b68f, a932116) | - |
| 6 | `b177ec8` | Atlas spec and plan docs | NOT integrated | - |
| 7 | `19595ca` | Atlas A0 contracts (unmounted library) | NOT integrated; main serves backend/app/atlas | - |
| 8 | `3757d46` | Merge Atlas A0 | merge, not replayed | - |
| 9 | `6fbff54` | Register viability router + smoke test | newly integrated | 2a90183 |
| 10 | `631d489` | Canonical ranking in Comparison | backend score metadata newly integrated; frontend ranking already on main (cc9ecb7), not redone | dc55eb9 |
| 11 | `809c482` | Assessment panel + assess-scenario | backend newly integrated; frontend panel NOT integrated | 2a90183 |
| 12 | `b693a47` | Rescue UNKNOWN sensitivity / what changed | NOT integrated (partly on main via 4ac3442) | - |
| 13 | `1f81e10` | Validation and Methodology view | superseded by main 101ae45; ViabilityChecks section NOT integrated | - |
| 14 | `4ec3363` | Atlas I1 demo slice | NOT integrated (library only) | - |
| 15 | `700b4ca` | Atlas heatmap view | superseded: MDR merge 0f07ca6 removed it in favour of main's Atlas | - |
| 16 | `c6fde69` | Guided mission v1 | NOT integrated | - |
| 17 | `6d616ec` | Merge origin/main | merge, not replayed | - |
| 18 | `3aa7e30` | README, licensing review, submission kit | NOT integrated | - |
| 19 | `00974a5` | Guided mission fix | NOT integrated | - |
| 20 | `4a813d6` | LoadingIndicator crash + e2e-guided | NOT integrated (check LoadingIndicator on main) | - |
| 21 | `c261db9` | README e2e note | NOT integrated | - |
| 22 | `87b6267` | Merge origin/main | merge, not replayed | - |
| 23 | `1c54ea0` | Merge origin/main | merge, not replayed | - |
| 24 | `1b5f5f3` | Show why evidence navigation | backend evidence windows newly integrated; frontend NOT integrated | 3037d8b |
| 25 | `a733b85` | Mission-time policy + missing data | exact-interval policy CONFLICTS with main timegrid and is excluded; missing-data backend and sun_visible newly integrated; SeriesChart part integrated; TimeBar/lanes NOT integrated | dc55eb9, 3037d8b, 737e61d |
| 26 | `ba0a6dd` | Browser check: time + missing data | NOT integrated (targets the exact-interval policy) | - |
| 27 | `5fe43bb` | Merge origin/main | merge, not replayed | - |
| 28 | `489ec99` | Verified mission definition | NOT integrated | - |
| 29 | `06e1c04` | Guided decision workflow | NOT integrated | - |
| 30 | `5c518fe` | Comparison redesign | NOT integrated | - |
| 31 | `62d1357` | Summary report + export rev. 2 | dataset SHA-256 backend integrated; report/export NOT integrated | 3037d8b |
| 32 | `983e54d` | Docs for journey and report | NOT integrated | - |
| 33 | `0f07ca6` | Merge origin/main (Atlas/Methodology dedupe) | merge, not replayed; its dedupe decisions were honoured | - |
| 34 | `802e7ae` | Frontend CI lockfile | newly integrated (cherry-pick -x) | b6e9c17 |
| 35 | `524de77` | Atlas transfer from one evaluated map | NOT integrated | - |
| 36 | `6f2bc5f` | bestPool: real/synthetic never compete | NOT integrated (main's bestIds still drops null values from the pool) | - |
| 37 | `a7213eb` | Atlas exact-interval test | excluded: exact-interval policy | - |
| 38 | `be2c307` | Rescue demo scenario v2 | NOT integrated | - |
| 39 | `9b32a4a` | Plan card canonical decision | intent integrated differently (lib/planVerdict.ts); store and panel not taken | 737e61d |
| 40 | `1de7e73` | Status endpoint uses held sample | superseded by main's _grid_index | - |
| 41 | `86773a0` | Browser polish | NOT integrated | - |
| 42 | `66ede4b` | Release gate labels | NOT integrated | - |
| 43 | `efac9bf` | README and submission docs | NOT integrated | - |
| 44 | `74ab073` | Evaluated mission snapshot | only the 3D cursor fix integrated; missionTime.ts, export v2, cards, assistant context NOT integrated | 87ea09f |
| 45 | `2432dba` | Planner/Playback canonical verdicts | intent integrated differently (737e61d); compare adapter, cache and mission.ts rewrite not taken | 737e61d |

"NOT integrated" means not ported before the stop order. It is not a judgement that the work is wrong.