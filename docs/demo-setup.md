# Running the demo

Everything the app shows comes from NASA data: precomputed site files in `data/sites/` (in git) and terrain /
imagery downloaded from Moon Trek on demand and cached in `data/cache/` (git-ignored). The steps below make a
machine demo-ready, so judging never waits on (or depends on) Moon Trek.

## 1. Install (once)
```
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt

cd ..\frontend
npm install
```

## 2. Warm the data cache (once per machine, ~10-30 min the first time)
```
cd backend
.venv\Scripts\python.exe scripts\prefetch_tiles.py
```
- Terrain for the whole globe (coarse), the south-polar region, a wider ring to 67°S at medium detail (what the
  view shows near the limb from high up; `--limb-lat`, `--limb-zoom`), the whole south face to level 6
  (`--face-zoom`), and the surroundings of all 24 sites down to 5 m; the PSR / ice
  overlay; the LRO photo mosaic the 3D view fades to when zoomed out (`--no-imagery` skips it); the JPL/NAIF
  kernels custom pins need.
- Safe to re-run: it reuses what's cached, lists tiles that failed (Moon Trek is sometimes busy), and a second
  run fills them in.
- To skip this on another machine, copy the whole `data/cache/` folder across (about 8 GB: 4.5 GB terrain, 3.5 GB
  imagery; imagery blocks fetched from now on are stored as bytes, ~4x smaller, and older ones still load).
- `scripts\prefetch_tiles.py --check` downloads nothing: it goes through the same tiles offline and lists any that
  aren't cached at full resolution.
- The whole-Moon first view doesn't need the cache: its coarsest terrain and LRO imagery (levels 0-2, 126 tiles
  each) ship with the frontend as `frontend/public/terrain/base.bin` (1.1 MB) and
  `frontend/public/imagery/base.bin` (1.7 MB). Rebuild them only if the terrain or imagery sources or the tiling
  change: `.venv\Scripts\python.exe scripts\build_base_pack.py` (`--only terrain` or `--only imagery` for one).

### Offline demo: warm it, then prove it
The prefetch covers areas; the demo tour covers exactly what a demo shows. For each south-polar demo site it goes
through every camera view, a zoom out to the whole Moon and back, the top-down toggle and the shadows across a
real sunset, in a real browser (Chrome or Edge; set `CHROME_PATH` if it isn't found), with the app running:
```
cd frontend
node scripts/demo-tour.mjs                    # online: everything it shows gets cached by the backend
```
Then prove nothing else is needed: restart the backend offline and run the tour again.
```
cd backend
set LUNAR_OFFLINE=1                           # PowerShell: $env:LUNAR_OFFLINE=1
.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000

cd frontend
node scripts/demo-tour.mjs --verify           # fails, listing them, if any request needed a download
```
With `LUNAR_OFFLINE=1` the backend serves only cached data (Moon Trek, JPL Horizons and NAIF downloads fail at
once), so a clean `--verify` means the demo runs with no network. One exception: offline, a 3D terrain tile
whose fine data isn't cached is drawn from the next coarser cached product (logged as a warning by the backend)
rather than failing, so `--verify` doesn't flag those; `prefetch_tiles.py --check` does. A custom pin whose
terrain isn't cached answers 503 with an explanation. Options: `--sites a,b` (default: the 8 Artemis
region sites, the Shackleton control, IM-1, IM-2), `--check-horizon` (also compares the 3D terrain's skyline with
the engine's horizon), `--out dir` (screenshots of every stop and report.json; default `tour-output/`).
The tour also fails on any uncaught error in the page.
The UI font comes from Google Fonts: offline the UI falls back to a system font (looks slightly different, works).

### Two checks, two questions
| Check | Question it answers | How it drives the app |
|---|---|---|
| `node scripts/demo-tour.mjs` (terrain-cache tour) | Do the demo's views load their terrain, imagery and data (from the cache, with `--verify`)? | The **dev server**: steers the app through its stores (sites, times, camera); a diagnostic tool |
| `node scripts/smoke-prod.mjs` (production smoke test) | Can a user, on the **production build**, open the app, assess a site, plan missions, run one, investigate it in 3D, rescue it after a launch slip, compare and export plans, find a landing date in the Feasibility Atlas and send it to the Planner, and come back? | Builds and serves `dist/` (or `--url` for a deployed copy); only clicks, types and reads the interface |

A passing dev tour doesn't show that the built app works; run the smoke test before a demo or after a deploy:
```
cd frontend
node scripts/smoke-prod.mjs                   # backend on port 8000 (--api to change); --no-build reuses dist/
```
It fails (exit 1) on a failed step, any uncaught page error or any API 5xx, with a screenshot of the failing
step and `smoke-output/report.json`. A step the app doesn't offer at all (none at the moment) is
listed as MISSING; `--strict` fails on that too. `--online` adds the live JPL Horizons check.

### Release gate (before a release; then freeze features)
```
node scripts/release-gate.mjs --full          # full suites, then every gate check (from the repository root)
node scripts/release-gate.mjs --only atlas    # after a fix: re-run just the affected checks
```
Each check is tied to the tests or browser steps that prove it: real passing mission, real failed mission,
UNKNOWN mission, Comparison, Atlas, Report, Navigation, Production demo (production build, fresh browser) and
Offline fallback (the same journey against a `LUNAR_OFFLINE=1` backend, with its stated limitations). It starts its
own backends (ports 8011, 8012) and writes `release-gate/LATEST.md` plus a JSON record with the commit: commit
those with the release. A run with uncommitted changes, skipped or only some checks is not a release pass.
GitHub Actions (`.github/workflows/ci.yml`) runs the plain build and tests on every push.

## 3. Run
Two terminals:
```
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000

cd frontend
npm run dev
```
Open http://localhost:5173 (Vite forwards `/api` to the backend on port 8000).

## After pulling changes
- **Restart the backend** unless it runs with `--reload`: uvicorn without it keeps serving the old code.
  The frontend still draws terrain from an older backend, but newer features (e.g. seamless tile lighting,
  the zoomed-out imagery) need the matching backend.
- If someone regenerated the site files (`scripts/precompute.py`), just pull: they are in git.
- Re-run step 2 only if new sites or areas were added.

## Data range
Site files cover **2026-01-01 to 2031-01-01**, hourly (Horizons + LOLA). Times outside that are clamped in the
3D view and reported as "unknown" by the planning tools. Custom pins (drop pin / typed coordinates) are computed
on demand for the same range.

## Weak hardware
Use the Graphics menu in the map toolbar: **Low (Chromebook)** skips shadows, the rover model and most terrain
detail. "Far shadows" is an optional extra for capable machines.
