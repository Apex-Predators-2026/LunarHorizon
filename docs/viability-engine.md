# Viability Engine: Architecture & Data Contracts

Owner: Member 2 (Mission Viability, Risk Assessment & Ranking)
Status: **Phase 1, draft for team review.** Contracts are `SCHEMA_VERSION = "0.1.0-draft"`.
The input contract (§3) is a **proposal for Member 1 to review** before it counts as final.

Code: `backend/app/viability/`  ·  Tests: `backend/tests/viability/`

---

## 1. Architecture

The engine is a pure Python library: no network, no file I/O in the evaluation path, no
frontend/3D/optimisation code. Members 3, 4 and 5 call one function; Member 1 supplies data.

```
data/sites/<id>.json ─► adapters.load_site_file() ─► ScientificTimeSeries ─┐
                                                                            ├─► evaluate_scenario() ─► ViabilityAssessment ─► Members 3, 4, 6
Members 3/4/5 ─────────────────────────────────────── MissionScenario ──────┘                                 │
                                                                    rank_assessments() ◄─────────────────────┘─► RankingResult ─► Members 4, 5
```

| Module | Responsibility | Phase |
|---|---|---|
| `conventions.py` | Units, UTC/strict scalar types, base model, schema version | 1 ✅ |
| `enums.py` | All shared enumerations (serialize as lowercase strings) | 1 ✅ |
| `inputs.py` | Scientific input contract + consistency validators | 1 ✅ |
| `mission.py` | Site, spacecraft, hard requirements, soft preferences, scenario | 1 ✅ |
| `outputs.py` | Assessment/ranking contract + invariant validators, `derive_eligibility` | 1 ✅ |
| `fixtures/` | Synthetic datasets (JSON) + deterministic builders | 1 ✅ |
| `adapters/site_file.py` | Andrew's precomputed site files → `ScientificTimeSeries` (§3a) | 1 ✅ |
| `compat/rescue.py` | Member 5's `evaluate_timeline(Scenario, Timeline) -> ViabilityResult` on top of this engine (§5a) | interface ✅, needs Phases 2–6 to run |
| `windows.py` | Samples → visibility windows | 2 (stub) |
| `metrics.py` | Durations, percentages, longest outages, data-quality summary | 2 (stub) |
| `constraints.py` | PASS / FAIL / UNKNOWN / NOT_APPLICABLE per requirement | 3 (stub) |
| `margins.py` | Duration and angular-clearance margins | 4 (stub) |
| `risk.py` | Rule-based risk indicators | 4 (stub) |
| `scoring.py` | Desirability score, ranking | 5 (stub) |
| `explain.py` | Explanations; `STANDARD_LIMITATIONS` (defined now) | 6 (stub) |
| `engine.py` | `evaluate_scenario(scenario, series)` pipeline | 2–6 (stub) |

Stubs have final signatures and raise `NotImplementedError("Phase N: …")`.

Three verdicts are kept **separate**:
- **Eligibility** (`pass`/`fail`/`unknown`): hard constraints only.
- **Score** (0–100): desirability among scenarios. It never changes eligibility.
- **Risk level** (`low`/`moderate`/`high`/`unknown`): explicit rules, not probabilities.

## 2. Units and conventions (normative)

| Quantity | Convention |
|---|---|
| Time | Timezone-aware **UTC** ISO 8601 (`2027-01-01T00:00:00Z`). Naive times, non-zero offsets and epoch numbers are rejected. |
| Duration | Seconds (`*_s`), float |
| Angles | Degrees (`*_deg`) |
| Percent / fraction | 0–100 (`*_percent`) / 0–1 |
| Latitude | Selenographic, north positive (south pole = −90) |
| Longitude | **East positive, [−180, 180]**. The site-file adapter converts Andrew's 0–360 values (§3a). |
| Frame | **Unverified.** The DEM is Moon2000 (IAU 2000 sphere, LOLA). The frame of Horizons `coord@301` sites is not yet confirmed as the same (ME vs PA, ~1 km apart). Don't claim spatial compatibility until it is (§10). |
| Azimuth | Clockwise from local north, [0, 360). Undefined exactly at a pole. |
| Elevation | Above the local horizontal plane (⊥ radius vector), [−90, 90] |
| Terrain horizon | Elevation of the terrain skyline at an azimuth; **may be negative** (summits) |
| Clearance | `elevation_deg − horizon_deg` (geometric-only: `elevation_deg − 0`) |
| Unknown | `null` + explicit state. **Never 0, never NaN.** |

All models: unknown fields rejected, immutable, strict numbers (no `true` → 1.0, no
`"1.5"` → 1.5) and strict booleans.

## 3. Input contract: Member 1 → engine (PROPOSED)

One `ScientificTimeSeries` per site and period. See `fixtures/synthetic/*.json` for
complete examples.

```jsonc
{
  "schema_version": "0.1.0-draft",
  "dataset_id": "example-site-2027",       // illustrative values only
  "site": { "id": "example-site", "name": "…", "lat": -89.5, "lon": 0.0, "surface_height_m": null },
  "observer_height_m": 2.0,                 // panel/antenna height used for horizons
  "coverage_start_utc": "…Z", "coverage_end_utc": "…Z",
  "calculation_basis": "terrain_aware",     // | "geometric_only"
  "angle_type": "apparent",                 // | "geometric"
  "sun_criterion": "apparent_disk",         // | "center"
  "earth_criterion": "center",
  "sampling": { "nominal_interval_s": 3600.0, "max_gap_s": 5400.0 },
  "provenance": { "is_synthetic": false, "ephemeris_source": "JPL Horizons …",
                  "terrain_source": "LOLA …", "terrain_resolution_m": 20.0,
                  "horizon_azimuth_step_deg": 0.5, "generated_at_utc": "…Z",  // or null = not recorded
                  "generator": "engine vX", "references": [], "notes": null },
  "uncertainty": { "ephemeris_angle_uncertainty_deg": null, "horizon_angle_uncertainty_deg": null },
  "horizon_profile": { "azimuths_deg": [0.0, 0.5, …], "horizon_deg": [1.2, null, …] },  // optional
  "samples": [
    { "time_utc": "…Z",
      "sun":   { "azimuth_deg": 120.0, "elevation_deg": 1.5, "horizon_deg": 0.9,
                 "state": "visible", "visible_fraction": 1.0, "angular_radius_deg": 0.2666 },
      "earth": { "azimuth_deg": 20.0, "elevation_deg": 3.0, "horizon_deg": 1.0,
                 "state": "visible", "visible_fraction": null, "angular_radius_deg": null } }
  ]
}
```

`angular_radius_deg` (optional) is the apparent radius actually used for disk calculations.
`provenance.generated_at_utc` is required but may be `null` when the producer didn't record it.
It is never back-filled.

**States:** `visible`, `partial` (only with `apparent_disk`), `not_visible`, `unknown`.

- `center`: visible iff the body centre is strictly above the horizon (clearance 0 counts as not visible).
- `apparent_disk`: `visible` = whole disk above, `partial` = some, `not_visible` = none.

**Validation rules (enforced):**
1. Samples strictly increase in time and lie within `[coverage_start, coverage_end]`.
2. `azimuth_deg`, `elevation_deg`, `horizon_deg` and `state` are required but nullable. A producer must write `null`, not omit the field.
3. A definite state needs `elevation_deg`. If `terrain_aware`, it also needs `horizon_deg` (and so `azimuth_deg`). **When terrain is unknown, the state must be `unknown`.** The horizon is never assumed to be 0.
4. `geometric_only` series carry no `horizon_deg`, no `horizon_profile` and no `terrain_source`. `terrain_aware` series must name a `terrain_source`.
5. States must agree with the angles, to within 1e-3° to allow for rounding: a centre above the horizon cannot be `not_visible`, and a centre below it cannot be `visible`.
6. With `apparent_disk`, `visible_fraction` 0 / (0,1) / 1 must match `not_visible` / `partial` / `visible`. A fraction with state `unknown` is rejected.
7. Missing samples are not darkness. Consecutive samples more than `sampling.max_gap_s` apart bound a **coverage gap**, which Phase 2 treats as unknown.
8. `schema_version` must match exactly.

Validating a two-year hourly series (~17.5k samples) takes about 0.3 s, or about 0.6 s
through the adapter. Load once and reuse the object for many scenarios (Member 5).

## 3a. Andrew's precomputed site files and the adapter

Andrew's engine (`backend/app/engine/`, run by `backend/scripts/precompute.py`) writes one
**column-oriented** file per curated site, `data/sites/<id>.json` (format in
`docs/interfaces.md`). Index `i` across every `timeline` array is one hourly time step,
2027-01-01 → 2029-01-01 (17,545 steps). His format and engine are **not modified**.
`app.viability.adapters` translates it:

```python
from app.viability.adapters import load_site_file
series = load_site_file("data/sites/peak-near-shackleton.json")   # -> ScientificTimeSeries
```

| Site-file field | Contract field | Conversion |
|---|---|---|
| `site.id`, `name`, `lat` | `site.id`, `name`, `lat` | unchanged |
| `site.lon` (0–360 °E) | `site.lon` [−180, 180] | `lon − 360` if `lon > 180`; original kept in `provenance.notes` |
| `site.ground_height_m` | `site.surface_height_m` | unchanged (both: m above the 1737.4 km sphere) |
| `site.observer_height_m` | `observer_height_m` | unchanged |
| `site.source` | `provenance.references[0]` | unchanged |
| `site.x_m`, `y_m` | `provenance.notes` | recorded (Moon Trek south-polar stereographic) |
| `meta.ephemeris` | `provenance.ephemeris_source`; `angle_type = apparent` | rejected unless it states "apparent" |
| `meta.terrain[]` | `provenance.terrain_source`; `calculation_basis = terrain_aware` | an empty list is rejected |
| `meta.step` | `sampling.nominal_interval_s`; `max_gap_s = 1.5 × step` | `1h`/`30m`/`10 min`/`1d`; samples closer than the step are rejected |
| `meta.generated_utc` *(absent today)* | `provenance.generated_at_utc` | otherwise `null` |
| `horizon.azimuth_deg`, `elevation_deg` | `horizon_profile` | step → `horizon_azimuth_step_deg` (0.5°); `distance_m` is not carried |
| `timeline.time_utc` (`…T00:00Z`) | `samples[i].time_utc` | must be UTC; other offsets or naive times are rejected |
| `sun_azimuth/elevation/horizon_deg` | `sun.*` | azimuth exactly 360.0 → 0.0 |
| `sun_visible_fraction` | `sun.visible_fraction` + `sun.state` | 0 → `not_visible`, (0,1) → `partial`, 1 → `visible`; `sun_criterion = apparent_disk` |
| `earth_azimuth/elevation/horizon_deg` | `earth.*` | azimuth exactly 360.0 → 0.0 |
| `earth_visible` | `earth.state` | `visible` / `not_visible`; `earth_criterion = center` (his rule: margin > 0) |
| `earth_margin_deg` | *(not stored)* | checked against `elevation − horizon` (±0.002°) and against `earth_visible` |
| `sun/earth_angular_radius_deg` *(absent today)* | `*.angular_radius_deg` | otherwise `null` |
| `summary` | *(not used)* | test cross-check only |

**Missing data:** a `null` or `NaN` element makes that body's state `unknown` and keeps the
known values. A visibility value whose input angle is missing (for example a fraction without a
horizon) is **rejected as inconsistent**. A missing horizon never becomes a clear horizon.
`Infinity`, booleans or strings in numeric columns, unequal array lengths, missing columns or
metadata, fewer than 2 samples, and states that contradict the angles all raise
`SiteFileError` with the field and index. Unknown extra columns are listed in
`provenance.notes`, not silently dropped.

**Results on the committed files:** all four validate.

| Site | lon (file → contract) | Sun visible / partial / not visible | Earth visible |
|---|---|---|---|
| connecting-ridge | 209.94767 → −150.05233 | 9044 / 1443 / 7058 | 49.6% |
| malapert-massif | 357.6326 → −2.3674 | 13371 / 1116 / 3058 | 99.9% |
| peak-near-shackleton | 126.27302 (unchanged) | 4347 / 2196 / 11002 | 50.4% |
| shackleton-floor (control) | 129.78 (unchanged) | 0 / 0 / 17545 | 0% |

**Known precision effect:** the file rounds fractions to 3 decimals. Disk slivers below 0.0005
(centre 0.261–0.266° below the horizon) are written as 0, so they become `not_visible`. That is
4–16 samples per site (0.02–0.09 percentage points of sunlit time), and it explains why his
`summary.sunlit_pct`, which uses unrounded values, is slightly higher. The adapter stays faithful
to the file; recomputing fractions is Member 1's job.

## 4. Mission models: Members 3/4/5 → engine

`MissionScenario` = `scenario_id`, `site` (`LandingSite`), `mission_start_utc` <
`mission_end_utc` (≤ 10 years), `spacecraft`, `requirements`, `preferences`.

| Model | Fields | Meaning of `null` |
|---|---|---|
| `LandingSite` | `id`, `name`, `lat`, `lon`, `surface_height_m?` | Same field names as the shared `Site` |
| `SpacecraftConfiguration` | `power_source` (solar/radioisotope/battery_only/hybrid/other), `communication_mode` (direct_to_earth/relay/direct_and_relay/none), `max_continuous_darkness_s`, `max_communication_blackout_s`, `solar_power_min_disk_fraction` | No such limit → constraint `not_applicable`; no threshold → "power-lit" follows the Sun state |
| `MissionRequirements` (hard) | `min_sunlight_percent` (share of *time* sunlit), `min_earth_visibility_percent`, `min_simultaneous_percent`, `min_mean_solar_disk_fraction` (time-average of the visible disk fraction), `min_initial_sunlight_s`, `min_initial_earth_visibility_s`, `min_sun_clearance_deg`, `min_earth_clearance_deg`, `unknown_data_policy` | Not required |

**Power-lit / power-dark.** When `solar_power_min_disk_fraction` (rescue's `panel_threshold`,
e.g. 0.25) is set, a sample is power-lit iff `visible_fraction > 0` and `visible_fraction ≥`
the threshold. Darkness, initial-sunlight and first-sunset metrics use this definition. The
fraction itself is always preserved, and with a threshold of 0 "any visible disk" counts.
| `RankingPreferences` (soft) | Non-negative relative weights for sunlight, Earth visibility, simultaneity, darkness/blackout/clearance margins | At least one weight > 0 |

`unknown_data_policy` is either `report_unknown` (the default: undecidable checks are `unknown`)
or `worst_case` (unknown counts as dark or blacked out). **There is no optimistic option.**

## 5. Output contract: engine → Members 3, 4, 5, 6

`ViabilityAssessment` (JSON via `model_dump_json()`, FastAPI-ready):

| Field | Content |
|---|---|
| `scenario_id`, `site`, `evaluated_start_utc/end_utc` | Identity and evaluated range (= mission window) |
| `eligibility` | `pass` / `fail` / `unknown`, **derived** from `constraints` |
| `constraints[]` | `constraint_id`, `status` (+`not_applicable`), `threshold`, `unit`, `measured`, `message` |
| `metrics` | Sunlight / partial-sunlight / Earth-visible / simultaneous durations and percentages; longest darkness; longest blackout; mean solar-disk fraction; initial sunlight / Earth visibility; time to first sunset / Earthset (`not_applicable` = never in range); mean Sun / Earth clearance; mean solar elevation |
| `windows[]` | `kind` (sunlight, darkness, earth_visible, communication_blackout, simultaneous_sun_earth, unknown_data), start/end/`duration_s`, `clipped_at_start/end` |
| `margins[]` | Signed headroom (+ = safe), `reference`, `related_constraint` |
| `risks[]`, `overall_risk` | Rule-triggered indicators with the explicit `rule` text |
| `score` | `score` 0–100 or null, `rank_eligible`, per-component breakdown |
| `explanations[]` | `category`, `severity`, `message` |
| `data_quality` | Provenance (incl. `is_synthetic`), basis, criteria, sample count, largest gap, coverage % |
| `limitations[]` | Always includes `explain.STANDARD_LIMITATIONS` |

**`Metric`** = `{status, unit, value, lower, upper, reason}`:
- `known`: exact `value`.
- `bounded`: data partly unknown, so the true value lies in `[lower, upper]`.
- `unavailable`: all values null; a `reason` is required.
- `not_applicable`: all values null.

**Invariants enforced by validators:**
- `eligibility`: any constraint `fail` → `fail`; otherwise any `unknown` → `unknown`; otherwise `pass`.
- `score.rank_eligible == (eligibility == pass)`. A failed scenario may still carry a score, so Member 5 can find "the closest miss", but it is never rank-eligible.
- `RankingResult` lists every `pass` entry (ranked 1..n), then every `unknown`, then every `fail` (both unranked), whatever their scores.
- Windows lie inside the evaluated range, and a window's `duration_s` equals end − start.

## 5a. Mission Rescue compatibility (Option A)

Member 5's rescue calls `evaluate_timeline(scenario: Scenario, timeline: Timeline) -> ViabilityResult`
(shared models in `app/models.py`; `Timeline` in `app/rescue/timeline/base.py`).
`app.viability.compat.rescue` provides that exact signature on top of the canonical engine.
It converts shapes and units only and **never computes a viability quantity itself**.

```
Scenario ─scenario_to_mission─► MissionScenario ──┐
Timeline ─timeline_to_series──► ScientificTimeSeries ┴► evaluate_scenario() ─► ViabilityAssessment
ViabilityResult ◄────────────── assessment_to_result ◄──────────────────────────────┘
```

**Status: interface only.** `evaluate_scenario` raises `NotImplementedError` until Phases 2–6,
so the layer does not yet work end-to-end. Rescue still imports its placeholder; nothing in
`app/rescue/` was changed. To switch later, Member 5 changes one import in
`app/rescue/viability/__init__.py` to `from app.viability.compat.rescue import evaluate_timeline`
(keeping `CHECKS` / `CHECK_BY_CONSTRAINT`). `evaluate_timeline_detailed` returns the
canonical assessment too, and `make_evaluate_fn(engine)` fits `Evaluator(evaluate=...)`.

**Scenario → MissionScenario**

| Rescue | Canonical | Conversion |
|---|---|---|
| `site.id` (e.g. `custom:-89.46012,221.98000`) | `site.id` | characters outside `[A-Za-z0-9._-]` → `_` (`custom_-89.46012_221.98000`) |
| `site.lon` (0–360 °E from the catalog) | `site.lon` | `lon − 360` if `> 180` (same function as the site-file adapter) |
| `landing_utc`, `duration_days` | `mission_start_utc`, `mission_end_utc` | start = landing (UTC); end = landing + duration |
| `battery_hours` | `spacecraft.max_continuous_darkness_s` | × 3600 (power-dark per the threshold) |
| `panel_threshold` | `spacecraft.solar_power_min_disk_fraction` | unchanged (configurable) |
| `max_comms_gap_hours` | `spacecraft.max_communication_blackout_s` | × 3600 |
| `min_sunlight_fraction` (mean disk fraction) | `requirements.min_mean_solar_disk_fraction` | unchanged; **not** `min_sunlight_percent` |
| `min_earth_visibility_fraction` | `requirements.min_earth_visibility_percent` | × 100 |
| `min_initial_sun_hours` / `min_initial_comms_hours` | `min_initial_sunlight_s` / `min_initial_earth_visibility_s` | × 3600 |
| *(implied by rescue's checks)* | `power_source = solar`, `communication_mode = direct_to_earth` | documented inference |

**Timeline → ScientificTimeSeries:** columns are passed through the **same per-sample
converters as the site-file adapter**, so `NaN` → `unknown`, a 360° azimuth → 0°, and a fraction
without its horizon is rejected. `source` `precomputed:*` → `is_synthetic = false`, apparent
angles. `synthetic*` → `is_synthetic = true`, geometric angles. Any other source is rejected,
because real data can't be told from synthetic. A real timeline converted this way is
sample-for-sample identical to `load_site_file` on the same file (tested).

**ViabilityAssessment → ViabilityResult (lossy, never optimistic):**

| Canonical | Rescue |
|---|---|
| `eligibility == pass` | `passes = true`; any `fail` / `unknown` → `passes = false` |
| constraint `fail` | `Violation` with rescue field name, rescue units (h, fraction) |
| constraint `unknown` | `Violation`, message prefixed `UNKNOWN (incomplete data; worst case shown):` |
| `Metric` known | value, unit-converted (s → h, percent → fraction) |
| `Metric` bounded | unfavourable bound (lower for "more is better", upper for outages) |
| `Metric` unavailable | worst case within the mission: 0 for fractions and initial hours; whole mission for gaps; 0 h to first sunset/Earthset; `null` clearances; **error** for mean solar elevation (no defensible worst case) |
| first sunset/Earthset `not_applicable` | `null` (rescue's "never during the mission") |
| `score` null | 0.0 if not passing; **error** if passing |
| a failing constraint with no rescue field | **error** (can't occur from a rescue scenario) |

Every constraint the layer creates maps 1:1 onto rescue's `CHECK_BY_CONSTRAINT` (tested), so
loosening and explanations keep working.

**Coordination with Arush (Member 5):**
1. **Unknown state.** Proposed: add optional `eligibility: "pass" | "fail" | "unknown"` (and/or `score: float | None`) to `ViabilityResult`. Until then, UNKNOWN reads as a failure with worst-case numbers. Rescue's **loosening may suggest relaxing a requirement because data is missing**. Suggest skipping loosening for violations whose message starts with `UNKNOWN`.
2. **Sample semantics.** Rescue treats each hourly sample as a 1 h bin, so the last sample is at landing + duration − 1 h. The canonical Phase 2 integration rule is still open (§10). If samples are treated as instants, the final hour is uncovered and could make every rescue result UNKNOWN. Proposal: for regular series, hold each sample for one step (sample-and-hold). That matches rescue's placeholder and Andrew's `intervals()`.
3. **Panel threshold of 0.** The placeholder counts `fraction >= 0` (even total darkness) as lit. The canonical rule needs `fraction > 0`. Results will differ only at threshold 0.
4. **Naive datetimes.** Shared `Scenario.landing_utc` treats naive times as UTC, while the canonical API rejects them. The layer accepts the shared model's decision; flagged for the team.
5. **Two readers of `data/sites`.** `rescue/timeline/precomputed.py` and the site-file adapter parse the same files. They agree today (tested); keep one reader long-term.
6. **Equivalence check.** Once Phase 2 exists, compare canonical vs placeholder metrics on the same timelines before switching the import.

## 6. Assumptions and limitations

- The engine consumes geometry; it **does not compute** ephemerides, terrain or horizons.
- Illumination ≠ power; Earth line of sight ≠ radio link; viability ≠ landing safety
  (see `STANDARD_LIMITATIONS`).
- Apparent angles include light-time and aberration; there is no refraction (no atmosphere). For the Sun, apparent and geometric directions differ by roughly 20 arcsec (≈0.006°). That is small but not zero for grazing geometry, so the series must state its `angle_type`.
- Earth is treated with the centre criterion by default. Its ~1.9° apparent disk, and *which* ground station on it is in view, are not modelled.
- Sampled data can miss short events. Member 1 may sample more densely near transitions, since irregular sampling is supported.
- One `observer_height_m` per series. If solar arrays and antennas sit at different heights, their horizons differ (§10).
- With no applicable hard constraints, eligibility is `pass` (vacuously); data issues surface through risks.

## 7. Synthetic fixtures

`backend/app/viability/fixtures/synthetic/*.json`: **synthetic, not NASA-derived**. The
site is fictional (`synthetic-site-a`), `provenance.is_synthetic = true`, and the notes start
with `SYNTHETIC FIXTURE - NOT REAL DATA`. They use exactly the real input schema.

| Fixture | Feature |
|---|---|
| `continuous_sunlight` | Sun visible 24 h; Earth hidden |
| `continuous_darkness` | Sun hidden 24 h; Earth visible |
| `intermittent_sunlight` | 48 h cycle through visible → partial → not visible |
| `continuous_earth_visibility` | Earth always visible, 2 h sampling |
| `intermittent_blackouts` | Earth ~8 h visible / ~8 h blocked |
| `simultaneous_sun_earth` | Sun and Earth overlap only part of the time |
| `missing_samples` | 7 h absent-sample gap; samples with missing ephemeris (`unknown`) |
| `unknown_terrain` | Horizon profile with an unknown sector; Sun goes `unknown`, not dark |
| `irregular_sampling` | Irregular timestamps, dense around a sunset |
| `mission_boundary` | Dark at both coverage bounds; Earth clearance exactly 0 at noon |
| `geometric_only` | No terrain; `horizon_deg` null throughout |

```python
from app.viability.fixtures import load_fixture, example_scenario
series = load_fixture("intermittent_sunlight")
scenario = example_scenario(series)
```

Regenerate after changing `builders.py` with `cd backend && python -m app.viability.fixtures`.
A test fails if the JSON and the builders drift apart.

## 8. Testing

```bash
cd backend
python -m pytest tests/viability -q
ruff check --line-length 120 app/viability tests/viability                      # optional
mypy --strict --follow-imports=silent app/viability tests/viability             # optional
```

Requires Python ≥ 3.11, `pydantic` 2 and `pytest` (both already in `requirements.txt`).
No new dependencies.
- The core package, `adapters/` and `compat/rescue.py` import neither NumPy nor FastAPI.
- `test_rescue_compat.py` uses rescue's timeline providers, which need `numpy`.
- The adapter tests read the committed `data/sites/*.json`.
- `--follow-imports=silent` keeps mypy from reporting existing strict-mode findings in teammates' modules.

Run `python -m pytest` in `backend/` for the whole team suite; `backend/pytest.ini` is the team's config.

## 9. Roadmap

| Phase | Deliverable |
|---|---|
| 2 | Windows, durations, percentages, longest outages, bounded metrics, coverage gaps |
| 3 | Constraint evaluation with unknown-data policy; site/time compatibility checks |
| 4 | Duration and clearance margins; risk rules |
| 5 | Normalised, explainable score; ranking |
| 6 | Assembled `ViabilityAssessment`; explanation text |
| 7 | Real-data tests with Member 1 output; validation with Member 6; FastAPI endpoint wiring |

## 10. Remaining integration decisions

**Settled by reading Andrew's engine (no action needed):**
- Sun = apparent disk, using the distance-dependent radius from Horizons `Ang-diam` (0.2666° fallback). Earth = centre above terrain, margin > 0.
- `horizon_deg` = the 0.5°-sampled skyline interpolated at the body-centre azimuth. It includes exact spherical curvature and the 2 m observer height.
- Angles are Horizons apparent az/el (quantity 4), measured against the spherical horizon. Times are UT, hourly.
- Longitude: the file keeps 0–360; the adapter converts (no change needed on his side).

**Open, with Member 1 (Andrew):**
1. **Lunar body-fixed frame (unresolved).** The LOLA DEMs are Moon2000/ME. Which frame does Horizons use for `CENTER='coord@301'` geodetic site coordinates? ME and PA differ by ~1 km on the surface, which matters for which terrain point is "the site". Spatial compatibility is not claimed until this is verified.
2. Precision: write `sun_visible_fraction` with more decimals (e.g. 6), or add a `sunlit` column, so slivers below 0.0005 are not lost (§3a).
3. Add `sun_angular_radius_deg` (and `meta.generated_utc` / generator version) to the file. The adapter already reads them if present.
4. Should the shared `TimelineStep` (`docs/interfaces.md`, `app/models.py`, `types.ts`) gain `unknown` states / nullable horizons for custom sites? His precompute currently errors out rather than emitting gaps.
5. Is one observer height enough, or are separate solar-array and antenna heights needed?
6. Can uncertainty estimates be provided (with Member 6)?

**Engine semantics (Phase 2, team input welcome):**
7. Integration rule between samples: transition at the interpolated zero-crossing of clearance, or at the sample midpoint?
8. Does `partial` sunlight count as sunlit, dark, or fraction-weighted toward sunlight duration and longest darkness? This is material: partial-disk hours are 6–13% of the timeline at each real site that gets any sun. Andrew's summaries use "any part of the disk" (fraction > 0). For power, the configurable `solar_power_min_disk_fraction` (rescue default 0.25) now answers it per scenario. The default when no threshold is set is still to decide.
9. Darkness spanning mission start is clipped. Is landing assumed to happen with a full battery?

**With Members 3/4/5:** the field names above; whether `windows[]` should be paginated or
down-sampled for long missions; and whether failed scenarios should be scored, so rescue can
show the closest misses (currently allowed but unranked).
