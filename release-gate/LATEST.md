# Release gate: latest run

- **Commit:** `fd5f2e1dd90e5ed78113119446c315958090345d` **plus uncommitted changes** (commit them and re-run before releasing)
- **Run:** 2026-11-15T02:59:19.753Z to 2026-11-15T03:00:37.704Z (win32, node v24.12.0)
- **Result:** FAILED

| Check | Required outcome | Result | Evidence |
|---|---|---|---|
| Real passing mission | Correct verdict, metrics, and explanation | pass | pytest 4 test target(s): pass |
| Real failed mission | Correct violated requirement and evidence | pass | pytest 4 test target(s): pass |
| UNKNOWN mission | No fabricated zero values or false failure | pass | pytest 6 test target(s): pass<br>vitest src/features/compare/compare.test.tsx -t "UNKNOWN": pass |
| Comparison | Eligible ranks, honest groups, consistent times | pass | pytest 1 test target(s): pass<br>vitest src/features/compare/compare.test.tsx: pass |
| Atlas | Selected cell opens the matching mission | pass | pytest 1 test target(s): pass<br>vitest src/features/atlas/atlas.test.ts: pass |
| Report | Matches the evaluated snapshot | pass | pytest 2 test target(s): pass<br>vitest src/features/compare/export.test.tsx: pass |
| Navigation | No route collisions or lost scenarios | pass | vitest src/appRoute.test.ts: pass |
| Production demo | Works from a fresh browser | FAIL | skipped (--no-browser): skipped () |
| Offline fallback | Prepared demonstration works with stated limitations | FAIL | skipped (--no-browser): skipped ()<br>*Limitations:* Backend with LUNAR_OFFLINE=1: only cached terrain and precomputed data; the live JPL Horizons check and custom pins outside the cache are unavailable (the app says so); the UI font falls back to a system font. |

Raw results: `release-gate/gate-2026-11-15T02-59-19-fd5f2e1d.json`. Re-run: `node scripts/release-gate.mjs` (`--only <ids>` after a fix).
