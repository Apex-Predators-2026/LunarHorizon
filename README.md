# Lunar Horizon: Lunar Landing Site Navigator

**Finding the Right Place. At the Right Time.**

Lunar Landing Site Navigator helps plan safer, smarter Artemis III landings at the lunar south pole. By analyzing
sunlight, Earth visibility, and lunar terrain across 2026–2031 using NASA data and JPL Horizons, it evaluates landing
opportunities hour by hour, explains mission constraints, and dynamically adapts plans when launch dates shift.

Built for the 2026 NASA Space Apps Challenge *Lunar Landing Site Navigator*, for mission planners, educators and the
public alike. For every plan it shows whether the Sun lights the lander's solar panels and whether Earth is above the
local terrain horizon for direct-to-Earth contact. It explains why each plan passes or fails, compares plans side by
side with a formal Mission Report, and searches for alternatives when a launch slips.

Everything it reports is computed from NASA data: Sun and Earth positions from **JPL Horizons**, and terrain from
**LRO LOLA** elevation models served by **NASA Moon Trek**. Results are cross-checked against **LROC** illumination
maps. Validation evidence and limitations are shown in the app (the Methodology view, and the methodology page of
Scenario Comparison) and in [`docs/`](docs/).

> **Status (2026-11-15):** hackathon build; everything described here is in this repository. It runs locally
> (instructions below). What was verified, at which commit and how is recorded by the release gate in
> [`release-gate/LATEST.md`](release-gate/LATEST.md) (exact commands, counts and the browser journeys). No public
> deployment, demo video or project page is linked: none has been verified, so none is claimed.

## What it does

| View (URL) | What you get |
|---|---|
| **Mission Planner** (`#app/planner`) | A 3D Moon you can spin and zoom: LOLA terrain, live sunlight and shadows, LRO WAC imagery when zoomed out. Curated Artemis III and historical sites, or a dropped custom pin. A time strip with sunlight and Earth-visibility lanes (unknown data is shown as unknown, never as darkness), a sky plot, and Sun / Earth eye views from the lander. Plans are saved as cards with the engine's verdict. **Full assessment** shows every requirement's measured value, margin, evidence ("Show in 3D"), data provenance and limitations. |
| **Mission Rescue** (in the Planner) | After a launch delay or a requirement change, it searches nearby dates and sites for passing alternatives, explains each one, and can send them to Scenario Comparison, which tells the rescue story (original plan, what broke, the recovery). |
| **Scenario Comparison** (`#app/compare`) | Up to four plans side by side, in three views. **Overview** puts the decision first: the recommendation (or why there is none), the decisive requirement and the next step, then *At a glance*, the Mission Rescue story and the decision's trade-offs. **Evidence**: the metrics and requirements table, the mission assessment, a synchronized sunlight / Earth-contact timeline with the conditions at any hour (and *Open in 3D*), and the canonical ranking (only PASS plans are ranked, and only against plans judged by the same rules). **Detailed analysis**: Sun and Earth elevation charts, terrain horizon vs. Sun and Earth, a trade-off radar, *Science vs engineering* and *Data, assumptions and limitations*. Rescue alternatives can be imported straight into the comparison. Plus CSV / JSON export, the **Mission Report**, a six-stop *How to compare missions* tour and the **Ask Rover** Mission Assistant (below). |
| **How This Analysis Was Built** (bottom of Scenario Comparison → `#app/compare/methodology`) | A compact section at the end of the comparison opens a methodology page that belongs to the comparison (not a main-menu item). It covers the seven-step pipeline from plan to recommendation, the NASA data sources, the models (curvature-corrected terrain horizons, the Sun as a 0.53° disk, Earth line of sight, the hourly time policy), every metric, the PASS / FAIL / UNKNOWN rule, default requirements, the desirability score, fair comparison groups, what counts as a real difference, assumptions and limits, and the technical architecture. Interactive figures let you move a ridge to see the effect of lunar curvature, lower the Sun behind a rim to see the visible disk fraction against the panel threshold, and slide a measured range across a limit to see the verdict change. **← Back to Scenario Comparison** returns to the same comparison, with its results intact. |
| **Ask Rover: Mission Assistant** (in Scenario Comparison) | A read-only chat panel (docked and resizable, full screen, or minimized) that explains the comparison on screen, answers "how do I…" questions about the page, and reads the generated Mission Report. Answers stream in, show the page's own verdict chips, and contain links that jump to the right section, tab or tour. It flags a report that is out of date first. It never changes plans, verdicts, scores or rankings. Without an AI key it says so and offers basic answers assembled from the page itself, labelled "not AI". Setup: see *AI assistance*. |
| **Feasibility Atlas** (`#app/atlas`) | Landing date × mission length grid for one site and spacecraft: which missions pass, fail or cannot be decided. |
| **Validation & Methodology** (`#app/method`) | Where each answer comes from, the independent scientific checks (ephemeris, horizon geometry, LROC sunlight), the viability engine's software-verification report, and the limitations. |
| **Try a mission** (landing page button, and the header button in the navigator) | A guided, real-data mission through the actual tools: a Peak Near Shackleton plan that passes, a 4-day launch delay that makes it fail on the Earth-radio blackout, "Show why" in 3D, a Mission Rescue recovery, the Comparison, and a frozen summary report you can export. Every verdict is read live from the engine; nothing is scripted. Restart and exit are always available. Definition and replay check: [`docs/mission-story.md`](docs/mission-story.md). |
| **Guided tours** | A first-visit *Mission Briefing* in the Planner (8 stops: 3D shadows, sky blockers, the JPL check, Mission Rescue) and a six-stop *How to compare missions* tour of the Comparison (select missions, viability, conditions, trade-offs, the Mission Report, the assistant). Both are separate from *Try a mission*, and never run together with it. |
| **Mission Report** (header of Scenario Comparison) | A frozen snapshot of the evaluated comparison, laid out as a formal black-and-white document: serif type, ruled tables and plain PASS / FAIL / UNKNOWN wording. A title page with contents is followed by nine sections: executive summary, mission overview, mission performance, comparison analysis, requirements assessment, strengths and weaknesses, final assessment and recommendation, data sources and methodology, and disclaimer. Mission performance has **five real figures** with axes and the requirement limits drawn in (mean visible solar disk, longest darkness, Earth line of sight, longest communication blackout, requirement outcomes per plan). The preview has section navigation. Exports: a one-click **PDF** (generated in the browser and loaded only when needed, numbered "Page n of N"), **Print** (A4 / Letter) and a matching **JSON**. The technical record (ranking evidence, pairwise comparisons, dataset SHA-256, engine versions, evaluated UTC intervals) is an appendix. A later change to the comparison marks the report out of date until you regenerate it. The PDF is laid out separately from the on-screen pages, so its page count can differ. |

Verdicts are **PASS**, **FAIL** or **UNKNOWN** (the Atlas adds *not evaluated* for dates outside the data). UNKNOWN
means the data cannot decide and is never treated as a failure. A missing score is never shown as 0; a value the data
only bounds is shown as a range.

**One time policy.** Every tool (Planner, Comparison, Rescue, Atlas, reports) evaluates a mission on the hourly data
grid (`backend/app/timegrid.py`): the landing is rounded to the nearest UTC hour and the length to whole hours. The app
shows what you entered and what was evaluated, and says so when they differ. A mission that runs past the end of the
data is judged on the hours that exist, with the missing hours bounded: it gets a verdict only where that evidence
proves it (usually FAIL; PASS only if even the worst case for the missing hours passes) and is otherwise UNKNOWN.

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
  src/features/       plans, rescue, compare, atlas, methodology, assessment, tutorial, guide, landing
    compare/            Scenario Comparison: views, decision, analysis; tour/, assistant/ (Ask Rover),
                        Mission Report (report.ts snapshot, reportCard.ts content, ReportCardPdf.tsx via
                        @react-pdf/renderer, loaded on demand), methodology/ (How This Analysis Was Built)
  src/lib/            shared canonical verdict / assessment clients
  scripts/            demo-tour.mjs (terrain-cache tour), smoke-prod.mjs (production smoke journey),
                      e2e-guided.mjs (Try a mission journey), e2e-time-missing.mjs (hourly-grid / incomplete data)
backend/    Python + FastAPI + numpy + rasterio
  app/engine/         data engine: Horizons ephemeris, Moon Trek LOLA DEMs, horizon masks, timelines, tiles
  app/viability/      canonical viability engine (verdicts, metrics, margins, risks, score, ranking) + /api/viability
  app/rescue/         Mission Rescue; app/compare/ Comparison backend (POST /api/compare)
  app/assistant/      Mission Assistant proxy (/api/assistant/status, /chat); holds the API key, never the browser
  scripts/            precompute.py (site files), prefetch_tiles.py (demo cache), validate_engine.py, build_*.py
data/       sites/ (precomputed site files, in git), validation/ (stored reports), cache/ (git-ignored)
scripts/    release-gate.mjs + release-gate-lib.mjs (release checks and their tested decision logic); release-gate/ holds the latest gate record
docs/       method, data sources, interfaces, validation, demo setup, submission material
```

One engine decides every verdict. The Planner cards, the assessment panel, Comparison, Rescue and the Atlas all ask
the backend's canonical viability engine on the same hourly grid; the frontend never computes its own PASS.
Interfaces: [`docs/interfaces.md`](docs/interfaces.md), [`docs/viability-api.md`](docs/viability-api.md),
[`docs/viability-engine.md`](docs/viability-engine.md), [`docs/comparison.md`](docs/comparison.md),
[`docs/rescue.md`](docs/rescue.md).

## Testing

```powershell
cd backend;  $env:LUNAR_OFFLINE=1; .venv\Scripts\python.exe -m pytest -q   # backend suite (CI runs it with LUNAR_OFFLINE=1)
cd frontend; npx tsc -b; npx oxlint; npx vitest run; npm run build           # types, lint, tests, bundle
cd backend;  .venv\Scripts\python.exe scripts\verify_mission_story.py        # replay the mission definition against the live engine
node --test "scripts/*.test.mjs"                                             # the release gate's own decision logic (repository root)
```

Browser journeys (real Chrome or Edge; `CHROME_PATH` if not found; a backend on port 8000, or pass `--api`). Run them
on the **production build** (`npm run build` first), which is what the gate does:

```powershell
cd frontend
node scripts/smoke-prod.mjs --strict --api http://localhost:8000     # the whole planner / rescue / compare / export / Atlas journey (builds dist/ unless --no-build)
node scripts/e2e-guided.mjs --serve-dist --api http://localhost:8000 # Try a mission end to end + frozen report + Atlas transfer, 1366x768 and 1920x1080
node scripts/e2e-time-missing.mjs --serve-dist --api http://localhost:8000   # hourly-grid mission time and incomplete data, both viewports
node scripts/e2e-evidence.mjs --serve-dist --api http://localhost:8000       # Show why from the Comparison into the 3D view and back, both viewports
```

**Release gate** (repository root): `node scripts/release-gate.mjs` runs every required check: the full backend and
frontend suites, TypeScript, lint, the production build, the four browser journeys above (the smoke journey runs strict) and the same guided
journey against a backend started with `LUNAR_OFFLINE=1` (with proof that the backend is offline). It starts its own
backends (ports 8011 and 8012; it refuses to run if one is already in use), needs Chrome or Edge and the prepared
terrain cache, takes about 25 minutes, and writes [`release-gate/LATEST.md`](release-gate/LATEST.md) plus a JSON record
with the tested commit, the exact commands and the pass / fail / skipped counts. **A skipped, unavailable or not-run
check is INCOMPLETE, never PASS**, and `--only`, `--quick` or `--no-browser` runs are never a release pass (they write
`*-partial*` records that are not kept). Use `PYTHON=path\to\python.exe` if the virtual environment is elsewhere.

GitHub Actions (`.github/workflows/ci.yml`) runs the backend tests, the gate-logic tests, frontend lint, tests and
build on every push; it does not run the browser journeys.

The Phase-6 rescue compatibility tests in `backend/tests/viability/` assert the current one-hourly-grid time policy
(`app/timegrid.py`); details in [`docs/integration/workflow-recovery-progress.md`](docs/integration/workflow-recovery-progress.md).
The optional strict checks of `app/viability` (`ruff`, `mypy --strict`, see `docs/viability-engine.md`) still report a
handful of older findings in `app/viability/compat/headroom.py` and two test files; they are not part of CI or the gate.

### Review it as a judge (about 10 minutes)

1. Start the backend and `npm run dev` (Quick start), open `http://localhost:5173` and press **Try a mission**.
2. Follow the story to the end: PASS, the 4-day delay, FAIL (Earth blackout 118 h against 96 h), **Show why** in 3D,
   the Rescue recovery, the Comparison, then the **Summary report** (print or JSON).
3. In **Scenario Comparison**, read the decision on *Overview*, switch to *Evidence* and *Detailed analysis*, then
   open the **Mission Report** from the page header and download the PDF.
4. Press **Ask Rover** and ask "Summarize my current comparison" (needs an AI key; without one it gives a basic,
   labelled answer from the page).
5. Scroll to the bottom of the comparison, press **Explore Methodology →**, try the interactive figures, then
   **← Back to Scenario Comparison**.
6. Open **Feasibility Atlas**, pick a cell, and press *Open this mission in the Planner*.
7. Open **Methodology** to see what was validated against what, and what was not (limitations are listed there).
8. For a short rehearsal with someone who has not seen the app: [`docs/rehearsal-checklist.md`](docs/rehearsal-checklist.md).

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

**In the app.** The optional *Ask Rover* Mission Assistant in Scenario Comparison sends the comparison's own
numbers (and the Mission Report, once generated) to an LLM through OpenRouter (default model `openai/gpt-4o-mini`).
It explains results; it never decides verdicts, scores, rankings or recommendations, and when no AI service is
available it says so rather than making up an answer.

**Local development.** The key lives only on the backend; the browser never sees it.

```powershell
cd backend
copy .env.example .env      # then edit .env and set OPENROUTER_API_KEY=sk-or-v1-...
```

| Variable (`backend/.env` or the environment) | Meaning |
|---|---|
| `OPENROUTER_API_KEY` | Required for AI answers. Without it the panel says "not configured" and offers basic answers. |
| `OPENROUTER_MODEL` | Optional model id (default `openai/gpt-4o-mini`). |
| `OPENROUTER_BASE_URL` | Optional OpenAI-compatible endpoint (default `https://openrouter.ai/api/v1`). |
| `OPENROUTER_HTTP_REFERER` | Optional public frontend URL used for OpenRouter attribution. |
| `ASSISTANT_TIMEOUT_S` | Optional answer timeout in seconds (default 45). |

`backend/.env` is git-ignored and read on every request: after saving it, press *Check again* in the panel (no
restart needed). Never commit a key or put it in frontend code. `LUNAR_OFFLINE=1` turns the assistant off; the
comparison itself keeps working.

**Shared deployment.** Users do not need their own key or local setup: configure `OPENROUTER_API_KEY` once as a
secret/environment variable on the deployed **backend**. Set `VITE_API_URL` to the backend's public base URL when
building the frontend (omit the trailing slash). If frontend and backend have different origins, also set
`CORS_ALLOW_ORIGINS` on the backend to the exact frontend origin(s), comma-separated, including `https://` and any
port. For a same-origin reverse proxy, route `/api` to FastAPI and no CORS setting is needed. Optionally set
`OPENROUTER_HTTP_REFERER` to the public frontend URL for OpenRouter attribution. Restart/redeploy the backend after
changing its environment; rebuild the frontend after changing `VITE_API_URL`. Verify the deployment with
`GET /api/health` and `GET /api/assistant/status` (the latter should return `available: true`). The key must never be
set as a `VITE_*` variable: those values are included in browser code. Since the key is shared, configure provider
spending limits for the public demo. Without a configured key, everyone can still use the assistant's labelled basic
answers and the rest of the comparison. Details: [`docs/comparison.md`](docs/comparison.md#guided-tour-and-mission-assistant).

**In development.** Parts of the code (including the comparison, tour, assistant, Mission Report and methodology
page) were written with AI coding assistants; every verdict, score and ranking comes from the team's own engine.

## Team

Team B.A.J.A.N, NASA Space Apps 2026.
