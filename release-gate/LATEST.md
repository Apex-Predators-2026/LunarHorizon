# Release gate: latest run

- **Commit:** `2d77acff501a412f754fb98140d98d8ff6e3e9ff`
- **Run:** 2026-11-15T03:15:24.657Z to 2026-11-15T03:18:12.934Z (win32, node v25.9.0)
- **Result:** INCOMPLETE (checks skipped or not selected: not a release pass) (only: production, offline)

| Check | Required outcome | Result | Evidence |
|---|---|---|---|
| Production demo | Works from a fresh browser | pass | whole journey (10 steps, fresh browser, production build): pass |
| Offline fallback | Prepared demonstration works with stated limitations | pass | whole journey (10 steps, offline backend): pass<br>*Limitations:* Backend with LUNAR_OFFLINE=1: only cached terrain and precomputed data; the live JPL Horizons check and custom pins outside the cache are unavailable (the app says so); the UI font falls back to a system font. |

Raw results: `release-gate/gate-2026-11-15T03-15-24-2d77acff.json`. Re-run: `node scripts/release-gate.mjs` (`--only <ids>` after a fix).
