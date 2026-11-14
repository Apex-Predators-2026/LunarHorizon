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
.venv\Scripts\python.exe scripts\prefetch_tiles.py --imagery
```
- Terrain for the whole globe (coarse), the south-polar region, and the surroundings of all 24 sites down to
  5 m; the PSR / ice overlay; with `--imagery`, the LRO photo mosaic the 3D view fades to when zoomed out.
- Safe to re-run: it reuses what's cached, lists tiles that failed (Moon Trek is sometimes busy), and a second
  run fills them in.
- To skip this on another machine, copy the whole `data/cache/` folder across (about 5 GB: 3.2 GB terrain, 1.8 GB imagery).
- The whole-Moon first view doesn't need the cache: its coarsest terrain and LRO imagery (levels 0-2, 126 tiles
  each) ship with the frontend as `frontend/public/terrain/base.bin` (1.1 MB) and
  `frontend/public/imagery/base.bin` (1.7 MB). Rebuild them only if the terrain or imagery sources or the tiling
  change: `.venv\Scripts\python.exe scripts\build_base_pack.py` (`--only terrain` or `--only imagery` for one).

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
