# Viability Engine: Architecture & Data Contracts

Owner: Member 2 (Mission Viability, Risk Assessment & Ranking)
Status: **Phase 2 implemented (sunlight / Earth-visibility time-series analysis, §5b); Phases 3–6
not started**, so there is still no pass/fail, risk, score or full `evaluate_scenario`.
Contracts are `SCHEMA_VERSION = "0.1.0-draft"`, `ENGINE_VERSION = "0.2.0-phase2"`.
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
| `compat/rescue.py` | Member 5's `evaluate_timeline(Scenario, Timeline) -> ViabilityResult` on top of this engine (§5a) | interface ✅, Phase 2 metrics verified; needs Phases 3–6 to run |
| `windows.py` | Sampling semantics, sample supports, three-valued condition runs, visibility windows (§5b) | 2 ✅ |
| `metrics.py` | Durations, percentages, longest outages, bounds, time-weighted means, data quality (§5b) | 2 ✅ |
| `analysis.py` | `analyze_environment` / `analyze_scenario`: the Phase 2 entry points → `EnvironmentAnalysis` | 2 ✅ |
| `constraints.py` | PASS / FAIL / UNKNOWN / NOT_APPLICABLE per requirement | 3 (stub) |
| `margins.py` | Duration and angular-clearance margins | 4 (stub) |
| `risk.py` | Rule-based risk indicators | 4 (stub) |
| `scoring.py` | Desirability score, ranking | 5 (stub) |
| `explain.py` | Explanations; `STANDARD_LIMITATIONS` (defined now) | 6 (stub) |
| `engine.py` | `evaluate_scenario(scenario, series)` pipeline | 3–6 (stub) |

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
| `SpacecraftConfiguration` | `power_source` (solar/radioisotope/battery_only/hybrid/other), `communication_mode` (direct_to_earth/relay/direct_and_relay/none), `max_continuous_darkness_s`, `max_communication_blackout_s`, `solar_power_min_disk_fraction` | No such limit → constraint `not_applicable`; no threshold → "power-lit" = direct sunlight (any visible disk) |
| `MissionRequirements` (hard) | `min_sunlight_percent` (share of *time* with direct sunlight), `min_earth_visibility_percent`, `min_simultaneous_percent`, `min_mean_solar_disk_fraction` (time-average of the visible disk fraction), `min_initial_sunlight_s`, `min_initial_earth_visibility_s`, `min_sun_clearance_deg`, `min_earth_clearance_deg`, `unknown_data_policy` | Not required |
| `RankingPreferences` (soft) | Non-negative relative weights for sunlight, Earth visibility, simultaneity, darkness/blackout/clearance margins | At least one weight > 0 |

**Power-lit / power-dark.** When `solar_power_min_disk_fraction` (rescue's `panel_threshold`,
e.g. 0.25) is set, a sample is power-lit iff `visible_fraction > 0` and `visible_fraction ≥`
the threshold (a fraction exactly equal to the threshold counts). Darkness, initial-sunlight,
first-sunset and simultaneous metrics use this definition. The fraction itself is always
preserved, and with a threshold of 0 "any visible disk" counts. **Without a threshold,
power-lit = direct sunlight (any visible disk, `visible_fraction > 0`)**, i.e. the same as a
threshold of 0. Direct, full and partial sunlight are always reported separately (§5b).

`unknown_data_policy` is either `report_unknown` (the default: undecidable checks are `unknown`)
or `worst_case` (unknown counts as dark or blacked out). **There is no optimistic option.**

## 5. Output contract: engine → Members 3, 4, 5, 6

`ViabilityAssessment` (JSON via `model_dump_json()`, FastAPI-ready):

| Field | Content |
|---|---|
| `scenario_id`, `site`, `evaluated_start_utc/end_utc` | Identity and evaluated range (= mission window) |
| `eligibility` | `pass` / `fail` / `unknown`, **derived** from `constraints` |
| `constraints[]` | `constraint_id`, `status` (+`not_applicable`), `threshold`, `unit`, `measured`, `message` |
| `metrics` | `MetricsSummary` (§5b): direct / full / partial / power-lit sunlight, Earth-visible and simultaneous durations and percentages; longest simultaneous window; longest darkness (power-dark), longest without direct sunlight, longest blackout; mean solar-disk fraction; initial sunlight / Earth visibility; time to first sunset / Earthset (`not_applicable` = never in range); mean Sun / Earth clearance; mean solar elevation |
| `windows[]` | `kind` (see §5b table), start/end/`duration_s`, `clipped_at_start/end` |
| `margins[]` | Signed headroom (+ = safe), `reference`, `related_constraint` |
| `risks[]`, `overall_risk` | Rule-triggered indicators with the explicit `rule` text |
| `score` | `score` 0–100 or null, `rank_eligible`, per-component breakdown |
| `explanations[]` | `category`, `severity`, `message` |
| `data_quality` | Provenance (incl. `is_synthetic`), basis, criteria, sampling policy, evaluated duration, sample count, largest gap, uncovered time and gap count, Sun/Earth unknown time and coverage %, `assumptions[]`, `warnings[]` |
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

**Status: interface only.** `evaluate_scenario` raises `NotImplementedError` until Phases 3–6,
so the layer does not yet work end-to-end. Phase 2 metrics are already verified against the
placeholder (coordination item 6 below). Rescue still imports its placeholder; nothing in
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
Coverage ends at the last sample, **except** that `evaluate_timeline` passes the mission end
and, when it is exactly one step after the last sample (rescue's bin layout), coverage is
extended to it. Under sample-and-hold the final hour is then represented instead of unknown.
No other layout is extended.

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
2. **Sample semantics: resolved in Phase 2.** Canonical rule = sample-and-hold (§5b), plus the one-step bin rule above, so rescue missions have no unknown final hour (tested). *Edge case for Arush:* `PrecomputedTimelineProvider.timeline` accepts a slice whose last bin *starts* at the file's final instant (2029-01-01T00:00Z). That bin claims one hour the file does not cover, and it only affects missions ending at 2029-01-01T01:00Z. Suggest requiring `last_bin_start + step <= times[-1]`.
3. **Panel threshold of 0.** The placeholder counts `fraction >= 0` (even total darkness) as lit. The canonical rule needs `fraction > 0`. Results will differ only at threshold 0.
4. **Naive datetimes.** Shared `Scenario.landing_utc` treats naive times as UTC, while the canonical API rejects them. The layer accepts the shared model's decision; flagged for the team.
5. **Two readers of `data/sites`.** `rescue/timeline/precomputed.py` and the site-file adapter parse the same files. They agree today (tested); keep one reader long-term.
6. **Equivalence check: done.** On real precomputed timelines (3 sites × 6 landing dates, 14-day missions, `panel_threshold` 0.25), all 11 `ViabilityMetrics` fields from Phase 2 equal the placeholder's to 1e-12 (`test_phase2_metrics_match_rescue_placeholder_on_real_data`). An ad-hoc run over 76 scenarios also found 0 mismatches. Expected differences remain only at `panel_threshold = 0` (item 3) and wherever data is unknown, where the canonical engine bounds instead of counting.

## 5b. Phase 2: sunlight and Earth-visibility time-series analysis

```python
from app.viability import analyze_environment, analyze_scenario, prepare_series
prepared = prepare_series(series)          # once per dataset (Member 5: reuse across candidates)
env = analyze_environment(prepared, start, end, solar_power_min_disk_fraction=0.25)
env = analyze_scenario(scenario, series)   # mission window + spacecraft threshold; checks site.id
env.metrics, env.conditions, env.windows, env.data_quality   # EnvironmentAnalysis (JSON-ready)
```

The lower-level `extract_windows`, `compute_metrics` and `summarize_data_quality` take
`(series | prepared, start, end, …)`. `compute_metrics` took windows in the Phase 1 stub, but
time-weighted fractions and angles need the samples. No verdicts are produced here (Phases 3–5).

### Sampling semantics (`SamplingPolicy`)

Samples are **instantaneous** Horizons geometry. Each sample is given a *support*, the
half-open interval it represents. Supports never overlap, never extend past
`coverage_end_utc` (or before `coverage_start_utc`), and never bridge a coverage gap
(spacing > `sampling.max_gap_s`; spacing exactly equal is not a gap).

| Policy | Sample *i* represents | Next to a gap / at the series end |
|---|---|---|
| `sample_hold` (**default**) | `[tᵢ, tᵢ₊₁)` | one `nominal_interval_s` (none if the series is irregular), capped at coverage |
| `nearest_sample` | from the midpoint with *i−1* to the midpoint with *i+1* | half a nominal interval, capped at coverage |

Why sample-and-hold is the default: it is the source convention. Andrew's `intervals()`
returns runs `[start, end)` ending at the first "off" sample, `next_transition_off()` reports
the first off sample's time, the status API describes "conditions at that hour", and rescue
uses hourly bins. Phase 2 windows are **identical** to Andrew's `intervals()` runs on all
real files (tested). His files are instants over `[2027-01-01, 2029-01-01]` *inclusive*
(17,545 samples), so the final sample sits at `coverage_end`, represents zero time, and the
2 years = 17,544 h are fully covered: no hour is lost and none is invented.

**Limitations of either policy:** no interpolation. A modeled transition falls on a sample
time (hold: up to one spacing late; because both ends shift alike, interior outage *durations*
are unbiased) or on a midpoint (nearest: within half a spacing). Events shorter than the
spacing can be missed. The policy is recorded in `data_quality.sampling_policy` and
`assumptions[]`. With hourly data, the two policies differ by ≤ 1 h on any metric (tested).
Interpolating the clearance zero-crossing (§10 item 7) is **not** implemented: it would claim
transition times the data do not establish, especially near terrain-horizon discontinuities.

All interval arithmetic is in **integer microseconds**, so windows cannot drift, overlap or
collapse through floating-point error; seconds appear only in the output.

### Conditions (three-valued: met / not met / unknown)

| Condition | Met when | Windows (met / not met / unknown) |
|---|---|---|
| `direct_sunlight` | any part of the disk visible (`visible`/`partial`; `visible_fraction > 0`) | `sunlight` / `darkness` / `sun_unknown` |
| `full_sunlight` | whole disk visible (`visible_fraction = 1`) | `full_sunlight` / – / – |
| `partial_sunlight` | `0 < visible_fraction < 1` | `partial_sunlight` / – / – |
| `power_eligible` | `visible_fraction > 0` and `≥ solar_power_min_disk_fraction`; no threshold → = direct sunlight | `power_lit` / `power_dark` / `power_unknown` |
| `earth_visible` | Earth **centre** strictly above the terrain horizon (Andrew's rule): a *direct-to-Earth line-of-sight opportunity*, not a radio link | `earth_visible` / `communication_blackout` / `earth_unknown` |
| `simultaneous` | power-eligible **and** Earth visible | `simultaneous_sun_earth` / – / `simultaneous_unknown` |

Plus `unknown_data` windows: time no sample represents (coverage gaps, outside the dataset).
Simultaneous uses Kleene logic: either part known *not met* → not met (Sun dark + Earth
unknown = **definitely not simultaneous**); otherwise either part unknown → unknown (Sun lit +
Earth unknown = unknown). Unknown is never folded into darkness or blackout. A fraction
implied by an apparent-disk state is used (`visible` → 1, `not_visible` → 0). Under a Sun
`center` criterion, full/partial and threshold tests are unknown unless a fraction is given
(warning emitted). Under an Earth `apparent_disk` criterion, a partially obstructed Earth
counts as not met (conservative).

Windows are maximal and sorted by start, then kind. Complementary kinds partition the range.
`clipped_at_start/end` is true when a window touches the range edge and the data do not show
the state changing exactly there (same state, or unknown, beyond the edge).

### Metric definitions (`MetricsSummary`, `ConditionSummary`)

Let `R = [S, E)` be the evaluated range, `|R| = E − S`. Per condition: `M`, `N`, `U` are the
met, not-met and unknown time in `R`.

| Metric | Definition | Bounds when `U > 0` |
|---|---|---|
| met duration / percent | `M`, `100·M/|R|` (denominator is always the whole range) | `[M, M+U]` |
| longest met / not met (outage) | longest single run, clipped to `R` | lower: unknown breaks runs; upper: unknown never breaks them (merged with adjacent runs) |
| initial met duration | continuous met time from `S` | lower: unknown counts as not met; upper: as met |
| time to first transition | `S` → first change of state | `unavailable` if the state at `S` is unknown; else `[end of first run, start of the first opposite run]` |
| time to first loss (sunset / Earthset) | `S` → first met→not-met edge; `not_applicable` if none in `R` | `[earliest edge or unknown start, start of first not-met run after the first met run]`; if no such run, upper = `|R|` and the reason says it may not occur |
| window counts, outages per day | confirmed windows only, per 86,400 s of `R` | (unknown periods may hide or merge windows) |
| mean solar-disk fraction | `∫ f dt / |R|` (time-weighted) | unknown `f` ∈ [0, 1] |
| mean solar elevation | `∫ el dt / |R|` | unknown `el` ∈ [−90°, 90°] |
| mean Sun / Earth clearance | `∫ (el − horizon) dt` over direct-sunlight / Earth-visible time ÷ that time; `not_applicable` if never met | unknown time may or may not qualify, with clearance ∈ [−180°, 180°] |

MetricsSummary mapping: `sunlight_*` = direct, `full_sunlight_*`, `partial_sunlight_*`,
`power_lit_*` = power-eligible. `longest_continuous_darkness` = longest power-dark,
`longest_without_direct_sunlight`, `longest_communication_blackout`. `initial_sunlight_duration`
and `time_to_first_sunset` use power-eligible; `simultaneous_*` and `longest_simultaneous_window`
too. Status: **known** = exact under the sampling policy (also when both bounds coincide,
e.g. an unknown hour that cannot change the longest outage); **bounded**; **unavailable** =
unknown over the whole range (e.g. all ephemeris missing); **not_applicable** = the event or
quantity does not exist. Unknown is never replaced by 0, and a measured 0 is `known`.
Angular bounds are deliberately wide: they stop a partial-coverage average from being read
as the mission average. Geometric-only clearance = elevation.

`data_quality` adds: sampling policy, evaluated duration, samples representing part of `R`,
largest sample spacing, uncovered time and number of uncovered intervals, Sun/Earth unknown time and
coverage %, `assumptions[]` (the sampling rule in words), and `warnings[]` (synthetic data,
geometric-only basis, Sun centre criterion, uncovered intervals, range beyond coverage,
samples with unknown states, threshold set but fractions missing). Provenance passes through
unchanged, **including the adapter's note that the lunar body-fixed frame is not verified**.
No probability or confidence score is produced.

### Real NASA-derived sites (full coverage 2027-01-01 → 2029-01-01, threshold 0.25)

| Site | Direct sun | Full | Partial | Power-lit (≥0.25) | Mean disk fraction | Earth visible | Simultaneous |
|---|---|---|---|---|---|---|---|
| connecting-ridge | 59.775 % | 51.550 % | 8.225 % | 57.438 % | 0.5569 | 49.555 % | 31.960 % |
| malapert-massif | 82.570 % | 76.208 % | 6.361 % | 81.019 % | 0.7963 | 99.886 % | 80.905 % |
| peak-near-shackleton | 37.289 % | 24.778 % | 12.511 % | 33.607 % | 0.3074 | 50.433 % | 18.924 % |
| shackleton-floor | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Site | Longest without direct sun | Longest power-dark (≥0.25) | Longest Earth blackout | Longest simultaneous |
|---|---|---|---|---|
| connecting-ridge | 293 h from 2027-04-20T08Z | 492 h from 2028-03-31T13Z | 352 h from 2027-01-23T20Z | 272 h |
| malapert-massif | 265 h from 2027-05-03T04Z | 266 h from 2027-05-03T04Z | 17 h from 2028-12-10T17Z | 2107 h |
| peak-near-shackleton | 2116 h (88 d) from 2028-02-23T06Z | 2802 h (117 d) from 2027-03-05T22Z | 347 h from 2027-01-23T20Z | 272 h |
| shackleton-floor | 17,544 h (entire range) | 17,544 h | 17,544 h | 0 |

Every metric is `known` (no unknown data). Durations equal the independently counted samples
× 1 h (tested). Against Andrew's `summary` (where definitions match): `earth_visible_pct` and
`mean_sun_fraction_pct` agree within ±0.05 pp. Our direct-sunlight % is 0.03 / 0.03 / 0.11 pp
*lower* than his `sunlit_pct` (CR / MM / PNS). That is the documented 3-decimal rounding of
fractions (§3a, slivers become 0) plus his unweighted mean over 17,545 instants versus our
17,544 h, not a disagreement. Full-sunlight and threshold-qualified percentages have no
counterpart in his summary and are not compared. Partial-disk time is 6–13 % at the lit sites,
so treating partial as full would overstate sunlight materially. The threshold matters: at
Malapert the longest direct-sunlight period (2,809 h) shrinks to 2,107 h at ≥ 0.25.

**Performance** (Python 3.14, Windows laptop, medians; machine-dependent): loading + validating
a 2-year file ≈ 0.4–0.6 s (once); `prepare_series` 40–60 ms (once); full 2-year analysis
80–100 ms incl. windows; a 7-day / 14-day mission on a prepared series ≈ 1.5 / 2 ms; 7-day
without preparing ≈ 60 ms. Prepare once per dataset when evaluating many candidates.

## 6. Assumptions and limitations

- The engine consumes geometry; it **does not compute** ephemerides, terrain or horizons.
- Illumination ≠ power; Earth line of sight ≠ radio link; viability ≠ landing safety
  (see `STANDARD_LIMITATIONS`).
- Apparent angles include light-time and aberration; there is no refraction (no atmosphere). For the Sun, apparent and geometric directions differ by roughly 20 arcsec (≈0.006°). That is small but not zero for grazing geometry, so the series must state its `angle_type`.
- Earth is treated with the centre criterion by default. Its ~1.9° apparent disk, and *which* ground station on it is in view, are not modelled.
- Sampled data can miss short events, and transition times are resolved only to the sample spacing (§5b). Member 1 may sample more densely near transitions, since irregular sampling is supported.
- Mission-scoped outages: an outage spanning landing or mission end is measured within the mission only (flagged `clipped_at_start/end`). Battery state at landing is not modelled.
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
ruff format --check --line-length 120 app/viability tests/viability             # optional
mypy --strict --follow-imports=silent app/viability tests/viability             # optional
```

Phase 2 tests: `test_windows.py` (sampling semantics, gaps, clipping, partition, µs exactness),
`test_metrics.py` (every metric with hand-derived values, bounds, three-valued logic,
thresholds, JSON), `test_real_sites_phase2.py` (four real files: independent sample counts,
Andrew's `intervals()`, his summary, regression outages), and the Phase 2 additions to
`test_rescue_compat.py` (bin rule, equivalence with the placeholder).

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
| 2 ✅ | Windows, durations, percentages, longest outages, bounded metrics, coverage gaps (§5b) |
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

**Engine semantics (decided in Phase 2; team review welcome):**
7. *Integration rule:* **decided.** Sample-and-hold by default (the source convention), with nearest-sample (midpoint) available as `SamplingPolicy.NEAREST_SAMPLE` for sensitivity checks. Interpolated zero-crossings are not used (§5b). Member 6 may want to quantify the timing uncertainty (≤ one spacing).
8. *Partial sunlight:* **decided.** All three are reported separately: direct (fraction > 0, matching Andrew's `sunlit_pct`), full and partial. Power-eligibility uses `solar_power_min_disk_fraction`, and without a threshold it equals direct sunlight. Open for Phase 3: whether `min_sunlight_percent` should test direct sunlight (current definition) or power-lit time.
9. *Darkness spanning mission start:* clipped to the mission and flagged `clipped_at_start`. Battery state at landing is still a Phase 3/4 question (e.g. a margin rule).

**With Members 3/4/5:** the field names above; whether `windows[]` should be paginated or
down-sampled for long missions (a full 2-year analysis yields 300–600 windows per site); and whether failed scenarios should be scored, so rescue can
show the closest misses (currently allowed but unranked).
