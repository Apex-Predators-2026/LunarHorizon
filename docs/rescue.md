# Mission Rescue & Optimization (Member 5)

When a plan changes (launch delay, longer mission, smaller battery, stricter comms), this
feature re-checks the plan and automatically finds, ranks and explains better landing
sites and dates. It also answers two follow-up questions: *how fragile is this plan?* and
*what landing best satisfies both the science and engineering teams?*

## What is where

| Path | What it does |
|---|---|
| `backend/app/rescue/search.py` | Main rescue algorithm (`rescue()`) |
| `backend/app/rescue/engine.py` | Evaluates many site × date candidates fast; candidate generation; de-duplication |
| `backend/app/rescue/explain.py` | Plain-English headlines, reasons and before/after metric deltas |
| `backend/app/rescue/loosen.py` | "Smallest requirement change that makes something pass" |
| `backend/app/rescue/sensitivity.py` | Date-slip and landing-error sensitivity; quick robustness check |
| `backend/app/rescue/compromise.py` | Science vs engineering trade-off (Pareto front, weighted best, what to give up) |
| `backend/app/rescue/router.py` | FastAPI endpoints under `/api/rescue` (registered in `app/main.py`) |
| `backend/app/rescue/schemas.py` | Rescue request/response models |
| `backend/app/models.py` | Team's shared models; rescue added `Scenario`, `MissionRequirements`, `ViabilityResult`… |
| `backend/app/rescue/viability/` | Viability entry point: the canonical engine (`app.viability.compat.rescue`); the old placeholder engine stays only for reference and its loosening table |
| `backend/app/rescue/timeline/synthetic.py` | **Placeholder** Sun/Earth/terrain data for points with no real data |
| `backend/app/rescue/timeline/precomputed.py` | Reads the data engine's real `data/sites/<id>.json` files (JPL Horizons + Moon Trek LOLA) |
| `backend/app/rescue/catalog.py` | Candidate sites (the engine's curated list + approximate extras) and PSR science targets |
| `backend/tests/` | pytest suite (most rescue tests use synthetic data on purpose; `test_rescue_real_data.py` runs on the real files) |
| `frontend/src/features/rescue/` | React panel: `MissionRescue` (mounted in `App.tsx`), `PlanForm`, `RescuePanel`, `CompromisePanel`, prop-only `RescueResults` / `CompromiseResults`, Zustand store, API client, types, tests |
| `frontend/src/types.ts` | Team's shared types; rescue added the same shared models as `models.py` |

## Running it

Backend:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
pytest                            # backend tests
uvicorn app.main:app --reload     # API on http://127.0.0.1:8000, docs at /docs
```

Frontend (in a second terminal, with the backend running):

```bash
cd frontend
npm install
npm run dev                       # http://localhost:5173; /api is proxied to the backend
npx vitest run                    # frontend tests
```

In VS Code, **F5 → "Backend API (uvicorn)"** starts the backend, and the Testing tab runs pytest.

In the app's right-hand panel:
1. Pick a site and landing date, then **Set plan**.
2. Enter a launch delay and click **Find alternatives**.
3. Click **Use this plan** on an alternative to move the shared site/time (the 3D view and
   timelines follow it).
4. The **Science vs engineering** tab runs the compromise search.

Example request body for `POST /api/rescue` (try it on the `/docs` page):

```json
{
  "original": {
    "site": { "id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302 },
    "landing_utc": "2027-01-07T00:00:00Z",
    "duration_days": 7
  },
  "change": { "launch_delay_days": 21, "reason": "Launch slipped 3 weeks" }
}
```

## How the rescue search works

1. **Evaluate the original plan and the changed plan.** The changed plan is the original
   with the delay added to the landing time and any new duration or requirements applied.
2. **Build candidates.**
   - *Dates:* every `date_step_hours` (default 12 h) from the delayed landing time to
     `date_window_days` later (default 30). Earlier dates are only searched if
     `allow_earlier_dates` is set, because a delayed launch can't land earlier.
   - *Locations:* the original site, every catalog site (optionally within
     `max_site_distance_km`), and custom points 2 km and 5 km around the original site in
     8 directions.
   - Default search: 24 locations × 61 times = 1,464 candidates, about 0.3 s.
3. **Evaluate every candidate** with the viability checker. Each location fetches one
   timeline covering the whole window, which is then sliced per candidate.
4. **Rank the passing candidates:**
   `rank_score = viability score + clearance bonus − 0.5/day of extra shift − 0.05/km moved − fragility penalty`.
   - The clearance bonus (1 point per degree, capped at 3°) prefers options where the Sun
     and Earth sit higher above the terrain, which means a bigger safety margin.
   - The fragility penalty (up to 15 points) comes from a quick 8-point robustness check:
     ±12 h, ±24 h and 1 km in 4 directions.
   - All weights are adjustable in `SearchOptions`.
5. **Keep the list varied.** Two alternatives in the same site group (the same catalog site
   or custom points near it) must be at least `min_separation_hours` (48 h) apart, so the
   top 5 are real choices rather than copies.
6. **Explain** each alternative against the changed plan: which broken requirements it
   fixes, the biggest improvements, the biggest trade-off, and when the first sunset comes.
7. **Near misses:** the closest failing options and exactly why they fail. This covers the
   "rank mission fails" idea from the planning doc.
8. **Loosening:** relaxing a requirement never changes a scenario's metrics, so a failing
   candidate passes **exactly** when each violated requirement is relaxed to the value it
   actually achieves. Candidates are ranked by the total relaxation needed. The first
   suggestion is always "keep your delayed plan by relaxing X" if that plan fails. A test
   checks that applying every suggestion really makes its scenario pass.

`status` is `still_viable` (the changed plan passes), `rescued` (alternatives found) or
`no_viable_alternative` (nothing passes; see `loosening`).

## Sensitivity

`POST /api/rescue/sensitivity` re-evaluates a plan at landing-time slips (default ±12 h to
±72 h) and landing-position errors (0.5, 1 and 2 km in 8 directions). It reports:
- pass rates for date slips and for position errors
- the safe date window around the plan
- the requirement that breaks first
- a verdict: `robust` (≥ 85% pass), `sensitive` (≥ 50%), `fragile`, or `fails`

## Science vs engineering

`POST /api/rescue/compromise` takes a science target (a catalog PSR or any point), a maximum
traverse distance and a minimum science score, plus the engineering requirements.

- **Science score** = 1 − distance to the target ÷ maximum traverse (0 beyond it).
- **Engineering score** = viability score ÷ 100. Meeting engineering means the plan passes.
- It adds rings of candidate points 1–10 km outside the target, keeps the best date per
  location, and returns:
  - the best option for engineering and the best for science
  - the Pareto front (options where neither side can improve without the other losing)
  - the best weighted option
- If no option meets both goals, it says what each side would give up. Science could accept
  the nearest engineering-feasible spot (with the traverse distance needed), or engineering
  could relax a specific requirement (exact numbers from the loosening logic).

## Integration checklist (things other members need to do)

- [x] **Brandon:** canonical viability engine finished (phase 6). Rescue switched to it after the
      side-by-side test (`tests/test_engine_side_by_side.py`) showed identical verdicts, metrics and
      violations on real data. Only the score formula differs; the ranking weights still fit
      (same 0–100 scale; the top 5 of a real rescue are the same sites and dates).
- [x] **Andrew:** precomputed `data/sites/<id>.json` for the curated sites. Rescue reads them
      directly and takes its site list from `app/engine/sites.py`, so new curated sites are
      picked up automatically once precomputed.
- [ ] **Andrew, still open:**
      - Precompute more Artemis III regions so rescue has more real options. The approximate
        extras in `catalog.py` can then be removed.
      - Precompute (or compute live) points a few km around each site, so landing-position
        sensitivity can run on real terrain. It's skipped for real sites today.
      - `frontend/package-lock.json` is out of sync with `package.json` (`npm ci` fails).
        Please run `npm install` and commit the lockfile.
- [ ] **UI owner:** the rescue panel is mounted as a right-hand sidebar in `App.tsx`; move it
      anywhere. When the mission configuration panel exists, it can call
      `useRescueStore.getState().setOriginal(scenario)` and `PlanForm` can be dropped.
      Choosing an alternative already updates `useAppStore` (`siteId`, `timeUtc`).
- [ ] **Member 4 (comparison):** alternatives, near misses and loosening suggestions all carry
      a full `Scenario`. Compare them against `RescueResponse.changed`. `<RescueResults>` and
      `<CompromiseResults>` take plain props if you want to reuse them.
- [ ] **Member 6 (validation):** the rescue checks are in `backend/tests/test_rescue.py`,
      `test_sensitivity_compromise.py` and `test_rescue_real_data.py`. The last one checks that
      rescue reads exactly the numbers in the engine's files (it matches the engine's own
      summary) and that real and synthetic data are never mixed.

## Demo scenario

The preset is `backend/app/rescue/demo_scenario.json`. It was picked by searching the 8 catalog
sites on real data (6 start dates in 2027, delays of 3 to 20 days, default requirements) for plans
that pass, then fail after the delay, then get rescued. Of the candidates that fit, this one has a
single clear failure.

- **Plan:** Connecting Ridge, 7 days, landing 2027-02-08 00:00 UTC, default requirements.
- **Before the delay:** passes, score 100.
- **After a 5-day launch delay** (landing 2027-02-13): fails, score 64.8. One requirement is
  violated: the longest continuous power-darkness is 63 h and the declared limit is 50 h
  (`battery_hours`).
- **Rescue:** status `rescued`, 5 alternatives, all passing. The best is Malapert Massif, landing
  2027-02-16 12:00 UTC, score 100.
- `backend/tests/test_rescue_real_data.py` checks this transition, and checks that every
  recommended alternative also passes when re-evaluated directly by the canonical engine with the
  cache and fast path off, with the same verdict and score (the release gate).

Timing for this scenario, measured in-process on the default search (488 candidates): about 5 s
the first time (it includes loading the site files), 0.1 to 0.2 s repeated. With the cache and
fast path off, the same request takes about 8 s every time. The cache and fast path give the same
results as the slow path; the equivalence tests in the same file check that.

Changing files under `data/sites/` needs a backend restart. The loaded timelines and the
evaluation cache are kept in memory and are not refreshed when a file changes.

## Questions judges may ask

**How does rescue choose alternatives?** It searches a grid: every catalog site plus custom points
2 km and 5 km around the original, at every 12 h for 30 days after the delayed date. Each
candidate is checked against your requirements. Passing ones are ranked by score plus a clearance
bonus, minus penalties for extra delay and distance moved and for fragility. A quick robustness
check (small date and position changes) feeds the fragility penalty. It only finds options at the
tested times and points.

**What does the score measure?** A 0 to 100 model score for how comfortably a plan meets the
requirements (sunlight, darkness, Earth contact). It is a screening result, not a mission
approval. Pass or fail comes from the requirements, not from the score.

**Are nearby landing positions evaluated with real terrain?** No. Only the 8 catalog sites have
real data. Nearby points are skipped and reported as such (unless simulation mode is on).

**How does missing data affect the result?** The result is unknown, never a fail and never a zero.
Unknown results have no score and are not ranked as passes.

**Is there a battery model?** No. There is a declared darkness-tolerance rule (`battery_hours`:
the longest continuous power-dark period allowed), not a state-of-charge simulation.

**Is radio-link reliability modelled?** No. Only Earth line of sight above the terrain is used.

**What uses synthetic data?** Only simulation mode, which is off by default and is labelled in
the results and the UI.

**Why are landing times rounded to the hour?** The data is hourly. The result shows the time that
was actually evaluated, which can differ from what you typed by up to half an hour.

## Regenerating the frontend test fixtures

`frontend/src/features/rescue/__fixtures__/*.json` are real backend responses. After
changing a response model, regenerate them by calling the endpoints, e.g. from the
`/docs` page, and keep `top_n` small so the files stay small.

## Limitations (say these out loud in the demo)

- **Real data covers all 8 rescue sites from 2026-01-01 to 2031-01-01** (read from the files in
  `data/sites/`; `backend/tests/data_range.py` reports the exact range, which the data engine
  may extend). By default rescue uses only that data. Anything it doesn't fully cover (dates
  outside the range, custom nearby points, or sites with no data file) is reported as
  **unknown**, never as a pass or fail.
- **Simulation mode** (the checkbox in the rescue panel, `include_synthetic: true`) fills those gaps
  with synthetic placeholder geometry and invented terrain. Every result's `data_source` says which
  was used, the UI shows a "real data" / "synthetic" badge, and synthetic results carry a warning.
- The extra regions in `backend/app/rescue/catalog.py` (marked "approx.") have approximate
  coordinates.
- Landing-position sensitivity needs real data at the nearby points. When no nearby point has
  any, the robustness shows **Not checked** instead of a verdict (never "robust" by default).
- Landing times are rounded to the whole hour of the data grid. The result shows the time that
  was actually evaluated, which can differ from the time you typed by up to half an hour.
- The rescue panel shows a "Rescuing: ..." line naming the plan, site, landing time and length.
  If you edit the plan after running, it adds "This plan changed since; press Run to update."
  so stale results are never mistaken for the current plan.
- Ranking order: real-data options first, then scored passes, then passes the engine couldn't score
  (shown without a rank score, never ranked as 0). A mission must end by the last real-data sample
  (the data's last sample, 2031-01-01T00:00Z for now); one ending even an hour later is unknown.
- The search is a grid search: it only finds options at the tested times and points. A finer
  `date_step_hours` or more `nearby_radii_km` finds more, but takes longer.
- Ranking weights are judgement calls, not NASA criteria. They're exposed so the team can tune them.
- Loosening suggestions are exact for the computed metrics, but they are not engineering
  approvals. A bigger battery is a hardware change, not a slider.
