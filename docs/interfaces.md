# Shared Data Interfaces (draft)

Mirrored in `frontend/src/types.ts` and `backend/app/models.py`. Change all three together.

## Site
```json
{ "id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302 }
```
Coordinates: degrees, latitude negative = south, longitude east. Curated sites and their sources: `backend/app/engine/sites.py`.
`Site` stays minimal because every feature embeds it (e.g. rescue's `Scenario.site`).

`SiteInfo` = `Site` + what the data engine knows (`source`, `ground_height_m`, `observer_height_m`, `summary`,
`data_start_utc`, `data_stop_utc`). It is what `/api/sites` returns.

## Timeline step (one per time sample)
```json
{
  "time_utc": "2027-01-01T00:00:00Z",
  "sun":   { "azimuth_deg": 0.0, "elevation_deg": 0.0, "horizon_deg": 0.0, "visible_fraction": 0.0 },
  "earth": { "azimuth_deg": 0.0, "elevation_deg": 0.0, "horizon_deg": 0.0, "visible": false, "margin_deg": 0.0 }
}
```
- `horizon_deg`: terrain horizon elevation at that azimuth
- `visible_fraction`: portion of the solar disk above the terrain horizon (0–1)
- `margin_deg`: Earth elevation minus terrain horizon (negative = blocked)

## Precomputed site file: `data/sites/<id>.json`
Produced by `backend/scripts/precompute.py` (`app/engine/pipeline.py`). Columnar arrays to keep files small
(~4 MB for 5 years hourly, 2026-01-01 to 2031-01-01). The timeline arrays all have the same length; index `i` across them is one `TimelineStep`.

```jsonc
{
  "site": { "id", "name", "kind", "approximate", "lat", "lon", "source", "x_m", "y_m", "ground_height_m", "observer_height_m" },
  "meta": { "generated_utc", "generator_version", "fraction_decimals", "angle_decimals", "frame", "start_utc", "stop_utc", "step", "ephemeris", "terrain": [...],
            "horizon_method" },
  "summary": { "sunlit_pct", "mean_sun_fraction_pct", "earth_visible_pct", "horizon_min_deg", "horizon_max_deg",
               "unknown_horizon_pct", "unknown_hours_pct" },
  "horizon": {                       // 720 directions, every 0.5 deg from north, clockwise
    "azimuth_deg": [], "elevation_deg": [], "distance_m": []   // distance_m = how far away the blocking terrain is
  },
  "timeline": {
    "time_utc": [],                  // "2027-01-01T00:00Z", hourly
    "sun_azimuth_deg": [], "sun_elevation_deg": [], "sun_angular_radius_deg": [],
    "sun_horizon_deg": [], "sun_visible_fraction": [], "sun_visible": [],
    "earth_azimuth_deg": [], "earth_elevation_deg": [], "earth_horizon_deg": [], "earth_margin_deg": [], "earth_visible": []
  }
}
```

Definitions:
- Heights are metres relative to the 1737.4 km reference sphere. `x_m`, `y_m` are Moon Trek south polar stereographic
  metres, and `null` for sites north of 60°S. Coordinates are in the Moon's Mean-Earth/polar-axis (ME) frame; see
  `docs/data-sources.md`.
- `kind`: `artemis` (landing candidates), `control` (validation), `apollo`, `clps`, `international` (past landings, for
  reference) or `custom` (user pins). `approximate: true` = a region estimate, not a published landing point.
- `artemis_list` (`/api/sites`, Artemis sites only, else null): `"2024"` = the region is one of the 9 in NASA's October
  2024 Artemis III update, `"2022"` = only in the original 13 (2022), `"unconfirmed"` = can't tell (de Gerlache Rim:
  Rim 1 was dropped, Rim 2 kept). Served from `engine/sites.py`, not stored in the site files.
  Curated lists: `backend/app/engine/sites.py` (`SITES` = candidates, `REFERENCE_SITES` = past landings).
- `meta.ephemeris`: JPL Horizons (DE441) for curated sites; for custom sites, a local Skyfield + DE421 calculation in
  the same frame, checked against Horizons to 0.00001°.
- `observer_height_m`: sensor height above ground (2 m) used for the horizon. One height for now; separate
  solar-array and antenna heights only if a mission configuration needs them.
- **Sunlit = `sun_visible`** (any of the solar disk above the terrain). Don't use `sun_visible_fraction > 0`:
  a thin sliver can round to 0 even at 6 decimals (it did for 1 hour at Peak Near Shackleton).
  Power estimates should use the fraction (6 decimals), not just on/off.
- `sun_angular_radius_deg`: apparent solar radius used for the disk (from Horizons' angular diameter).
- `earth_visible` = `earth_margin_deg > 0` (Earth's centre above the terrain).
- **`null` = unknown.** A horizon direction is `null` when any point along it has no terrain data in any tier
  (the missing point could be the one that blocks the sky). Timeline values that depend on such a direction are
  `null` too. Only custom sites can have them; curated sites are fully known (`unknown_*_pct` = 0).
  Summary percentages are over known hours.
- **`meta.fraction_decimals`** (6) and **`meta.angle_decimals`** (3): how many decimals `sun_visible_fraction` and the
  azimuth/elevation/horizon/margin columns are rounded to. Read these instead of inferring precision from
  `generator_version`. Present in every 1.2 file; absent in older files (1.0 = 3, 1.1 = 6 fraction decimals).
- `meta.generator_version`: `1.0` = first release; `1.1` = adds `sun_visible`, `sun_angular_radius_deg`,
  6-decimal fractions, nulls, `generated_utc` / `generator_version` / `frame`; `1.2` = works anywhere on the Moon
  (great-circle horizon over the whole-Moon elevation registry), adds `site.kind` / `site.approximate` /
  `meta.horizon_method`, `x_m` / `y_m` nullable.

## Backend API
Run from `backend/`: `.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000`.
Interactive docs with every field: http://localhost:8000/docs. The frontend dev server forwards `/api` to it.

| Endpoint | Returns |
|---|---|
| `GET /api/sites` (`?include_custom=true`) | `SiteInfo[]`: curated sites (candidates + past landings) with summary stats |
| `POST /api/sites/custom` `{lat, lon, name?}` | `SiteInfo`: analyses **any point on the Moon**. ~20–60 s in a new area (terrain downloads), then cached. Its `id` works with every endpoint below. |
| `GET /api/sites/{id}` | `SiteInfo` |
| `GET /api/sites/{id}/horizon` | `Horizon`: 720 directions |
| `GET /api/sites/{id}/timeline?start=&end=&step_hours=` | `TimelineStep[]`; times ISO UTC, e.g. `2027-03-01T00:00Z`; data covers 2026-01-01 to 2031-01-01 |
| `GET /api/sites/{id}/status?time=` | `SiteStatus`: conditions at that hour + next sunset/sunrise/Earthset/Earthrise (null if none before 2029) |
| `GET /api/sites/{id}/terrain?size=256&half_width_m=5000` | `TerrainGrid`: heights in the site's local north/east frame (superseded in the 3D view by the tiles below; kept for compatibility) |
| `GET /api/sites/{id}/verify?time=` | `VerifyResult`: that hour's stored Sun/Earth positions vs a **live** JPL Horizons query and a local DE421 calculation |
| `GET /api/validation` | The engine validation report (`data/validation/engine_validation.json`, see `docs/validation-engine.md`) |
| `GET /api/terrain/info` | Whole-Moon tiling description (faces, tile size, sources) |
| `GET /api/imagery/tile/{face}/{z}/{x}/{y}` | Zoomed-out imagery (the 3D view fades to it): LRO WAC mosaic (Moon Trek) over one tile, 256 × 256 grayscale PNG, row 0 = the tile's top (largest v). Levels 0–7 only |
| `GET /api/terrain/tile/{face}/{z}/{x}/{y}[?pad=1]` | Binary float32 heights (65 × 65) of one cube-sphere tile; header `X-Tile-Leaf: 1` = no finer data. `pad=1` returns 67 × 67: the same tile plus a ring of its neighbours' vertices, so normals on shared edges match (the 3D view uses this) |
| `GET /api/psr` | `PsrData`: 164 south-polar PSRs (centre, area, approximate outline) and 1,119 surface-ice detections, with heights |

### Whole-Moon terrain tiles
Cube-sphere quadtree, defined identically in `backend/app/engine/tiles.py` and `frontend/src/viz/globe/cubeSphere.ts`
(tested against each other):
- 6 faces, poles at the centres of faces 4 (north) and 5 (south), equal-angle mapping
  `p = centre + tan(u·π/4)·right + tan(v·π/4)·up`, normalised; `u, v ∈ [-1, 1]`.
- Tile `(face, z, x, y)` covers `u ∈ [-1 + 2x/2^z, -1 + 2(x+1)/2^z]` (same for `v`, `y`); 65 × 65 vertices, `heights[j·65 + i]`.
- Vertex spacing ≈ 42 km at z0, 167 m at z8, 5 m at z13. Max level: 13 near the poles (5 m data), 8 elsewhere (118 m).

Types for all of these: `frontend/src/types.ts` (TypeScript) and `backend/app/models.py` (Pydantic).

To be agreed by the team.

---

## Mission scenario, viability result and rescue (proposed by Member 5)

Rescue sits on top of the data engine and the viability checker, so these shapes need
agreement from Andrew (timelines), Brandon (viability) and Member 4 (comparison).
Following the rule above, they live in all three places:

- `backend/app/models.py` and `frontend/src/types.ts`: `MissionRequirements`, `Scenario`,
  `Violation`, `ViabilityMetrics`, `ViabilityResult` (shared contract)
- `backend/app/rescue/schemas.py` and `frontend/src/features/rescue/types.ts`: rescue-only
  requests and responses
- Live docs: run the backend and open `http://127.0.0.1:8000/docs`

Times are ISO 8601 and **must include a timezone** (normally UTC, `...Z`). A time without one, e.g.
`2027-01-07T00:00:00`, is rejected with a 422 error instead of being assumed to be UTC (team decision:
a silently wrong offset would shift the mission and change its results). Times with another offset are
converted to UTC. Fractions are 0–1.

### Site ids for custom points

`Site.id` is required. Points that aren't in the curated list (rescue's nearby points, a
user's custom coordinates) use `"custom:<lat>,<lon>"`, e.g. `"custom:-89.46012,221.98000"`.
Nothing will find a precomputed file for those ids, so they always use the live/synthetic
calculation.

### Scenario (one landing plan)

```json
{
  "site": { "id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302 },
  "landing_utc": "2027-10-15T00:00:00Z",
  "duration_days": 7,
  "requirements": {
    "min_sunlight_fraction": 0.5,
    "battery_hours": 50,
    "panel_threshold": 0.25,
    "min_earth_visibility_fraction": 0.4,
    "max_comms_gap_hours": 96,
    "min_initial_sun_hours": 24,
    "min_initial_comms_hours": 12
  }
}
```

### ViabilityResult (Brandon's output, which rescue reads)

```json
{
  "scenario": "Scenario",
  "passes": false,
  "eligibility": "fail",
  "score": 72.4,
  "metrics": {
    "sunlight_fraction": 0.93, "equivalent_sun_hours": 156,
    "longest_dark_gap_hours": 0, "earth_visibility_fraction": 0.51,
    "longest_comms_gap_hours": 82, "initial_sun_hours": 168, "initial_comms_hours": 0,
    "hours_to_first_sunset": null, "hours_to_first_earthset": 86,
    "mean_sun_clearance_deg": 2.1, "mean_earth_clearance_deg": 1.4, "mean_solar_elevation_deg": 1.2
  },
  "violations": [
    { "constraint": "min_initial_comms_hours", "required": 12, "actual": 0, "unit": "h",
      "shortfall": 12, "relative_shortfall": 1.0, "is_unknown": false,
      "message": "Earth contact right after landing is 0 h, below the 12 h requirement." }
  ],
  "source": "placeholder-v1",
  "data_source": "synthetic-placeholder"
}
```

What rescue relies on:

1. The Python signature `evaluate_timeline(scenario: Scenario, timeline: Timeline) -> ViabilityResult`,
   where `timeline` covers exactly the mission (`backend/app/rescue/timeline/base.py`).
2. `violations[].constraint` is the **name of the `requirements` field** that failed.
   Loosening suggestions depend on this.
3. `passes == (len(violations) == 0)`. `passes` is true only when `eligibility` is `"pass"`.
4. `eligibility` is `"pass"`, `"fail"` or `"unknown"`. `"unknown"` means the result could not be
   decided because data is missing; it is not a failure. It may be `null` for evaluators that
   don't report it, in which case read `passes` (Python: `result.verdict`, TypeScript: `verdictOf()`).
5. `score` is 0–100 (higher is better), or `null` when the scenario was not scored. Don't show
   `null` as 0.
6. `violations[].is_unknown` is true for a check that couldn't be decided (missing data).
   Rescue gives no "relax this requirement" advice for such results, and counts undecided
   candidates separately (`stats.undecided`), never as alternatives or near misses.
7. Each sample of evenly spaced data covers one time step (`[t, t + step)`). With
   `panel_threshold = 0`, the Sun still has to be at least partly visible to count as lit.

Rescue (and the comparison service, which imports the same name) uses the canonical engine
through `app.viability.compat.rescue.evaluate_timeline`, set in
`backend/app/rescue/viability/__init__.py`. The earlier placeholder (`placeholder.py`) is kept for
reference and its own tests; its `CHECKS` table still words rescue's loosening suggestions.
In rescue responses, `Alternative.rank_score`, `Robustness.worst_score`, `SensitivityPoint.score`
and `SensitivityResponse.score_min/score_max` are `null` when the engine gave no score.

### Timelines from the data engine

Rescue reads the engine's precomputed files directly: `data/sites/<id>.json`, in the columnar
format described in "Precomputed site file" above (`backend/app/rescue/timeline/precomputed.py`).
A list of `TimelineStep` objects is also accepted. Sites, custom points or dates without real
data fall back to a **synthetic placeholder**, and every result's `data_source` says which was
used (`precomputed:<file>` or `synthetic-placeholder`).

**Rescue never falls back to synthetic data unless simulation mode is selected.**
By default (`include_synthetic` unset or `false`), a mission that real data does not fully
cover is reported as `eligibility: "unknown"`, with `score: null`, `data_source: "no-real-data"`
and one violation `{constraint: "data_coverage", is_unknown: true}` explaining the covered period.
That applies to missions that run past the end of the data (2031-01-01), start before it, or are
at sites/points with no real data at all. Its metrics are reported at worst-case bounds.
Rescue, sensitivity and compromise don't search places with no real data
(`stats.synthetic_candidates_excluded`), and count out-of-range dates as undecided
(`stats.undecided`), never as passes or failures. Sensitivity returns `verdict: "unknown"` for
such a plan. `include_synthetic: true` is **simulation mode**: synthetic placeholder data is
used where there is no real data, and results carry the SYNTHETIC DATA warning.

Rescue's landing candidates are the engine's curated sites (`app/engine/sites.py`, minus
validation controls such as `shackleton-floor`) plus a few approximate extra regions
(`app/rescue/catalog.py`), listed by `GET /api/rescue/sites` with a `has_real_data` flag.

### Rescue endpoints

| Endpoint | Request | Response |
|---|---|---|
| `GET /api/rescue/sites` | – | rescue's candidate sites (with `has_real_data`) + PSR science targets |
| `POST /api/rescue` | `{ original: Scenario, change: PlanChange, search: SearchOptions }` | `RescueResponse` |
| `POST /api/rescue/sensitivity` | `{ scenario: Scenario, date_offsets_hours?, position_offsets_km?, bearings? }` | `SensitivityResponse` |
| `POST /api/rescue/compromise` | `{ scenario: Scenario, science: ScienceGoal, engineering_weight, science_weight, search }` | `CompromiseResponse` |

`PlanChange`: `{ launch_delay_days, new_duration_days?, requirement_overrides: {any requirements field}, reason? }`

`RescueResponse` (abridged):

```json
{
  "status": "rescued",
  "summary": "The changed plan fails: ... Best rescue: Land at Peak Near Shackleton on 2027-02-03 12:00 UTC ...",
  "original": "ViabilityResult",
  "changed": "ViabilityResult",
  "alternatives": [
    {
      "rank": 1, "kind": "date_shift", "is_catalog_site": true,
      "scenario": "Scenario", "viability": "ViabilityResult",
      "rank_score": 87.4, "date_shift_hours": 156, "distance_km": 0,
      "improvements": [{ "metric": "longest_comms_gap_hours", "label": "Longest comms blackout", "unit": "h",
                         "before": 82, "after": 0, "delta": -82, "better": true }],
      "robustness": { "checked_points": 8, "passing_points": 8, "pass_rate": 1.0, "worst_score": 85,
                      "verdict": "robust", "note": "Still passes with a ±1 day slip or a 1 km landing error." },
      "headline": "Land at ...", "reasons": ["Fixes: earth contact right after landing.", "..."]
    }
  ],
  "near_misses": [{ "scenario": "Scenario", "closeness": 0.01, "why_it_fails": ["..."] }],
  "loosening": [{ "changes": [{ "constraint": "battery_hours", "current": 50, "suggested": 52, "change_percent": 4 }],
                  "keeps_original_plan": false, "unlocks": "Scenario", "message": "Raise the ..." }],
  "stats": { "candidates_evaluated": 1464, "locations_considered": 24, "passing": 498 },
  "data_source": "synthetic-placeholder",
  "assumptions": ["SYNTHETIC DATA: ...", "..."]
}
```

- `kind` is one of `unchanged | date_shift | site_change | site_and_date`.
- `status` is one of `still_viable | rescued | no_viable_alternative`.

**For Member 4 (comparison):** every `alternatives[].scenario`, `near_misses[].scenario` and
`loosening[].unlocks` is a full `Scenario`, so it can go straight into the comparison view
next to `changed.scenario`. `<RescueResults>` and `<CompromiseResults>` in
`frontend/src/features/rescue` are prop-only display components you can reuse.

---

## "Show me why": point the 3D view at the evidence (Andrew, for the UI)
`frontend/src/viz/evidence.ts`. Any panel can send the 3D view to the moment that explains a result:
```ts
import { evidenceFromWindow, showEvidence } from '../viz/evidence'
// a failed constraint's evidence window from the viability engine (evidence_windows[i])
const req = evidenceFromWindow(siteId, { kind: 'darkness', start_utc, end_utc })
if (req) showEvidence(req) // or showEvidence({ siteId, startUtc, endUtc, body: 'sun' | 'earth' })
```
The 3D view then pauses, selects the site, jumps to `startUtc`, looks at the Sun (sunlight / power windows) or
Earth (communication windows) from the lander, where the blocker line and the horizon show the terrain
responsible, and shades the window on the time strip. `unknown_data` windows have nothing to show
(`evidenceFromWindow` returns null). `clearEvidence()` removes the shading.

## Multi-scenario comparison (Member 4)

`POST /api/compare` evaluates 1–6 `{ key, scenario: Scenario, spacecraft }` items with the data
engine's timelines and the team viability entry point, and returns windows, statistics, events and
a decimated timeline per scenario. Scenarios without real data return `status: "unavailable"` unless
`allow_demo_data` is set. Additive since the ranking fix: `results[].ranking` and `ranking_groups` carry the
canonical viability engine's ranking (only PASS scenarios ranked, per comparable group; `score: null` is never 0). Frontend integration: `sendToComparison(scenarios)` from
`frontend/src/features/compare`. Details: `docs/comparison.md`.

## Feasibility Atlas: `POST /api/atlas`

Which tested landing dates work for which tested mission lengths, for one curated site and one spacecraft.
Request: `site_id`, `start_utc` (first landing), `step_hours` (sampling interval, 1-720), `count` (landing dates,
1-120), `durations_days` (1-8 values), `requirements` (the shared `MissionRequirements`); at most 600 cells.
Each cell is that exact mission evaluated by the canonical engine (`evaluate_scenario`, via the same
`scenario_to_mission` conversion as Planner / Rescue / Comparison), on the site's precomputed file:

| `status` | Meaning |
|---|---|
| `pass` / `fail` / `unknown` | The engine's eligibility for that mission |
| `not_evaluated` | No data at all for that landing (before / after the site file): not run, unlike `unknown` |

Per cell: `limiting` (the deciding requirement: the worst failure, the undecided one, or for a pass the one
closest to its limit, relative to the limit), `reason` (the engine's message for it) and compact `constraints`
(status, measured value or bounds, `margin` in display units). Requirement names, limits and units are listed
once in `requirements`. Nothing is interpolated between tested dates; `method` and `limitations` say so.
The site series is sliced to the searched window before evaluating (~7 ms per mission instead of ~95 ms);
`backend/tests/test_atlas.py` checks the verdicts equal the full-series ones, including at the end of the data.
Frontend: the "Feasibility Atlas" tab (`#app/atlas`, `frontend/src/features/atlas/`); "Open this mission in the
Planner" saves that exact scenario as a plan and runs it. Not implemented: boundary refinement, capability
studies, per-cell sensitivity.
