# Lunar Landing Site Navigator

A web tool for the 2026 NASA Space Apps Challenge *Lunar Landing Site Navigator*. It helps mission planners,
educators and the public compare Moon south-pole landing sites and dates by showing, hour by hour, whether the Sun
lights the lander's solar panels and whether Earth is above the local terrain horizon for direct-to-Earth contact.
It explains why each plan passes or fails, and it searches for alternatives when a launch slips.

Everything it reports is computed from NASA data: Sun and Earth positions from **JPL Horizons**, and terrain from
**LRO LOLA** elevation models served by **NASA Moon Trek**. Results are cross-checked against **LROC** illumination
maps. Validation evidence and limitations are shown in the app (Methodology view) and in [`docs/`](docs/).

> **Status (2026-11-15):** hackathon build. The guided *Try a mission* journey is verified in a real browser on the
> branch `recovery/workflows-remaining` (see [`docs/integration/workflow-recovery-progress.md`](docs/integration/workflow-recovery-progress.md));
> it reaches `main` when that branch is merged. The Comparison report it ends on is already on `main`.

## What it does (implemented on this branch)

| View (URL) | What you get |
|---|---|
| **Mission Planner** (`#app/planner`) | A 3D Moon you can spin and zoom: LOLA terrain, live sunlight and shadows, LRO WAC imagery when zoomed out. Curated Artemis III and historical sites, or a dropped custom pin. A time strip with sunlight and Earth-visibility lanes (unknown data is shown as unknown, never as darkness), a sky plot, and Sun / Earth eye views from the lander. Plans are saved as cards with the engine's verdict. **Full assessment** shows every requirement's measured value, margin, evidence ("Show in 3D"), data provenance and limitations. |
| **Mission Rescue** (in the Planner) | After a launch delay or a requirement change, it searches nearby dates and sites for passing alternatives and explains each one. |
| **Scenario Comparison** (`#app/compare`) | Side-by-side plans: headline conditions, synchronized timelines, a metrics table, trade-offs, the canonical ranking (only PASS plans are ranked), CSV/JSON export. An optional AI Mission Assistant (see *AI assistance*). |
| **Feasibility Atlas** (`#app/atlas`) | Landing date × mission length grid for one site and spacecraft: which missions pass, fail or cannot be decided. |
| **Validation & Methodology** (`#app/method`) | Where each answer comes from, the independent scientific checks (ephemeris, horizon geometry, LROC sunlight), the viability engine's software-verification report, and the limitations. |
| **Try a mission** (landing page button, and the header button in the navigator) | A guided, real-data mission through the actual tools: a Peak Near Shackleton plan that passes, a 4-day launch delay that makes it fail on the Earth-radio blackout, "Show why" in 3D, a Mission Rescue recovery, the Comparison, and a frozen summary report you can export. Every verdict is read live from the engine; nothing is scripted. Restart and exit are always available. Definition and replay check: [`docs/mission-story.md`](docs/mission-story.md). |
| **Guided Mission Briefing** | A 9-step tutorial offered on first visit (about the Comparison; separate from *Try a mission*, and the two never run at once). |

Verdicts are **PASS**, **FAIL** or **UNKNOWN**. UNKNOWN means the data cannot decide (for example the mission runs
past the end of the data) and is never treated as a failure. A missing score is never shown as 0.

## Quick start

Needs **Python 3.14** (the version CI uses) and **Node 24** (`frontend/.nvmrc`). The commands are for Windows
PowerShell; on macOS/Linux use `.venv/bin/...` instead of `.venv\Scripts\...`.

```powershell
# 1. Install (once)
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
cd ..\frontend
npm install

# 2. Run (two terminals)
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000     # API docs: http://localhost:8000/docs
cd frontend
npm run dev                                                               # http://localhost:5173
```

Vite forwards `/api` to the backend on port 8000. The precomputed site files (`data/sites/`, 24 sites, hourly
2026-01-01 to 2031-01-01) are in git, so the planning tools work right away. Terrain and imagery for the 3D view
are downloaded from Moon Trek on first view and cached in `data/cache/` (git-ignored).

**After a `git pull`, restart `npm run dev`.** On Windows the Vite watcher can miss files that git rewrote and keep
serving a stale module, which shows up as a black screen.

## Prepared and offline demonstration

To make a machine demo-ready, so a demo never waits on Moon Trek (details:
[`docs/demo-setup.md`](docs/demo-setup.md)):

```powershell
cd backend
.venv\Scripts\python.exe scripts\prefetch_tiles.py           # warm terrain, imagery, PSR overlay, ephemeris kernels (~10-30 min)
.venv\Scripts\python.exe scripts\prefetch_tiles.py --check   # downloads nothing; lists anything not cached
```

Then prove the demo needs no network: start the backend with `LUNAR_OFFLINE=1` (PowerShell:
`$env:LUNAR_OFFLINE=1`) and, from `frontend/`, run `node scripts/demo-tour.mjs --verify`. Offline:

- only cached terrain and the precomputed site data are served;
- the live JPL Horizons check and custom pins outside the cache answer 503 with an explanation;
- a 3D tile whose fine terrain isn't cached is drawn from coarser cached data;
- the UI font falls back to a system font.

`--verify` doesn't flag that coarser terrain fallback; `prefetch_tiles.py --check` does.

## Architecture

```
frontend/   React 19 + TypeScript + Vite; Three.js via React Three Fiber (3D); Zustand (state); Tailwind
  src/viz/            3D scene, terrain tiles (viz/globe), sky, time strip, camera
  src/features/       plans, rescue, compare, atlas, methodology, assessment, tutorial, landing
  src/lib/            shared canonical verdict / assessment clients
  scripts/            demo-tour.mjs (terrain-cache tour), smoke-prod.mjs (production smoke test)
backend/    Python + FastAPI + numpy + rasterio
  app/engine/         data engine: Horizons ephemeris, Moon Trek LOLA DEMs, horizon masks, timelines, tiles
  app/viability/      canonical viability engine (verdicts, metrics, margins, risks, score, ranking) + /api/viability
  app/rescue/         Mission Rescue; app/compare/ Comparison backend; app/assistant/ optional AI assistant
  scripts/            precompute.py (site files), prefetch_tiles.py (demo cache), validate_engine.py, build_*.py
data/       sites/ (precomputed site files, in git), validation/ (stored reports), cache/ (git-ignored)
scripts/    release-gate.mjs (release checks); release-gate/ holds the latest gate results
docs/       method, data sources, interfaces, validation, demo setup, submission material
```

One engine decides every verdict. The Planner cards, the assessment panel, Comparison, Rescue and the Atlas all ask
the backend's canonical viability engine on the same hourly grid; the frontend never computes its own PASS.
Interfaces: [`docs/interfaces.md`](docs/interfaces.md), [`docs/viability-api.md`](docs/viability-api.md),
[`docs/viability-engine.md`](docs/viability-engine.md), [`docs/comparison.md`](docs/comparison.md),
[`docs/rescue.md`](docs/rescue.md).

## Testing

```powershell
cd backend;  .venv\Scripts\python.exe -m pytest -q          # backend suite (CI runs it with LUNAR_OFFLINE=1)
cd frontend; npx vitest run; npx oxlint; npm run build       # frontend tests, lint, type-check + bundle
cd frontend; node scripts/smoke-prod.mjs                     # production build in a real browser (backend on 8000)
cd frontend; node scripts/e2e-guided.mjs                     # the Try-a-mission journey + Atlas transfer, real browser, 1366x768 and 1920x1080
cd backend;  .venv\Scripts\python.exe scripts\verify_mission_story.py   # replay the mission definition against the live engine
node scripts/release-gate.mjs --full                         # from the repository root: full suites + every gate check
```

GitHub Actions (`.github/workflows/ci.yml`) runs the backend tests, frontend lint, tests and build on every push.
The release gate starts its own backends (ports 8011 and 8012), needs Chrome or Edge and the prepared cache, and
writes [`release-gate/LATEST.md`](release-gate/LATEST.md). The latest recorded run (commit `2d77acf`) covers only the
production and offline checks, so it is **not** a full release pass.

The Phase-6 rescue compatibility tests in `backend/tests/viability/` assert the current one-hourly-grid time policy
(`app/timegrid.py`); details in [`docs/integration/workflow-recovery-progress.md`](docs/integration/workflow-recovery-progress.md).

## NASA data and references

| Source | Used for |
|---|---|
| [NASA JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) (`CENTER='coord@301'`, Moon ME frame) | Sun and Earth azimuth, elevation and angular size from each site, hourly 2026-2031 |
| [NASA Moon Trek](https://trek.nasa.gov/moon/): LRO LOLA DEMs (south / north polar 5-100 m, global 118 m), LRO WAC mosaics, PSR and surface-ice layers | Horizon masks, 3D terrain, zoomed-out imagery, PSR overlay |
| [LROC](https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_POLE_ILL_TWI_SOUTH) `WAC_POLE_ILL_TWI_SOUTH` (Speyerer & Robinson 2013, *Icarus* 222, 122-136) | Observed-illumination cross-check |
| [LROC QuickMap](https://quickmap.lroc.asu.edu/) | Manual cross-checks during development (no API used) |
| JPL DE421 + NAIF Moon frame kernels, via Skyfield | Independent ephemeris check; local ephemeris for custom pins |
| NASA, "NASA Provides Update on Artemis III Moon Landing Regions" (2024-10-28); George et al., LPSC 2026 | Artemis III candidate-region labels |
| Gracy & Lee 2024, LPSC 55, abstract 1695 | Coordinates of Connecting Ridge and Peak Near Shackleton |
| Hipparcos catalogue (ESA, via CDS VizieR `I/239`) | Star field (display only) |
| NASA Visible Earth "Blue Marble" | Earth's appearance in the sky (display only) |
| [CSA Moon Exploration](https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/) | Background context only (no datasets) |

Full detail, frames and caveats: [`docs/data-sources.md`](docs/data-sources.md).

## AI assistance

- The optional *Mission Assistant* in Comparison sends the comparison's own numbers to an LLM
  through OpenRouter (default model `openai/gpt-4o-mini`, set by `OPENROUTER_MODEL`). It runs only when the server
  has `OPENROUTER_API_KEY` (in `backend/.env` or the environment); otherwise it says it isn't configured. It explains
  results; it never decides verdicts, scores or rankings.
  
## Team

B.A.J.A.N (Space Apps 2026).
