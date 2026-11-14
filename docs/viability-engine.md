# Viability Engine: Architecture & Data Contracts

Owner: Member 2 (Mission Viability, Risk Assessment & Ranking)
Status: **Phases 2–6 implemented and integrated** (sunlight / Earth-visibility analysis, §5b;
constraint verdicts PASS / FAIL / UNKNOWN and eligibility, §5c; operational margins and rule-based
risk indicators, §5d; explainable desirability score and eligibility-aware ranking, §5e–§5f;
evidence-based explanations and Rescue compatibility validation, §5g).
`evaluate_scenario` returns a complete `ViabilityAssessment`, and since Phase 6 its `explanations` list is
always filled (§5g). Rescue still runs on its placeholder: switching is Member 5's decision (§5g, Rescue findings).
Contracts are `SCHEMA_VERSION = "0.1.0-draft"`, `ENGINE_VERSION = "0.6.0-phase6"`.
Synchronized with `origin/main` as of 2026-11-14 (`b244b68`: whole-Moon terrain, site-file generator **1.2**, §3a) and
Member 5's shared `ViabilityResult` with `eligibility` / nullable `score` / `Violation.is_unknown` (§5a).
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
| `compat/rescue.py` | Member 5's `evaluate_timeline(Scenario, Timeline) -> ViabilityResult` on top of this engine (§5a) | 6 ✅ `rescue-compat/0.3.0`: validated side by side with the placeholder on real data (§5g) |
| `windows.py` | Sampling semantics, sample supports, three-valued condition runs, visibility windows (§5b) | 2 ✅ |
| `metrics.py` | Durations, percentages, longest outages, bounds, time-weighted means, data quality (§5b) | 2 ✅ |
| `analysis.py` | `analyze_environment` / `analyze_scenario`: the Phase 2 entry points → `EnvironmentAnalysis` | 2 ✅ |
| `constraints.py` | PASS / FAIL / UNKNOWN / NOT_APPLICABLE per requirement, eligibility; `assess_constraints` (§5c) | 3 ✅ |
| `margins.py` | Signed operational margins per hard constraint, bounds, classification (§5d) | 4 ✅ |
| `risk.py` | Rule-based risk indicators and `overall_risk`, consuming the margins (§5d) | 4 ✅ |
| `scoring.py` | Desirability score (5A); re-exports `rank_assessments` from `ranking.py` | 5 ✅ |
| `ranking.py` | Eligibility-aware, comparability-checked ranking (5B) | 5 ✅ |
| `explain.py` | Evidence-based explanations (presentation only); `STANDARD_LIMITATIONS` (§5g) | 6 ✅ |
| `engine.py` | `evaluate_scenario(scenario, series)` pipeline, Phases 2–6 | 6 ✅ |

No stubs remain.

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
| Frame | Moon Mean-Earth/polar-axis (ME) **as stated by Member 1** (`meta.frame`; his engine checks the Horizons header for `MEAN_ME`; LOLA ME per product docs). Recorded in `provenance.coordinate_frame`; **not independently verified by this engine** (ME vs PA ≈ 1 km at the surface; §10). |
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
It is never back-filled. Optional `provenance.coordinate_frame` records the lunar body-fixed
frame **as stated by the producer** (not verified by this engine). Optional top-level
`fraction_decimals` states how many decimals the producer rounded `visible_fraction` to.

**States:** `visible`, `partial` (only with `apparent_disk`), `not_visible`, `unknown`.

- `center`: visible iff the body centre is strictly above the horizon (clearance 0 counts as not visible).
- `apparent_disk`: `visible` = whole disk above, `partial` = some, `not_visible` = none.

**Validation rules (enforced):**
1. Samples strictly increase in time and lie within `[coverage_start, coverage_end]`.
2. `azimuth_deg`, `elevation_deg`, `horizon_deg` and `state` are required but nullable. A producer must write `null`, not omit the field.
3. A definite state needs `elevation_deg`. If `terrain_aware`, it also needs `horizon_deg` (and so `azimuth_deg`). **When terrain is unknown, the state must be `unknown`.** The horizon is never assumed to be 0.
4. `geometric_only` series carry no `horizon_deg`, no `horizon_profile` and no `terrain_source`. `terrain_aware` series must name a `terrain_source`.
5. States must agree with the angles, to within 1e-3° to allow for rounding: a centre above the horizon cannot be `not_visible`, and a centre below it cannot be `visible`.
6. With `apparent_disk`, `visible_fraction` 0 / (0,1) / 1 must match `not_visible` / `partial` / `visible`. A fraction with state `unknown` is rejected. **Single exception:** when the series declares `fraction_decimals`, a `partial` state may carry `visible_fraction` 0.0. That is a sliver of disk below the stated rounding; the state is authoritative and the written 0.0 is kept. No other mismatch is relaxed (tested).
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
| `meta.generated_utc` (format 1.1) | `provenance.generated_at_utc` | parsed as UTC; `null` only if absent |
| `meta.generator_version` (1.1), `meta.fraction_decimals` / `meta.angle_decimals` (1.2) | `provenance.generator`; `fraction_decimals`; angle precision noted in `provenance.notes` | explicit `meta.fraction_decimals` (1.2+) wins; otherwise the documented rounding `1.0` → 3, `1.1` → 6; unknown version and no explicit field → not declared (strict rule 6) |
| `meta.frame` (1.1) | `provenance.coordinate_frame` | recorded verbatim as Member 1's statement; notes say "not independently verified" |
| `horizon.azimuth_deg`, `elevation_deg` | `horizon_profile` | step → `horizon_azimuth_step_deg` (0.5°); `distance_m` is not carried |
| `timeline.time_utc` (`…T00:00Z`) | `samples[i].time_utc` | must be UTC; other offsets or naive times are rejected |
| `sun_azimuth/elevation/horizon_deg` | `sun.*` | azimuth exactly 360.0 → 0.0 |
| `sun_visible_fraction` (6 decimals in 1.1) | `sun.visible_fraction` + `sun.state` | 0 → `not_visible`, (0,1) → `partial`, 1 → `visible`; `sun_criterion = apparent_disk`; value always kept as written |
| `sun_visible` (1.1, authoritative "any disk visible") | `sun.state` | true + fraction 0.0 → `partial` (sub-precision sliver); false + fraction > 0, null + fraction, or a flag without its angles/fraction → **rejected** |
| `earth_azimuth/elevation/horizon_deg` | `earth.*` | azimuth exactly 360.0 → 0.0 |
| `earth_visible` | `earth.state` | `visible` / `not_visible`; `earth_criterion = center` (his rule: margin > 0) |
| `earth_margin_deg` | *(not stored)* | checked against `elevation − horizon` (±0.002°) and against `earth_visible` |
| `sun_angular_radius_deg` (1.1); `earth_angular_radius_deg` *(absent)* | `*.angular_radius_deg` | otherwise `null` |
| `summary` | *(not used)* | test cross-check only |

**Missing data:** a `null` or `NaN` element makes that body's state `unknown` and keeps the
known values. A visibility value whose input angle is missing (for example a fraction without a
horizon) is **rejected as inconsistent**. A missing horizon never becomes a clear horizon.
`Infinity`, booleans or strings in numeric columns, unequal array lengths, missing columns or
metadata, fewer than 2 samples, and states that contradict the angles all raise
`SiteFileError` with the field and index. Unknown extra columns are listed in
`provenance.notes`, not silently dropped.

**Results on the committed files (generator 1.2, whole-Moon terrain, 2026-11-14):** the four original sites
validate (as do all 24 published files); no unknown values at these sites. Sun counts use the authoritative
flag. These counts changed from generator 1.1 because the terrain pipeline changed (finer horizon tiers):
Malapert's direct sunlight fell from 82.6 % to 77.1 %, which matches Andrew's own `summary.sunlit_pct`.

| Site | lon (file → contract) | Sun visible / partial / not visible | Earth visible |
|---|---|---|---|
| connecting-ridge | 209.94767 → −150.05233 | 9017 / 1468 / 7060 | 49.5% |
| malapert-massif | 357.6326 → −2.3674 | 12019 / 1505 / 4021 | 100.0% |
| peak-near-shackleton | 126.27302 (unchanged) | 4303 / 2210 / 11032 | 50.3% |
| shackleton-floor (control) | 129.78 (unchanged) | 0 / 0 / 17545 | 0% |

**Precision (resolved in format 1.1):** format 1.0 rounded fractions to 3 decimals, which hid
disk slivers below 0.0005 (4–16 h per site). Format 1.1 writes 6 decimals plus the
authoritative `sun_visible`. On generator 1.1 the two agreed everywhere except **one hour** (Peak Near
Shackleton, 2027‑08‑13T21:00Z); **generator 1.2 has no such hour**, and the tests now discover sliver hours
from the data instead of pinning them. For that 1.1 hour: There `sun_visible = true` and the fraction is 0.0, so
the visible part is below 5×10⁻⁷. It is isolated (dark on both sides), and the written angles
put the disk's top within ~0.0006° of the terrain. It becomes `partial` with the
written 0.0 kept: direct sunlight yes, full no, power-eligible at threshold 0 yes and at 0.25 no.
Fractions that round to 1.000000 are still `visible`: the file has no "whole disk" flag, so a
sub-precision hidden sliver there cannot be detected (≤ 5×10⁻⁷ of the disk). Compared with
format 1.0, direct sunlight rose by 0.02–0.07 pp and full sunlight fell by 0.02–0.06 pp (§5b).

## 4. Mission models: Members 3/4/5 → engine

`MissionScenario` = `scenario_id`, `site` (`LandingSite`), `mission_start_utc` <
`mission_end_utc` (≤ 10 years), `spacecraft`, `requirements`, `preferences`.

| Model | Fields | Meaning of `null` |
|---|---|---|
| `LandingSite` | `id`, `name`, `lat`, `lon`, `surface_height_m?` | Same field names as the shared `Site` |
| `SpacecraftConfiguration` | `power_source` (solar/radioisotope/battery_only/hybrid/other), `communication_mode` (direct_to_earth/relay/direct_and_relay/none), `max_continuous_darkness_s`, `max_communication_blackout_s`, `solar_power_min_disk_fraction` | No such limit → constraint `not_applicable`; no threshold → "power-lit" = direct sunlight (any visible disk) |
| `MissionRequirements` (hard) | `min_sunlight_percent` (share of *time* with direct sunlight), `min_earth_visibility_percent`, `min_simultaneous_percent`, `min_mean_solar_disk_fraction` (time-average of the visible disk fraction), `min_initial_sunlight_s`, `min_initial_earth_visibility_s`, `min_sun_clearance_deg`, `min_earth_clearance_deg`, `unknown_data_policy` | Not required |
| `RankingPreferences` (soft) | Non-negative relative weights for sunlight, Earth visibility, simultaneity, darkness/blackout/clearance margins. Defaults: 1, 1, 0, 1, 1, **0** (clearance changed from 0.5 in C0: not supported yet, §5e) | At least one weight > 0 |

**Power-lit / power-dark.** When `solar_power_min_disk_fraction` (rescue's `panel_threshold`,
e.g. 0.25) is set, a sample is power-lit iff some solar disk is visible and `visible_fraction ≥`
the threshold (a fraction exactly equal to the threshold counts). "Some disk visible" comes from
the authoritative apparent-disk state, so for consistent data it is `visible_fraction > 0`. A
sub-precision sliver (§3a) is lit at threshold 0 and dark at any larger threshold. Darkness, initial-sunlight,
first-sunset and simultaneous metrics use this definition. The fraction itself is always
preserved, and with a threshold of 0 "any visible disk" counts. **Without a threshold,
power-lit = direct sunlight (any visible disk, `visible_fraction > 0`)**, i.e. the same as a
threshold of 0. Direct, full and partial sunlight are always reported separately (§5b).

`unknown_data_policy` is `report_unknown` (the default and only effective policy: undecidable
checks are `unknown`). `worst_case` is **deprecated since Phase 3**. It is still accepted so
existing payloads validate, but it does not change any verdict: lack of evidence is never
reported as a failure (§5c). **There is no optimistic option.**

## 5. Output contract: engine → Members 3, 4, 5, 6

`ViabilityAssessment` (JSON via `model_dump_json()`, FastAPI-ready):

| Field | Content |
|---|---|
| `scenario_id`, `site`, `evaluated_start_utc/end_utc` | Identity and evaluated range (= mission window) |
| `eligibility` | `pass` / `fail` / `unknown`, **derived** from `constraints` |
| `constraints[]` | `constraint_id`, `status` (+`not_applicable`), `threshold`, `unit`, `measured`, `message`; Phase 3 evidence (additive, optional): `name`, `comparison`, `requirement_field`, `metric_field`, `condition`, `condition_unknown_duration_s`, `unknown_reason`, `evidence_windows` (§5c) |
| `metrics` | `MetricsSummary` (§5b): direct / full / partial / power-lit sunlight, Earth-visible and simultaneous durations and percentages; longest simultaneous window; longest darkness (power-dark), longest without direct sunlight, longest blackout; mean solar-disk fraction; initial sunlight / Earth visibility; time to first sunset / Earthset (`not_applicable` = never in range); mean Sun / Earth clearance; mean solar elevation |
| `windows[]` | `kind` (see §5b table), start/end/`duration_s`, `clipped_at_start/end` |
| `margins[]` | Signed headroom (+ = safe), `reference`, `related_constraint` |
| `risks[]`, `overall_risk` | Rule-triggered indicators with the explicit `rule` text |
| `score` | `score` 0–100 (exact only) or null, `rank_eligible`, per-component breakdown; Phase 5 adds `status`, `score_bounds`, `configuration_key` (§5e) |
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

**Status: validated (Phase 6B, `rescue-compat/0.3.0`).** The compat layer's default engine is the real
`evaluate_scenario`. On fully covered real data it reproduces rescue's placeholder exactly for all twelve
`ViabilityMetrics` fields, every verdict and every `Violation`; only `score` differs (different, documented
formula). Arush's side-by-side test (`tests/test_engine_side_by_side.py`) runs and passes. Rescue still imports its
placeholder; nothing in `app/rescue/` was changed. The switch and the open Rescue findings are in §5g.
`evaluate_timeline_detailed` returns the canonical assessment too (including its explanations, score interval and
data basis, which the shared `ViabilityResult` cannot carry), and `make_evaluate_fn(engine)` fits
`Evaluator(evaluate=...)`.

**Scenario → MissionScenario**

| Rescue | Canonical | Conversion |
|---|---|---|
| `site.id` (e.g. `custom:-89.46012,221.98000`) | `site.id` | characters outside `[A-Za-z0-9._-]` → `_` (`custom_-89.46012_221.98000`) |
| `site.lon` (0–360 °E from the catalog) | `site.lon` | any finite value wrapped to the canonical range (same function as the site-file adapter). Phase 6B: rescue's `custom_site` stores `lon % 360`, which is exactly 360.0 for a tiny negative longitude and used to raise inside a search |
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
sample-for-sample identical to `load_site_file` on the same file (tested). The one exception:
rescue's `Timeline` has no `sun_visible`, so the single sub-precision sliver hour (§3a) reads as
`not_visible` through rescue. Unknown Earth visibility (NaN margin, which rescue stores as
`earth_visible = False`) stays `unknown`, never a blackout.

**Coverage and the final bin.** Coverage ends at the last sample. `evaluate_timeline` passes the
mission end; when that lies at most 1.5 steps after the last sample (rescue's `round(duration / step)`
layout), the last sample is **held for one step, capped at mission end**, so the final hour is represented
under sample-and-hold. A fractional-hour duration therefore no longer leaves a covered final partial bin
unknown, and a mission under 1.5 h (a single sample) no longer raises (Phase 6B). Never more than one step,
and **only if that time is covered by the source**:
- **synthetic model:** always (it is defined at any time);
- **precomputed file:** only if its last sample is at or after mission end. The file's last
  timestamp is read once and cached by path and modification time; this is the layer's only
  file access. `precomputed_data_dir` defaults to rescue's data directory.

Otherwise the final hour stays **unknown**. Verified edge cases on real data (PNS):

| Mission end | Rescue source | Result |
|---|---|---|
| 2029‑01‑01T00:00Z | precomputed | final bin covered by the file's 00:00 sample: fully known |
| 2029‑01‑01T01:00Z | precomputed (last bin starts at the file's final instant) | **not extended**: 1 h unknown, metrics bounded (previously fabricated, fixed) |
| 2029‑01‑01T03:00Z | **synthetic-placeholder** (rescue's provider falls back for the whole mission) | `is_synthetic = true`, warning "SYNTHETIC data" |

**ViabilityAssessment → ViabilityResult** (shared contract as of `main` 2026‑11‑13:
`eligibility`, nullable `score`, `Violation.is_unknown`; metrics never optimistic):

| Canonical | Rescue |
|---|---|
| `eligibility` | `eligibility` copied exactly (`"pass"` / `"fail"` / `"unknown"`); `passes = (eligibility == "pass")` (legacy flag) |
| constraint `fail` | `Violation` with rescue field name, rescue units (h, fraction), `is_unknown = false` |
| constraint `unknown` | `Violation` with `is_unknown = true` (rescue gives no loosening advice), message prefixed `UNKNOWN (incomplete data; worst case shown):` |
| `Metric` known | value, unit-converted (s → h, percent → fraction) |
| `Metric` bounded | unfavourable bound (lower for "more is better", upper for outages) |
| `Metric` unavailable | worst case within the mission: 0 for fractions and initial hours; whole mission for gaps; 0 h to first sunset/Earthset; `null` clearances; **error** for mean solar elevation (no defensible worst case) |
| first sunset/Earthset `not_applicable` | `null` (rescue's "never during the mission") |
| `score` null, or `score_status = bounded` | `score = null` ("not scored"). A bound is never written into `score`; the interval stays in `assessment.score.score_bounds`. Rescue currently ranks `null` as 0 via `score_or_zero` (§5g finding 1) |
| `explanations`, `risks`, `data_basis` | not carried (no shared field); available from `evaluate_timeline_detailed` |
| source file precision metadata | recorded in the series provenance (`meta.fraction_decimals`, else the generator-version table); provenance only |
| a failing constraint with no rescue field | **error** (can't occur from a rescue scenario) |

Checked on every conversion: `passes == (no violations)` and an `unknown` result has only
`is_unknown` violations (shared invariants, docs/interfaces.md). A `fail` may also carry unknown
violations; each keeps its own flag. Every constraint the layer creates maps 1:1 onto rescue's
`CHECK_BY_CONSTRAINT` (tested), so loosening and explanations keep working.

**Coordination with Arush (Member 5):**
1. **Unknown state: resolved by Arush** (`eligibility`, nullable `score`, `is_unknown`; loosening skips undecided results and unknown violations). The compat layer now uses these fields directly.
2. **Sample semantics: resolved in Phase 2.** Canonical rule = sample-and-hold (§5b) plus the guarded one-step bin rule above (tested). *Still for Arush (his provider), quantified in §5g:* (a) rescue's coverage check accepts a mission whose last bin starts at the file's final instant; the compat layer refuses to cover that hour (finding 3). (b) In simulation mode a mission extending even slightly past 2029‑01‑01 is evaluated **entirely** on synthetic geometry, and so is every other candidate fetched in the same batch (finding 2b).
3. **Panel threshold of 0: resolved by Arush** (placeholder now requires `fraction > 0`). Same rule as the canonical engine.
4. **Naive datetimes.** Shared `Scenario.landing_utc` treats naive times as UTC, while the canonical API rejects them. The layer accepts the shared model's decision; flagged for the team.
5. **Two readers of `data/sites`.** `rescue/timeline/precomputed.py` and the site-file adapter parse the same files. They agree sample for sample (tested), except that rescue ignores `sun_visible` (1 sliver hour at PNS, §3a) and reads a `null` `earth_visible` as `False`. The compat layer turns the latter back into unknown via the NaN margin. Keep one reader long-term.
6. **Equivalence check: done, re-run on format 1.1 data.** On real precomputed timelines (3 sites × 6 landing dates, 14-day missions, `panel_threshold` 0.25), all 11 `ViabilityMetrics` fields from Phase 2 equal the placeholder's to 1e-12 (`test_phase2_metrics_match_rescue_placeholder_on_real_data`). Expected differences remain only where data is unknown, where the canonical engine bounds instead of counting. **Phase 3:** on the same real timelines (3 sites × 6 landing dates × {rescue defaults, a strict set incl. `min_earth_visibility_fraction` 0.55}), the canonical failing constraints, eligibility and each `Violation`'s `required`/`actual` equal the placeholder's (`test_phase3_verdicts_match_rescue_placeholder_on_real_data`, 36 cases, no unknowns). **Phase 6B** extends this to all twelve metrics, verdicts and violations on the four original and six whole-Moon sites (`test_real_sites_phase6_compat.py`), and Arush's side-by-side test (`tests/test_engine_side_by_side.py`, 3 sites × 20 dates) runs and passes.

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
| `direct_sunlight` | any part of the disk visible (`visible`/`partial`; from Member 1's authoritative `sun_visible`) | `sunlight` / `darkness` / `sun_unknown` |
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

### Real NASA-derived sites (generator 1.2 files; full coverage 2027-01-01 → 2029-01-01, threshold 0.25)

Values below are a snapshot of the committed files (2026-11-14) and change whenever Member 1 regenerates
them; the regression tests re-derive every outage from the raw columns instead of pinning these numbers.

| Site | Direct sun | Full | Partial | Power-lit (≥0.25) | Mean disk fraction | Earth visible | Simultaneous |
|---|---|---|---|---|---|---|---|
| connecting-ridge | 59.764 % | 51.396 % | 8.368 % | 57.370 % | 0.5563 | 49.550 % | 31.948 % |
| malapert-massif | 77.080 % | 68.502 % | 8.578 % | 74.858 % | 0.7311 | 100.000 % | 74.858 % |
| peak-near-shackleton | 37.118 % | 24.527 % | 12.591 % | 33.407 % | 0.3052 | 50.256 % | 18.719 % |
| shackleton-floor | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Site | Longest without direct sun | Longest power-dark (≥0.25) | Longest Earth blackout | Longest simultaneous |
|---|---|---|---|---|
| connecting-ridge | 293 h from 2027-04-20T08Z | 492 h from 2028-03-31T13Z | 352 h from 2027-01-23T20Z | 298 h |
| malapert-massif | 361 h from 2027-04-29T04Z | 365 h from 2027-04-29T01Z | 0 h (Earth always visible) | 2107 h |
| peak-near-shackleton | 2116 h (88 d) from 2028-02-23T06Z | 2802 h (117 d) from 2027-03-05T22Z | 348 h from 2027-01-23T19Z | 272 h |
| shackleton-floor | 17,544 h (entire range) | 17,544 h | 17,544 h | 0 |

Terrain-resolution changes in generator 1.2 moved Malapert most (sunlight −5.5 pp, its longest outages from
265 h to 361 h); the other sites moved by ≤ 0.3 pp. Every metric is `known` (no unknown data). Durations equal the independently counted samples
× 1 h, using `sun_visible` for direct sunlight (tested). Windows equal Member 1's `intervals()`
on `sun_visible` / `earth_visible`. Against Andrew's `summary`, `sunlit_pct`, `earth_visible_pct`
and `mean_sun_fraction_pct` all agree within ±0.05 pp, i.e. display rounding plus ≤ 0.006 pp
from his 17,545 instants versus our 17,544 h. With format 1.0 our direct sunlight was up to
0.11 pp lower because of 3-decimal fractions; format 1.1 removed that. **Longest outages and
their start times are identical on format 1.0 and 1.1.** Percentages moved: direct +0.02 to
+0.07 pp, full −0.02 to −0.06 pp, power-lit ≤ 0.02 pp. Full-sunlight and threshold-qualified
percentages have no counterpart in his summary and are not compared. Partial-disk time is 6–13 % at the lit sites,
so treating partial as full would overstate sunlight materially. The threshold matters: at
Malapert the longest direct-sunlight period (2,809 h) shrinks to 2,107 h at ≥ 0.25.

**Performance** (Python 3.14, Windows laptop, medians; machine-dependent): loading + validating
a 2-year file ≈ 0.4–0.6 s (once); `prepare_series` 40–60 ms (once); full 2-year analysis
80–100 ms incl. windows; a 7-day / 14-day mission on a prepared series ≈ 1.5 / 2 ms; 7-day
without preparing ≈ 60 ms. Prepare once per dataset when evaluating many candidates.

## 5c. Phase 3: mission constraint evaluation

```python
from app.viability import assess_constraints, build_constraint_assessment, evaluate_constraints
a = assess_constraints(scenario, prepared)    # Phase 2 analysis of the mission window + every constraint
a.eligibility                                  # pass / fail / unknown (derived, enforced)
a.constraints                                  # one ConstraintEvaluation per ConstraintId, enum order
a.environment                                  # the Phase 2 EnvironmentAnalysis the verdicts came from
build_constraint_assessment(scenario, env)     # same, from an existing analysis
evaluate_constraints(scenario, env)            # just the list
```

`evaluate_constraints` takes the Phase 2 `EnvironmentAnalysis` instead of the Phase 1 stub's
`(scenario, metrics, series)`: per-condition unknown time, evidence windows and an identity
check need it. Nobody called the stub. The analysis must match the scenario's site, mission
window **and** `solar_power_min_disk_fraction` (`ValueError` otherwise), because darkness and
initial-sunlight verdicts depend on the threshold. `evaluate_scenario` assembles the phases (Phase 5, §5f).
A 14-day evaluation on a prepared real series takes ≈ 1.6 ms.

### Constraints

All `MissionRequirements` fields and the two spacecraft limits are **hard** constraints;
`RankingPreferences` never enter Phase 3. `null` → `not_applicable` (its metric is still
reported in `measured`).

| `constraint_id` | Threshold source | Metric (Phase 2) | Test |
|---|---|---|---|
| `max_continuous_darkness` | `spacecraft.max_continuous_darkness_s` | `longest_continuous_darkness` (longest **power-dark** run) | ≤ |
| `max_communication_blackout` | `spacecraft.max_communication_blackout_s` | `longest_communication_blackout` (Earth centre obstructed) | ≤ |
| `min_sunlight_percent` | `requirements.min_sunlight_percent` | `sunlight_percent` (**direct** sunlight: any disk visible) | ≥ |
| `min_earth_visibility_percent` | `requirements.min_earth_visibility_percent` | `earth_visible_percent` | ≥ |
| `min_simultaneous_percent` | `requirements.min_simultaneous_percent` | `simultaneous_percent` (power-lit and Earth visible) | ≥ |
| `min_mean_solar_disk_fraction` | `requirements.min_mean_solar_disk_fraction` | `mean_solar_disk_fraction` (time mean of the visible fraction) | ≥ |
| `min_initial_sunlight` | `requirements.min_initial_sunlight_s` | `initial_sunlight_duration` (continuous **power-lit** time from start) | ≥ |
| `min_initial_earth_visibility` | `requirements.min_initial_earth_visibility_s` | `initial_earth_visibility_duration` | ≥ |
| `min_sun_clearance`, `min_earth_clearance` | `requirements.min_*_clearance_deg` | **none: unsupported** (below) | – |

The duration constraints are mission-scoped. An outage spanning landing or mission end is
measured inside the mission only, and the evidence window carries `clipped_at_start/end` for
Phase 4. An initial-duration requirement longer than the mission can be met only up to the
mission length, so it fails (the same rule as rescue; §10).

### Verdict rule

Let `t` be the threshold and `[L, U]` proven bounds on the true value:
KNOWN `v` → `L = U = v`; BOUNDED → `lower`/`upper`; **UNAVAILABLE → the quantity's admissible
range over the mission** (percent `[0, 100]`, fraction `[0, 1]`, durations `[0, |R|]`). These
hold by construction, so a requirement satisfied by every possible value (e.g. a darkness limit
≥ the mission length, or a 0 % minimum) is still proven. NOT_APPLICABLE metric → UNKNOWN
(cannot occur for the metrics above).

| | PASS | FAIL | otherwise |
|---|---|---|---|
| minimum (`at_least`) | `L ≥ t` | `U < t` | UNKNOWN |
| maximum (`at_most`) | `U ≤ t` | `L > t` | UNKNOWN |

Both comparisons are **inclusive**: exactly meeting a threshold passes (the same as rescue's
placeholder, `shortfall > 1e-9` ⇒ violation). Equality within a relative `1e-12` counts as
equal. That absorbs only floating-point representation (e.g. rescue's `0.55 × 100 =
55.00000000000001` %); it is not a margin (1 µs of a 1 h step is 2.8e-10). The tolerance is
applied identically in both directions.

PASS or FAIL is therefore possible despite missing data whenever the bounds are decisive
(tested). Unknown time is never counted as darkness, blackout, sunlight or visibility: it
only widens the bounds.

**`unknown_reason`** (set exactly when `unknown`; a validator enforces it): `incomplete_data`
(threshold inside BOUNDED bounds), `no_data` (metric unavailable and its admissible range
contains the threshold), `unsupported` (requirement configured but not evaluable by this
engine version). **No UNKNOWN is a failure.** Rescue receives it as `Violation.is_unknown`
and gives no loosening advice.

**`unknown_data_policy`: verdicts are evidence-based only.** `worst_case` is deprecated and
inert: results are identical to `report_unknown`, and UNKNOWN messages note the deprecation.
Reasons for retiring it instead of keeping it:
1. It would put an evidence-free FAIL into scientific eligibility.
2. A worst-case screen carries no extra information: it passes exactly when eligibility is
   `pass`, so consumers wanting a conservative screen use `eligibility != pass`.
3. No consumer set it (rescue, the frontend and the compat layer all use the default).

Only the enum value and its doc sentence were published (Phase 1). The value is still accepted
(`ConstraintAssessment.unknown_data_policy` echoes it), so no client breaks.

**Eligibility** = `derive_eligibility` (§5): any FAIL → `fail`; else any UNKNOWN →
`unknown`; else `pass`; `not_applicable` is ignored. A confirmed failure dominates unknowns.
With nothing configured the result is `pass`, vacuously, even without data. Coverage then
shows only in `environment.data_quality`, for Phase 4 risks. Score and risk cannot change
eligibility (Phases 4–5; enforced on `ViabilityAssessment`).

### Sunlight semantics (kept distinct)

| Concept | Where | Constraint |
|---|---|---|
| Direct sunlight (any visible disk, authoritative `sun_visible`) | `sunlight_percent` | `min_sunlight_percent` |
| Full sunlight (whole disk) | `full_sunlight_percent` | none |
| Power-eligible (`fraction > 0` and `≥ solar_power_min_disk_fraction`; = direct when unset) | `power_lit_percent`, darkness, initial sunlight, simultaneous | `max_continuous_darkness`, `min_initial_sunlight`, `min_simultaneous_percent` |
| Mean visible disk fraction | `mean_solar_disk_fraction` | `min_mean_solar_disk_fraction` (rescue's `min_sunlight_fraction`) |

`min_sunlight_percent` keeps its Phase 1 meaning (direct sunlight). It is **never** replaced by
power-lit time. On PNS over two years, 35 % passes on direct sunlight (37.36 %) even though
power-lit time at 0.25 is only 33.61 %. A fraction of 0 is never power-lit, even at threshold 0.

*Proposal, not implemented (needs Members 3/4/5):* a separate hard requirement
`min_power_lit_percent` → `power_lit_percent`, `at_least`, would express "share of mission time
the arrays are usable". Implications: a new `MissionRequirements` field and `ConstraintId` (an
additive contract change), a UI field, and nothing for rescue (it has no such requirement).
Without it, users who mean "usable power time" must not use `min_sunlight_percent`.

### Unsupported requirements

`min_sun_clearance_deg` / `min_earth_clearance_deg` ("minimum elevation above the terrain
horizon, applied whenever the body is counted as visible") are **UNKNOWN (`unsupported`)**
when configured. Phase 2 provides only the *time-mean* clearance, and a mean above the mask
does not show that every visible instant is above it. Two readings are still open: a mask
that redefines visibility for the other constraints, or a per-instant minimum (which would fail
at almost every sunrise and, for the Sun, conflicts with partial-disk visibility). Not evaluated:
slopes, hazards, thermal limits, battery state of charge, power generation, radio link budgets.
The models have no fields for them, and no verdict implies landing safety (`STANDARD_LIMITATIONS`).

### Result fields (Phase 4 / Phase 6 inputs)

Each `ConstraintEvaluation` keeps the Phase 1 fields (`threshold`, `unit`, `measured` with
value or bounds and reason, `message`). Phase 3 adds optional fields with defaults, so earlier
constructors stay valid: `name`, `comparison`, `requirement_field`, `metric_field`, `condition`
(look up its windows in `environment.windows`), `condition_unknown_duration_s`,
`unknown_reason`, and `evidence_windows`: the longest confirmed
outage for the two `max_*` limits, and the window at mission start (lit / dark / unknown) for
the two initial requirements. `message` is a factual one-liner; explanation text is Phase 6.
`ConstraintAssessment` = `engine_version`, `scenario_id`, `unknown_data_policy`,
`eligibility`, `constraints`, `environment`. It is JSON round-trip safe and deterministic.

### Real-data verification (format 1.1 files; panel 0.25, 50 h darkness, 96 h blackout, ≥ 40 % Earth, ≥ 24 h / 12 h initial, mean fraction ≥ 0.5, direct sun ≥ 50 %)

103 weekly 14-day landings per site (first 2027-01-01, last 2028-12-15, ending 2028-12-29):
Malapert 58 pass / 45 fail; Connecting Ridge 2 pass / 101 fail; Peak Near Shackleton 2 pass /
101 fail; Shackleton floor (permanently shadowed control) 0 pass / 103 fail. There is no unknown
on fully covered data. All 412 eligibility results equal an **independent** NumPy recomputation
from the raw columns (checked in review). The test suite does the same per constraint for all
four sites × 9 landing dates. Two-year limits exactly at the Phase 2 outage
extremes pass and 1 h below fail. Percentages exactly at the independently counted value pass
and 1e-9 relative above fail.

| Scenario | Eligibility | Why |
|---|---|---|
| Malapert, 2027-07-20 + 14 d | pass | every configured check met |
| Malapert, 2027-02-05 + 14 d | fail | darkness > 50 h; < 24 h initial power-lit |
| PNS, 2027-04-01 + 14 d (inside its 2,802 h night) | fail | power-dark the whole mission (window clipped at both ends); 0 h initial |
| Shackleton floor (control), 30 d | fail | all seven checks |
| Malapert, 2028-12-25 → 2029-01-08 | **unknown** | Earth ≥ 40 % proven by the covered week alone; darkness and blackout undecidable over the 7 uncovered days |
| Malapert, 14 d ending 2029-01-01T00:00Z | pass | fully covered |
| Malapert, 14 d ending 2029-01-01T01:00Z | pass | 1 h unknown, but bounds still decide every check |
| Connecting Ridge, 2029-02-01 + 14 d | **unknown** | no data; all `no_data`, nothing fabricated |
| Malapert, 2027-01-01 + 14 d with `min_earth_clearance_deg` 2 | **unknown** | `unsupported` |

These are illumination and line-of-sight verdicts under hourly sample-and-hold, with no
interpolation. Transitions are resolved to ≤ 1 h, and events shorter than an hour can be missed.

**Dataset boundary and synthetic data.** On the canonical path (`load_site_file`), time after
2029-01-01T00:00Z is never filled in: it is unknown, and verdicts are bounded or UNKNOWN (table
above). On the rescue path, Member 5's provider evaluates a mission reaching even slightly past
the dataset end **entirely on synthetic geometry** (§5a item 2b). Phase 3 then gives definite
verdicts, and the assessment labels them `provenance.is_synthetic = true` with the warning
"SYNTHETIC data: not NASA-derived; not valid for mission decisions" (tested). The labelling is
explicit, but eligibility itself does not encode the data basis (§10 item 14).

## 5d. Phase 4: operational margins and risk assessment

Phase 4 runs after Phase 3 and never changes a verdict or eligibility. **Margins** (`margins.py`)
measure the signed headroom of each hard constraint. **Risk indicators** (`risk.py`) are
deterministic screening flags built from Phase 2 evidence, Phase 3 verdicts and those margins.
Both were developed in parallel (4A, 4B) and then integrated (commits below).

```python
assessment = assess_constraints(scenario, series)          # Phase 3 (Phase 2 inside)
margins    = margins_from_assessment(assessment)           # Phase 4A: list[OperationalMargin]
detail     = assess_margins(assessment)                    # Phase 4A: + class, basis, relative, clipping
risks      = assess_risks(scenario, assessment, margins)   # Phase 4B: list[RiskIndicator]
level      = overall_risk(risks)
```

`compute_margins(scenario, env.metrics, series)` keeps the Phase 1 signature and returns exactly
the same margins as `margins_from_assessment` (tested on every integration scenario).
`assess_risks(scenario, assessment)` with no margins derives them the same way.

### Operational margins (Phase 4A)

One `OperationalMargin` per `ConstraintId`, in Phase 3 order: `margin_id = related_constraint
= constraint id`, `reference` = the configured threshold, and `value` a `Metric` in the
**constraint's own unit** (seconds, percent, fraction). Quantities of different kinds are never
combined.

| Comparison | Signed margin | Interval from measured bounds `[L, U]` |
|---|---|---|
| Minimum requirement (`at_least`) | `margin = observed − required` | `[L − t, U − t]` |
| Maximum limit (`at_most`) | `margin = limit − observed` | `[t − U, t − L]` |

Positive = headroom, `0` = exactly at the threshold (still PASS, since comparisons are
inclusive), negative = violation. A bound within Phase 3's `COMPARISON_REL_TOL` (1e-12) of the
threshold gives exactly `0.0`. Therefore **PASS ⇔ lower margin ≥ 0, FAIL ⇔ upper margin < 0,
UNKNOWN ⇔ the interval straddles 0**. This is checked, and a contradicting evaluation raises
`ValueError` rather than being re-decided.

**Uncertainty propagation.** The measured bounds come from the Phase 2/3 evidence:

| Metric status | Margin | `MarginBasis` |
|---|---|---|
| KNOWN `v` | KNOWN `v − t` / `t − v` | `measured` |
| BOUNDED `[L, U]` (unknown time in the mission) | BOUNDED interval above | `bounded` |
| UNAVAILABLE (no evidence) | BOUNDED from the admissible range: percent `[0, 100]`, fraction `[0, 1]`, durations `[0, mission]`, exactly as in Phase 3 | `admissible_range` (stated in `value.reason`) |
| Constraint not configured | NOT_APPLICABLE, `reference = None` | `none` |
| Configured but unsupported (`min_sun/earth_clearance_deg`) | UNAVAILABLE, `reason` starting `unsupported`, `reference = threshold`. No number; the mean clearance is never a stand-in | `none` |

Only KNOWN metrics give point margins. Missing data widens the interval and is never treated as a
favourable or failing observation.

**Relative margin** (`MarginAssessment.relative`, `Unit.FRACTION`): `margin / threshold` when
`threshold > 0`, otherwise none. For a limit this is `1 − observed / limit`, the share of the limit
left unused. It is comparable only within one constraint.

**Classification** (`classify_margin`) uses the **least favourable** bound `lo`, so uncertainty
never makes a margin look safer:

| `MarginClass` | Rule | Compatible verdict |
|---|---|---|
| `negative` | upper < 0 | FAIL |
| `uncertain` | lo < 0 ≤ upper | UNKNOWN |
| `at_threshold` | lo = 0 | PASS |
| `narrow` | 0 < lo ≤ 10 % × threshold (inclusive), **or** a duration margin below the data's largest sample spacing | PASS |
| `comfortable` | otherwise | PASS |
| `unsupported` / `not_applicable` | no numeric margin / not configured | UNKNOWN / NOT_APPLICABLE |

The 10 % band (`NARROW_MARGIN_FRACTION`) is a product-defined screening convention. The time
resolution defaults to `data_quality.largest_sample_gap_s` (1 h on the real files): under
sample-and-hold, interior durations err by less than one spacing, so a smaller margin is not
resolved by the data. `MarginAssessment` also echoes the verdict and comparison, and sets
`clipped_at_mission_start/end` when the decisive window touches a mission edge (e.g. darkness
already in progress at landing; margins are mission-scoped).

### Risk indicators (Phase 4B)

Every `RiskIndicator` carries `code`, `level` (`low` / `moderate` / `high` / `unknown`), the
explicit `rule` text, `evidence` (a `Metric`) and a factual `message`. Levels are **screening
categories, not probabilities**. LOW never means "safe to land", and nothing reads or writes
eligibility.

| Code | Meaning | Rule |
|---|---|---|
| `synthetic_data` | dataset is synthetic | always UNKNOWN (real-site risk not assessed) |
| `geometric_only_data` | terrain not modelled | always UNKNOWN |
| `sun_data_coverage`, `earth_data_coverage` | unknown Sun/power or Earth state time in the mission | 0 → LOW; the entire mission → UNKNOWN; otherwise MODERATE |
| `landing_in_darkness` | power-dark at mission start | met → LOW; unknown → UNKNOWN; not met → MODERATE, HIGH if the outage in progress at landing lasts the whole mission or leaves ≤ 10 % of the darkness limit (levels from proven bounds) |
| `landing_without_earth_visibility` | Earth obstructed at mission start | same rule against the blackout limit |
| `darkness_exposure` | longest power-dark period vs `max_continuous_darkness_s` | headroom bands on the margin |
| `communication_exposure` | longest Earth line-of-sight blackout vs `max_communication_blackout_s` (geometry, not a radio link) | headroom bands on the margin |
| `margin_headroom.<constraint_id>` | headroom of each configured minimum requirement | headroom bands on the margin |
| `unsupported_requirement.<constraint_id>` | configured requirement the engine cannot evaluate | always UNKNOWN |

**Headroom bands.** `h = margin / reference` per proven bound:

- `h ≤ 10 %` → HIGH (this includes 0 and every violation);
- `h ≤ 25 %` → MODERATE;
- otherwise → LOW.

Both thresholds are inclusive and adjustable through `RiskPolicy(high_headroom_fraction=0.10,
moderate_headroom_fraction=0.25)`. **These are product-defined screening heuristics, not
NASA-established or NASA-validated safety thresholds.** Changing them changes risk levels only,
never eligibility, verdicts or margins (tested).

- **Bounded evidence:** each bound is banded separately. The level is decided only when both
  bounds fall in the same band; otherwise it is UNKNOWN. Because the band is monotonic in `h`,
  agreement at the bounds means every value in between agrees. A level can therefore be decided
  despite missing data when the bounds are decisive.
- **Time resolution:** a duration bound below the sample spacing is never LOW (raised to
  MODERATE).
- **Zero reference** (a vacuous minimum such as `min_sunlight_percent = 0`): `h` is undefined, and
  the verdict decides (PASS → LOW, FAIL → HIGH, UNKNOWN → UNKNOWN).

**Landing relevance.** Landing indicators are emitted only when that outage can affect the
spacecraft:

- `landing_in_darkness`: the darkness limit is configured, or the power source is solar, hybrid
  or other;
- `landing_without_earth_visibility`: the blackout limit is configured, or the communication mode
  is direct_to_earth or direct_and_relay.

No landing risk is invented for a radioisotope / battery-only lander or a relay-only rover.

**`overall_risk`:** any HIGH → HIGH; otherwise any UNKNOWN → UNKNOWN; otherwise any MODERATE →
MODERATE; otherwise LOW. An empty list is UNKNOWN (nothing assessed is not low risk). A HIGH
overall level can sit alongside UNKNOWN indicators, but aggregation never drops or rewrites them:
`risks[]` keeps every indicator, so the uncertainty stays inspectable (tested). Consumers should
show UNKNOWN indicators next to a HIGH overall level, not only the overall level. On synthetic
data, every message starts with `[SYNTHETIC DATA]`, and `synthetic_data` keeps the overall level
from ever being LOW or MODERATE.

### Margin-to-risk integration contract

1. Every headroom number in a risk indicator comes from a Phase 4A `OperationalMargin`; risk
   never recomputes a margin. Outage exposure uses the supplied margin. If an explicit list omits
   it, the margin is derived with `margins.operational_margin` from the same Phase 3 evaluation.
   `margin_headroom.*` indicators carry the margin itself as `evidence`.
2. Supplied margins are validated against the assessment:
   - at most one per constraint;
   - same unit;
   - `reference == threshold`;
   - bounds that imply the Phase 3 verdict in full: PASS ⇒ lo ≥ 0, FAIL ⇒ upper < 0,
     UNKNOWN ⇒ the bounds straddle 0.

   Margins of another scenario or with another sign convention raise `ValueError`.
   Unconfigured constraints and margins without a `related_constraint` are ignored. Unsupported
   constraints produce only `unsupported_requirement.*`.
3. `margins=None` (the default) derives `margins_from_assessment(assessment)`. With an explicit
   list, an omitted minimum requirement is UNKNOWN (HIGH if Phase 3 proved FAIL).
4. One band convention: `RiskPolicy.high_headroom_fraction` defaults to `NARROW_MARGIN_FRACTION`,
   and both bands are inclusive. At the defaults:

   | Margin class | Risk level |
   |---|---|
   | `negative` | HIGH |
   | `at_threshold` | HIGH (UNKNOWN if bounded) |
   | `narrow` | never LOW |
   | `uncertain` | HIGH or UNKNOWN |
   | `comfortable` | never HIGH |
   | `unsupported` | UNKNOWN |
   | `not_applicable` | no indicator |

   These pairs are checked on every integration scenario, real data included.
5. Verdict safeguards hold under every policy: a FAIL constraint's indicator is always HIGH, and
   an UNKNOWN constraint's is HIGH or UNKNOWN, never LOW or MODERATE.

### Real-data examples (same lander as §5c; 14-day missions unless noted)

| Scenario | Eligibility | Darkness margin | Blackout margin | Sunlight margin | Overall |
|---|---|---|---|---|---|
| Malapert, 2027-07-20 | pass | +14 h, comfortable, LOW (28 %) | +96 h, LOW | +38.99 pp, LOW | **LOW** |
| Connecting Ridge, 2027-01-01 | fail | +11 h, comfortable, **MODERATE** (22 %) | −152 h, negative, HIGH | +38.99 pp, LOW | HIGH |
| Malapert, 2027-02-05 | fail | −51 h, negative, HIGH | +96 h, LOW | +21.73 pp, LOW | HIGH (landing MODERATE) |
| PNS, 2027-04-01 (inside its night) | fail | −286 h, negative, HIGH, clipped at landing | +54 h, LOW | −48.81 pp, HIGH | HIGH (landing in darkness HIGH) |
| Shackleton floor (control), 30 d | fail | −670 h, HIGH | −624 h, HIGH | −50 pp, HIGH | HIGH |
| Malapert, 2028-12-25 (7 d past coverage) | unknown | [−118, +50] h, uncertain, UNKNOWN | [−72, +96] h, UNKNOWN | [0, +50] pp, at_threshold, UNKNOWN | UNKNOWN (coverage MODERATE) |
| Connecting Ridge, 2029-02-01 (no data) | unknown | [−286, +50] h, admissible range, UNKNOWN | [−240, +96] h, UNKNOWN | [−50, +50] pp, UNKNOWN | UNKNOWN (every indicator) |

The tests check margins on all four sites × 6 landing dates against an independent NumPy
computation from the raw columns. Levels on all four sites × 9 dates are re-derived from those
margins.

### Scientific limitations

- Margins and risks describe illumination and line-of-sight headroom under hourly sample-and-hold
  only. They model no battery state of charge, energy balance, power generation, thermal survival,
  radio link budget or landing safety. "Landing in darkness" says stored energy is not modelled,
  and Earth indicators say radio-link availability is not modelled.
- Direct sunlight and power-eligible illumination stay separate: darkness and initial-sunlight
  margins use power-eligibility (`solar_power_min_disk_fraction`), while `min_sunlight_percent`
  uses direct sunlight. Neither guarantees electrical power.
- Duration margins are resolved to one sample spacing, and short events can be missed (§5b). The
  time-resolution rule makes sub-spacing margins NARROW / never-LOW instead of hiding the issue.
- Relative margins are comparable within one constraint only. The risk bands are heuristics, not
  calibrated failure probabilities.
- Clearance margins are not computed (unsupported, §10 item 10).

### Synthetic-data limitations

Synthetic series (fixtures, tests, custom-site placeholders) run through the same rules. Their
margins and risks describe the synthetic geometry only. They are labelled in three places:

- `data_quality.provenance.is_synthetic`, plus the Phase 2 warning "SYNTHETIC data: not
  NASA-derived …", which Phase 4 keeps unchanged;
- the `synthetic_data` UNKNOWN indicator;
- the `[SYNTHETIC DATA]` prefix on every risk message.

`OperationalMargin.description` carries no prefix. A margin taken out of its assessment must keep
the assessment's `data_quality` alongside it. The rescue path's synthetic fallback (§10 item 14)
still yields definite but labelled margins and risks.

### Phase 4 status

**Complete and integrated.** Commits:

| Commit | Content |
|---|---|
| `0caa3d0` | Phase 4A margins |
| `404d7d5` | Phase 4B risk |
| `ffabf2d`, `2402ada` | `--no-ff` merges |
| `3b83e6b` | Integration fixes and `test_phase4_integration.py` |

Fixes applied in the integration:

- The narrow band was made inclusive (exactly 10 % headroom used to be `comfortable` + HIGH).
- Exposure indicators consume margins instead of recomputing them.
- The sample-spacing rule was added to risk (`narrow` + LOW before).
- Full margin/verdict validation.
- The `margins=None` default.
- Landing relevance.

`evaluate_scenario` (Phase 5 integration, §5f) assembles the `ViabilityAssessment`: margins → `margins[]`,
indicators → `risks[]`, `overall_risk`, and the score.

## 5e. Phase 5: scoring and ranking contract (C0)

C0 fixes the shared contract before the scoring (5A) and ranking (5B) algorithms are written in
parallel. Every new field is **optional with a default of `null`**, so existing constructors and JSON
stay valid. A missing score is never read as 0. Scoring and ranking never change eligibility: it is
still derived from the constraints only (§5, §5c).

### Contract fields

| Model | New fields (C0) | Meaning |
|---|---|---|
| `ScoreBreakdown` | `status: ScoreStatus`, `score_bounds: Metric` (unit percent), `configuration_key` | the four score states below; exact or bounded score; configuration identity |
| `ScoreComponentResult` | `status: ScoreComponentStatus`, `declared_weight`, `normalized: Metric` (unit fraction) | why the component is (not) scored; the user's weight; its value in [0, 1], KNOWN or BOUNDED |
| `RankedScenario` | `score_status`, `score_bounds`, `data_basis` | same score semantics as `ScoreBreakdown` |
| `RankingResult` | `data_basis: DataBasis`, `policy: ComparabilityPolicy` | the single data basis and the policy of this ranking |
| `DataQualitySummary` / `ViabilityAssessment` | `data_basis` (property) | derived, not stored (D6) |
| `ViabilityAssessment` | `comparability_key(policy)` | entries may share a ranking only if their keys are equal (D7) |
| `MissionScenario` | `score_component_status(c)`, `effective_score_weights()`, `configuration_key()` | configuration-only scoring metadata (D5, D7) |

New enums: `ScoreStatus`, `ScoreComponentStatus`, `DataBasis`, `ComparabilityPolicy`. A legacy
`ScoreBreakdown` (no `status`) keeps its Phase 1 meaning and can't be ranked by the Phase 5 rules.

### Score states (enforced)

| `status` | `score` | `score_bounds` | When |
|---|---|---|---|
| `known` | exact value, rounded to 6 decimals | KNOWN, same value | every ACTIVE component is KNOWN |
| `bounded` | **null** | BOUNDED `[lower, upper]`, rounded **outward** to 6 decimals | some ACTIVE component is only bounded |
| `eligibility_unknown` | null | null | eligibility is UNKNOWN (D4) |
| `no_scorable_components` | null | null | eligibility is PASS or FAIL and no component is ACTIVE (D5) |

A conservative lower bound is **never** written into `score`. Validators check: KNOWN score = 100·Σ
ŵ·v within 1e-6; BOUNDED bounds = 100·Σ ŵ·v_lo and 100·Σ ŵ·v_hi, rounded outward; ACTIVE weights =
declared / Σ declared over ACTIVE; components listed once each, in `ScoreComponent` order.

### D1. Solar component

`SUNLIGHT` v = `mean_solar_disk_fraction`, the time-mean visible fraction of the solar disk, in
[0, 1]. **It is an illumination proxy, not solar electrical energy:** it ignores array orientation and
incidence angle, efficiency, temperature, dust and the power system, and it does not apply the panel
threshold (`solar_power_min_disk_fraction`, which enters only through `SIMULTANEOUS` and
`DARKNESS_MARGIN`). `EARTH_VISIBILITY` v = `earth_visible_percent / 100`; `SIMULTANEOUS` v =
`simultaneous_percent / 100`. Metric KNOWN → exact; BOUNDED → its bounds; UNAVAILABLE → [0, 1].

### D2. Outage margins

For `DARKNESS_MARGIN` / `BLACKOUT_MARGIN`, with limit `t` (seconds) and Phase 4A margin interval
`[m_lo, m_hi]` (`m = t − D`, `D` = longest outage within the mission):

```
g(m) = min(1, max(0, m / t)) = clamp(1 − D/t, 0, 1)      # share of the limit left unused
normalized = [g(m_lo), g(m_hi)]                           # g is monotone non-decreasing
```

- **Missing requirement** (limit unset, margin NOT_APPLICABLE): the component is `not_configured`
  and excluded (D5). No reference value is invented.
- **Zero threshold:** impossible; both limits are `PositiveDurationS` (rescue: `gt=0`). Scoring
  raises `ValueError` for `t ≤ 0` or a non-finite `t`. Minimum-requirement margins are not score
  components, so a zero minimum never enters the score.
- **Negative margin:** clamps to 0 at that bound. A FAIL keeps a descriptive score, but the clamp
  hides how far the limit was missed (rescue reads that from `relative_shortfall`).
- **Missing data:** a bounded margin is an interval. An UNAVAILABLE metric gives `m ∈ [t − |R|, t]`,
  i.e. v ∈ `[max(0, 1 − |R|/t), 1]`.
- **Outage already in progress at landing:** the margin is mission-scoped and used as is. Landing
  in darkness is a risk indicator (§5d), not a score input.

### D3. Uncertainty

A component is KNOWN when its normalized lower and upper values are exactly equal (after the
clamp), otherwise BOUNDED (`lower < upper`). With `ŵ` the effective weights (D5):
`S_lo = 100·fsum(ŵ·v_lo)`, `S_hi = 100·fsum(ŵ·v_hi)` in enum order. All ACTIVE components KNOWN →
`known`; otherwise `bounded` (table above). The true score lies in `[S_lo, S_hi]` for every value
consistent with the evidence. The bounds are valid but not necessarily tight: they treat components
as independent and ignore relations such as simultaneous ≤ min(power-lit, Earth visible).
`normalized_value` and `contribution` are filled only for KNOWN components. Missing measurements
never remove a component; they widen the bounds.

### D4. Score by eligibility

- **UNKNOWN** → `score = null`, `score_bounds = null`, `status = eligibility_unknown`,
  `rank_eligible = false`. Components keep their weights, with no normalized values. Enforced on
  `ViabilityAssessment` for every producer, including legacy breakdowns.
- **FAIL** → may carry a descriptive score (`known` or `bounded`), never rank-eligible, never ranked.
- **PASS** → scored. A PASS with a `bounded` score keeps `score = null` and its interval; a PASS
  with `no_scorable_components` has no number at all. Neither is given an artificial value. Their
  place in a ranking follows D8.
- Scoring reads eligibility only to withhold the score for UNKNOWN. It never changes PASS / FAIL /
  UNKNOWN (§5c), and `rank_eligible == (eligibility == pass)` is still enforced.

### D5. Weights from configuration only

Component status, checked in this order: `unsupported` (CLEARANCE_MARGIN: clearance is not evaluable,
§5c, and mean clearance is never a stand-in) → `not_configured` (DARKNESS / BLACKOUT without their
limit) → `zero_weight` → `active`. Effective weights `ŵ_c = w_c / Σ_active w` (computed after
scaling by the largest active weight, so huge weights cannot overflow), 0 for the others; all zero
when nothing is active (`no_scorable_components`). The status and weights depend only on the
preferences, spacecraft limits and engine version, **never on measurements**, so every scenario with
the same configuration has the same weights. The user's weights are kept as given
(`declared_weight`); a positive clearance weight is accepted but stays `unsupported`.
Defaults: sunlight 1, Earth 1, simultaneous 0, darkness 1, blackout 1, clearance **0** (was 0.5).
With both outage limits set (every rescue scenario), the four active components weigh ¼ each.

### D6. Data basis (never mixed)

`data_basis` = `synthetic` if `provenance.is_synthetic`; otherwise `real_geometric_only` if
`calculation_basis = geometric_only`; otherwise `real_terrain_aware`. A ranking has exactly one data
basis (`RankingResult.data_basis`, enforced on every entry). No policy can put synthetic and real
scenarios, or real terrain-aware and real geometric-only scenarios, into one ranking, **including in
rescue's simulation mode**. Synthetic scores are computed the same way and their note starts with
`[SYNTHETIC DATA]`.

### D7. Comparability

`ViabilityAssessment.comparability_key(policy)` = (data basis, `method_version`, exact effective
weights as rationals from `ScoreBreakdown.weights_signature()`), plus `configuration_key` under
`strict`. Rationals make the comparison exact and scale-invariant (1:1 equals 2:2).

| Policy | Must match | Use |
|---|---|---|
| `strict` (**default**) | data basis, method, effective weights, `configuration_key` | ordinary ranking |
| `same_method_and_weights` (explicit opt-in) | data basis, method, effective weights | ranking scenarios with different requirements or durations; scores then do not express the same requirement set, and `RankingResult.policy` records the choice |

`configuration_key` = `"sha256:"` + SHA-256 of canonical JSON (sorted keys, no whitespace, numbers
as floats, `-0.0` → `0.0`) of: key version; mission duration in integer microseconds; the
spacecraft's power source, communication mode, both outage limits and panel threshold; and every
`MissionRequirements` field except the inert `unknown_data_policy`. It ignores scenario id, name,
site, start time, spacecraft name and preferences. Assessments with different keys can still be
shown side by side, grouped by key, but their scores are not ranked against each other.

### D8. Ranking order and missing scores

Tiers stay PASS, then UNKNOWN, then FAIL (§5); only PASS entries get ranks 1..n. Within each tier,
sort ascending by these keys (the last key is unique, so the order is total and independent of the
input order):

| Tier | Keys, in order |
|---|---|
| PASS | 1. scored before unscored (`no_scorable_components` last); 2. **score lower bound descending** (exact score for `known`, `score_bounds.lower` for `bounded`); 3. `known` before `bounded`; 4. `overall_risk`: low < moderate < high < unknown; 5. min(`sun_coverage_percent`, `earth_coverage_percent`) descending; 6. `scenario_id` ascending (code-point order) |
| UNKNOWN | 1. number of UNKNOWN constraints ascending; 2. min coverage descending; 3. `scenario_id` ascending |
| FAIL | 1. number of FAIL constraints ascending; 2. number of UNKNOWN constraints ascending; 3. scored before unscored, then score lower bound descending; 4. `overall_risk` as above; 5. `scenario_id` ascending |

- Ordering a bounded score by its lower bound is a documented **conservative ordering policy**: the
  entry still shows `score = null` and its `score_bounds`, so the bound is never presented as the score.
- Scores are compared exactly on the stored, rounded values, never with a tolerance (approximate
  equality is not transitive).
- **Risk is a tie-breaker only** and never changes a score. UNKNOWN sorts after HIGH because its worst
  case is HIGH, so on a tie the evidence-backed result goes first.
- `RankingResult` enforces PASS keys 1–3 from its own entries. Keys 4–6 need the assessments and are
  tested in 5B.

### Phase 5 limitations

The score is a relative desirability index for illumination and line-of-sight geometry under the
stated preferences. It is not a probability, a power or energy estimate, a radio-link estimate or a
landing-safety rating, and it never replaces the hard-constraint verdicts.

## 5f. Phase 5 integration: scoring, ranking and `evaluate_scenario`

`evaluate_scenario(scenario, series)` is pure and deterministic and runs, in this order:
`analyze_scenario` (Phase 2) → `build_constraint_assessment` (Phase 3) → `margins_from_assessment`
(4A) → `assess_risks` and `overall_risk` (4B) → `score_scenario` (5A, given the Phase 3 eligibility
and the data basis). The result is one `ViabilityAssessment`. **Ranking is a separate, explicit
step**: `rank_assessments(list_of_assessments)` (5B, also importable from `scoring`). Scoring and
ranking only read earlier results. They never change eligibility, a metric, a margin or a risk
level (tested by evaluating one scenario under different preferences: everything but the score is
identical, and by snapshotting assessments around a ranking).

### Scoring formulas and normalization

Score = `100 · Σ ŵ_c · v_c` over the ACTIVE components, each `v_c ∈ [0, 1]`:

| Component | Normalized value `v` |
|---|---|
| `sunlight` | `mean_solar_disk_fraction` (an illumination proxy, **not** energy) |
| `earth_visibility` | `earth_visible_percent / 100` |
| `simultaneous` | `simultaneous_percent / 100` (default weight 0) |
| `darkness_margin` | `clamp(margin / max_continuous_darkness_s, 0, 1)` |
| `blackout_margin` | `clamp(margin / max_communication_blackout_s, 0, 1)` |
| `clearance_margin` | unsupported; never part of a score |

Percent metrics are time-weighted over the whole mission, so a missing hour is never counted as 0 and
nothing is counted twice: each fact enters through exactly one component.

### Effective scoring weights

`ŵ_c = w_c / Σ_active w`, from the scenario configuration only (D5): a component is ACTIVE unless it
is unsupported, has no configured outage limit, or has weight 0. Missing data never removes a
component or changes a weight; it widens the interval. With both outage limits set and the default
preferences, the four active components weigh ¼ each. Different weights give different scores, so
rankings require identical effective weights (rationals, scale-invariant).

### Score uncertainty: exact versus bounded

- **Exact** (`status = known`): `score` is a number rounded to 6 decimals, and `score_bounds` is KNOWN with the
  same value (a `value`, no interval).
- **Bounded** (`status = bounded`): `score` is **null**; `score_bounds` is `[lower, upper]`, rounded **outward**
  (lower down, upper up) to the 6-decimal grid. The true score is inside for every value consistent with the
  evidence; the bounds are valid but not necessarily tight.
- **Unavailable**: `eligibility_unknown` (score withheld, D4) or `no_scorable_components`: no number at all.

A lower bound is never written into `score` and must never be displayed as "the score".

### Configuration fingerprints

`configuration_key` (`sha256:` of canonical JSON, D7) identifies what a score was measured against:
mission duration, power source, communication mode, both outage limits, panel threshold and every hard
requirement. It ignores id, name, site, start time and preferences. Under the default `strict` policy
only equal fingerprints are ranked together; different fingerprints raise
`RankingComparabilityError` (use `partition_comparable` to group them). `same_method_and_weights` is an
explicit opt-in that drops the fingerprint and duration check (data basis, method and weights must still match).

### Eligibility-aware ranking and deterministic tie-breakers

Tiers are PASS, then UNKNOWN, then FAIL; only PASS entries get ranks, so a failing scenario can never
outrank a passing one, whatever its score. Within PASS the keys are (D8): scored before unscored; score
**lower bound** descending; `known` before `bounded`; risk (low < moderate < high < unknown); minimum of sun and
Earth coverage descending; `scenario_id`. All keys compare stored values exactly and the last key is
unique, so the order is total and independent of the input order (tested with shuffled inputs).
Risk therefore only breaks ties and never changes a score; a higher score beats a lower risk level.

### Conservative ordering of bounded scores

A bounded score is ordered by its **lower bound**. This is a **conservative ordering policy**, not an
estimate: it says "even in the worst case consistent with the evidence this scenario scores at least this
much", which avoids ranking a scenario first because of an optimistic unknown. It is **not** a point
estimate, midpoint or expected value; the entry keeps `score = null`, `score_status = bounded` and its full
`score_bounds`. An exact score equal to a bounded lower bound ranks ahead of it (key 3). The ordering can
place a bounded `[90.8, 100]` scenario below an exact 94.2 and above an exact 72.5; consumers must show
the interval, not a number.

### Data quality and synthetic-data separation

`data_basis` (real terrain-aware, real geometric-only, synthetic) is derived from the series provenance
and calculation basis, never chosen by the caller. Rankings never mix bases, under any policy, including
rescue's simulation mode. Synthetic scores are computed the same way but their note starts with
`[SYNTHETIC DATA]`. A mission outside the real coverage is UNKNOWN (never scored); rescue reports
`no-real-data` unless simulation is explicitly switched on, and then labels the result
`synthetic-placeholder`.

### Scientific limitations

- The score is a relative index of illumination and line of sight under the stated preferences; it is not
  power, energy, link quality, landing safety or probability. The Sun term uses the disk fraction, so
  geometry such as sun angle or array orientation is ignored.
- Real results inherit the terrain and horizon pipeline. Generator 1.2's finer terrain tiers changed Malapert's
  sunlight from 82.6 % to 77.1 %: scores and ranks on real sites **shift whenever Member 1 regenerates the
  data**, and any stored score must carry the data version (`provenance.generator`, `dataset_id`).
- The bounds treat components as independent, so they can be wider than necessary.
- Normalizing margins by the outage limit means a 10 h margin is worth more against a 24 h limit than a 400 h
  one. Weights are user preferences, not physics.
- Eligibility uses the hard constraints only; a high score does not make an ineligible scenario acceptable.
- Clearance (terrain-skyline margin) is not scored yet (§5c, item 10).

### How consumers should interpret and display results

1. Show eligibility first (PASS / FAIL / UNKNOWN); show a rank only when there is one.
2. Show `score` only when `score_status = known`. For `bounded` show the interval (for example "between
   90.8 and 100") and say the order uses the lower bound; never print the lower bound alone as the score.
3. For `eligibility_unknown` and `no_scorable_components` show "not scored" with the reason.
4. Always show `data_basis`; label synthetic results as simulation. Never put results with different data
   bases or configuration fingerprints into one table without grouping them.
5. Show risk separately from the score. Since Phase 6 `explanations` is always filled (§5g); render it in
   order and keep the `[SYNTHETIC DATA]` prefix visible.

Code: `evaluate_scenario` in `engine.py`, scoring in `scoring.py`, ranking in `ranking.py`; tests in
`test_phase5_integration.py` (whole pipeline on the four real sites, synthetic exact, bounded and unavailable cases,
data-basis separation, tie-breaking, mutation, rounding) next to `test_scoring_phase5.py`, `test_ranking_phase5.py`
and `test_real_sites_phase5_scoring.py`.

## 5g. Phase 6: explanations and Rescue integration

`ENGINE_VERSION = "0.6.0-phase6"`. Phase 6 adds text and validation only: **no verdict, metric, margin, risk
level, score or ranking changed** between `0.5.0-phase5` and `0.6.0-phase6` (tested by evaluating with and without
explanation generation and comparing every other field). The version bump is visible to Rescue only as
`ViabilityResult.source = "viability-engine/0.6.0-phase6"`.

```
env, checks, margins, risks, level, score   (Phases 2–5, unchanged)
        └─► explain.generate_explanations(eligibility, constraints, margins, risks, data_quality,
                                          score=score, overall_risk=level)  ─► assessment.explanations
```

### Phase 6A: evidence-based explanations

`explain.py` (`EXPLANATION_METHOD_VERSION = "explanations-v1"`) is a **presentation layer**. It decides nothing:
verdicts and levels are read from their fields; margin classes reuse `margins.classify_margin`; a margin missing from
the input is derived with `margins.operational_margin` (the same Phase 4A arithmetic). Inputs that contradict each
other (eligibility versus constraint verdicts, `overall_risk` versus the indicators, score versus eligibility) raise
`ValueError` instead of being explained; inside `evaluate_scenario` that would be an engine bug, never user input.

Items, in a deterministic order with stable `ExplanationDetail.key` values:

| Order | Category | Content |
|---|---|---|
| 1 | `summary` | eligibility verdict; overall screening risk (HIGH despite PASS is stated explicitly); score: exact, bounded **interval rounded outward**, withheld (UNKNOWN eligibility) or "no scorable components"; weighted breakdown; excluded components |
| 2 | `constraint` | one per configured constraint, FAIL → UNKNOWN → PASS: threshold, measured value or proven bounds, unit, verdict, size of the shortfall, evidence windows |
| 3 | `margin` | positive / narrow / zero / negative / uncertain headroom, with the risk indicator that bands it |
| 4 | `risk` | landing in darkness or without Earth line of sight, and any indicator not explained elsewhere |
| 5 | `data_quality` | synthetic (simulation), geometric-only or real provenance; coverage (sample gaps versus unknown states); pipeline warnings |
| 6 | `limitation` | sampling resolution, illumination ≠ power, line of sight ≠ communication, unverified spacecraft capabilities, heuristic risk bands |

Normative wording rules (tested on synthetic and real data):
- A constraint is called PASS, FAIL or UNKNOWN exactly as its `status` says. **UNKNOWN is never called a failure**;
  an unsupported requirement (clearance) is never described as evaluated.
- No invented quantities: no probability of mission failure, no power or link estimate, no point value for a bounded
  quantity. Advice to weaken a requirement is never given (that is Rescue's loosening feature, with its own caveats).
- Every risk indicator is explained by **exactly one** item (`ExplanationDetail.risk_codes`).
- Synthetic data prefixes **every** message with `[SYNTHETIC DATA]`.
- `Explanation.message` is at most 500 characters; quoted external text (metric reasons, warnings) is shortened to
  160 characters in the message and kept in full in `ExplanationDetail.details`.

Real example (Malapert Massif, landing 2027-03-01, 14 days, rescue default requirements; 26 items):

> Eligibility PASS: all 6 configured hard constraint(s) are met. …
> Overall screening risk HIGH, driven by power-darkness exposure. Every configured hard constraint still passes: …
> Desirability score 68.11 / 100 (exact). It is rank-eligible because eligibility is PASS. …

Entry points: `evaluate_scenario` (filled automatically), `generate_explanations` (Phase 1 signature plus the
keyword-only `score=` and `overall_risk=`, additive), `build_explanation_details`, and `explain_assessment` /
`explain_assessment_details` for a whole assessment (its own `explanations` are ignored). All are exported from
`app.viability`. Generation cost was not measurable above timing noise on a 14-day Rescue evaluation (≈ 4 ms
either way).

### Phase 6B: Rescue compatibility validation

`compat/rescue.py` (`rescue-compat/0.3.0`) was validated behind Rescue's own `Evaluator`, provider and coverage policy,
side by side with the placeholder on real data (four original and six whole-Moon sites), and three adapter defects
were fixed: longitude wrapping (§5a), the one-step final-bin hold capped at mission end (§5a), and violations in
Rescue's requirement order (same text as the placeholder). Results: on fully covered real data **every metric,
verdict and violation equals the placeholder's**; scores differ only by the documented formula. Rescue search,
sensitivity and compromise all run on the canonical engine. A 40-seed property test checks that unknown data never
produces a confirmed result.

### Rescue integration findings (for Member 5)

Investigated with the canonical engine behind Rescue's real `Evaluator` (`make_evaluate_fn()`) on the committed
site files. **All three known issues are in `app/rescue/` (Member 5's code) and were not changed.** The canonical
side provides what each fix needs.

**Finding 1: a `None` score is ranked as zero.** `search._rank_score`, `compromise` and `sensitivity` use
`ViabilityResult.score_or_zero`. With the canonical engine a PASS can have `score = None` when its score is only
bounded. Example: Connecting Ridge, 3-day mission landing 2028-12-29T01:00Z (rescue defaults) is PASS with proven
score bounds **[79.04, 80.50]**, yet gets `rank_score = −0.5` (placeholder: 79.15 → 80.0), so it would rank below
every scored candidate. On the committed files this happens only at the dataset end (finding 3): with rescue defaults,
5 of 32 boundary cases (8 catalog sites with real data × 1, 3, 7, 14 days: Connecting Ridge 3 d; Malapert and
Mons Mouton 3 d and 7 d). A failing
candidate with a bounded score likewise gets sensitivity score 0. *Options for Member 5:* order PASS-with-`None` by
the conservative lower bound from `evaluate_timeline_detailed(...)[1].score.score_bounds` (the canonical ranking's
policy, §5f), or put it in a separate "not scored" tier, never at 0. Carrying the interval in `ViabilityResult`
needs a shared-contract change (e.g. an optional `score_bounds`), agreed with Members 4 and 5.

**Finding 2: real and synthetic candidates in one ranking.** In simulation mode (`include_synthetic=True`), catalog
sites are evaluated on real data and nearby custom points on synthetic geometry, and `rescue()` ranks them together.
Example (PNS, 2027-03-01 + 3 days, 6-day window): ranks 1, 2 and 4 are synthetic custom points (scores 100, 100, 93.5),
ranks 3 and 5 are real Connecting Ridge candidates. Each result is labelled (`data_source`), but the order compares
invented terrain with Horizons + LOLA. The canonical `rank_assessments` refuses this under every policy (D6).
*Option:* rank real and synthetic separately, or real first.

**Finding 2b (new): a simulation batch that crosses the dataset end turns covered candidates synthetic.**
`Evaluator.evaluate_many` fetches one timeline for all start times of a site; `PrecomputedTimelineProvider.timeline`
falls back to synthetic for the **whole** range if any part is uncovered. Example (Malapert, 14 days): landing
2028-12-12 alone is evaluated on real data (FAIL), but batched with 2028-12-27 both are evaluated on synthetic
geometry (FAIL and PASS, both labelled synthetic). *Option:* fetch covered and uncovered starts separately.

**Finding 3: end-of-dataset coverage.** Rescue's coverage check accepts a mission whose last hourly bin starts at
the file's final instant (2029-01-01T00:00Z), i.e. it counts that instant as covering one more hour (also in
`no_data_result`, which reports coverage up to `last + 1 h`). The canonical series ends at that instant, so the
latest accepted landing for each site and duration gets one unknown hour: the score is bounded (`None`) and, rarely,
the verdict becomes UNKNOWN where the placeholder decides (Malapert 1 day with 24 h initial sunlight: placeholder PASS
86.46, canonical UNKNOWN). Never a PASS↔FAIL flip (tested). One hour earlier the results are identical; one hour later
rescue itself answers UNKNOWN. *Option:* require `landing + n·step ≤ last sample` in `evaluate_many`, and use the
last sample (not `+1 h`) as the coverage end.

**Required change for Arush (not made here).** To switch Rescue to the canonical engine:

```python
# app/rescue/viability/__init__.py
from app.viability.compat.rescue import evaluate_timeline   # instead of .placeholder's
from .placeholder import CHECK_BY_CONSTRAINT, CHECKS         # keep: loosening wording/rounding table
```

Before or with the switch: (1) stop treating `score=None` as 0 (finding 1); (2) after it, scores change by formula,
so rank-dependent tests and thresholds such as `search`'s "better option available" (+5 points) need review;
(3) Member 4's comparison (`app/compare/service.py`) imports the same swap point and switches with it;
(4) findings 2, 2b and 3 are independent of the switch but affect what users see in simulation mode and near
2029-01-01. If Rescue passes a non-default data directory, use
`make_evaluate_fn(precomputed_data_dir=...)` so the final-bin coverage check reads the same files.

### Phase 6 scientific limitations

- Explanations restate the engine's evidence; they inherit every limitation of §5b–§5f (sampling resolution,
  sample-and-hold timing uncertainty up to one spacing, heuristic risk bands, score formula) and add no validation.
- Template text in English, versioned by `explanations-v1`; frontends that translate should key on
  `ExplanationDetail.key` and the method version.
- Through Rescue's shared `ViabilityResult` no explanation, risk, data basis or score interval is visible; Rescue's
  own `app/rescue/explain.py` text is generated from its metrics. Use `evaluate_timeline_detailed` for the canonical
  explanations.
- Rescue's coverage policy withholds verdicts the canonical engine could prove from partial data (stricter, never
  wrong); the synthetic fallback remains open (§10 item 14).

Code: `explain.py`, `engine.py`, `compat/rescue.py`. Tests: `test_explain_phase6.py` (41 synthetic-pipeline cases),
`test_real_sites_phase6_explanations.py` (four real sites, quoted values recomputed with NumPy),
`test_phase6_rescue_compat.py`, `test_real_sites_phase6_compat.py` (side by side on ten real sites, Rescue search /
sensitivity / compromise), `test_phase6_integration.py` (explanations in `evaluate_scenario`, no feedback into other
fields, unchanged ranking and Rescue results, synthetic labelling, bounded PASS at the dataset end).

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

Phase 3 tests: `test_constraints.py` (decision rule at / just below / just above every threshold
direction, tolerance, admissible ranges, panel thresholds, direct vs power-lit, start/end edge
cases, partial / full unknown data, bounds proving PASS and FAIL, coverage gaps, beyond-coverage,
irregular sampling and both sampling policies, worst-case policy, unsupported clearance,
aggregation, identity checks, JSON determinism), `test_real_sites_phase3.py` (four real files:
verdicts vs an independent NumPy recomputation, two-year limits at the measured extremes, exact
coverage end, straddling and post-coverage missions), Phase 3 additions to
`test_rescue_compat.py` (verdict and Violation equivalence with the placeholder; unknown and
worst-case mapping to `is_unknown`) and validator tests in `test_outputs.py`.

Phase 4 tests: `test_margins_phase4.py` (sign convention, intervals, admissible ranges, tolerance,
classification incl. the inclusive band and time resolution, unsupported / unconfigured, clipping,
verdict agreement, real-site margins vs an independent computation), `test_risk_phase4.py`
(every rule and band edge on hand-made margins, bounded evidence, landing rules, coverage,
synthetic / geometric flags, input validation, determinism, policy independence of eligibility),
`test_real_sites_phase4_risk.py` (levels on four real files vs an independent computation), and
`test_phase4_integration.py`. That last module runs the unmocked pipeline Phase 2 → 3 → 4A → 4B
for passing, narrow, failing, fully unknown, partly bounded, unsupported, landing-dark,
landing-without-Earth, dataset-edge and out-of-range missions. It also covers synthetic labelling,
policy and worst-case independence, a threshold sweep, deterministic JSON and all four real sites.
It checks the margin-to-risk contract (§5d) on every run.

Phase 5 tests are listed in §5f, Phase 6 tests in §5g. Rescue's own suite (`tests/test_rescue*.py`,
`tests/test_engine_side_by_side.py`, `tests/test_sensitivity_compromise.py`) must keep passing with every engine change.

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
| 3 ✅ | Constraint evaluation with unknown-data policy; coverage-aware bounds; eligibility (§5c) |
| 4 ✅ | Operational margins with bounds and classes; rule-based risk indicators (§5d); clearance margins pending item 10 |
| 5 ✅ | Normalised, explainable score (5A); eligibility-aware ranking (5B); integrated into `evaluate_scenario` (§5e, §5f) |
| 6 ✅ | Evidence-based explanations in every assessment (6A); Rescue compatibility validated side by side (6B); Rescue findings handed to Member 5 (§5g) |
| 7 | Real-data tests with Member 1 output; validation with Member 6; FastAPI endpoint wiring |

## 10. Remaining integration decisions

**Settled by reading Andrew's engine (no action needed):**
- Sun = apparent disk, using the distance-dependent radius from Horizons `Ang-diam` (0.2666° fallback). Earth = centre above terrain, margin > 0.
- `horizon_deg` = the 0.5°-sampled skyline interpolated at the body-centre azimuth. It includes exact spherical curvature and the 2 m observer height.
- Angles are Horizons apparent az/el (quantity 4), measured against the spherical horizon. Times are UT, hourly.
- Longitude: the file keeps 0–360; the adapter converts (no change needed on his side).

**Open, with Member 1 (Andrew):**
1. **Lunar body-fixed frame: stated by Member 1, not independently verified here.** Andrew documents (docs/data-sources.md, `meta.frame`) that sites, Horizons and LOLA are all Moon **Mean-Earth/polar-axis (ME)**. His engine refuses any Horizons response whose `Center pole/equ` header is not `MEAN_ME`. The LOLA side rests on product documentation (MOON_ME, DE421), and he notes a metre-level DE421 vs DE441 residual. That is a code-level check on the ephemeris side, which the viability engine has not repeated. We record the statement in `provenance.coordinate_frame`, label it "not independently verified", and make no stronger claim. Member 6 may want an independent check (e.g. one Horizons header plus the DEM product metadata).
2. ~~Precision~~ **done in format 1.1** (6 decimals + `sun_visible`); sub-precision sliver hours are handled (§3a).
   **Done in generator 1.2 (origin/main `2e33678`):** every 1.2 file carries `meta.fraction_decimals` (6) and
   `meta.angle_decimals` (3). The adapter prefers `meta.fraction_decimals` (strict integer 0–17, else
   `SiteFileError`), falls back to the version table for older files (1.0 → 3, 1.1 → 6), and records
   `angle_decimals` in `provenance.notes` (the input contract has no angle-precision field, so no shared
   contract was changed). The engine never invents this metadata.
3. ~~Angular radius / generation metadata~~ **done in format 1.1** (`sun_angular_radius_deg`, `generated_utc`, `generator_version`); all carried by the adapter.
4. ~~Nullable shared `TimelineStep`~~ **done** (Andrew: `null` = unknown for custom sites; the adapter maps it to `unknown`). Curated sites contain no nulls.
5. Is one observer height enough, or are separate solar-array and antenna heights needed?
6. Can uncertainty estimates be provided (with Member 6)?

**Engine semantics (decided in Phase 2; team review welcome):**
7. *Integration rule:* **decided.** Sample-and-hold by default (the source convention), with nearest-sample (midpoint) available as `SamplingPolicy.NEAREST_SAMPLE` for sensitivity checks. Interpolated zero-crossings are not used (§5b). Member 6 may want to quantify the timing uncertainty (≤ one spacing).
8. *Partial sunlight:* **decided.** All three are reported separately: direct (fraction > 0, matching Andrew's `sunlit_pct`), full and partial. Power-eligibility uses `solar_power_min_disk_fraction`, and without a threshold it equals direct sunlight. **Phase 3:** `min_sunlight_percent` keeps testing direct sunlight; a separate `min_power_lit_percent` is *proposed* (§5c), not added.
9. *Darkness spanning mission start:* clipped to the mission and flagged `clipped_at_start`. Phase 3 evaluates the clipped value and exposes the clipped evidence window; battery state at landing is still not modelled; **Phase 4** flags it with `landing_in_darkness` and `MarginAssessment.clipped_at_mission_start` (§5d).

**Phase 3 decisions for team review:**
10. *Clearance requirements:* `min_sun/earth_clearance_deg` are `unknown (unsupported)` when set (§5c). Needs a decision: mask angle redefining visibility (changes Phase 2 conditions) vs per-instant minimum (needs a per-sample minimum metric).
11. ~~`worst_case` policy~~ **retired** (deprecated, inert; §5c). Members 3/4/5: please don't build on it.
12. *Initial requirement longer than the mission:* kept as FAIL for compatibility (mission-scoped, same as rescue's placeholder). The message now states that the requirement exceeds the mission duration. With no data, it is also the only FAIL that needs no observations: the bound `[0, mission]` already rules it out. *Recommendation:* treat it as a configuration error, rejected where the scenario is built (UI / `MissionScenario`). That is a shared-input change, because rescue scenarios with `duration_days < min_initial_*_hours / 24` would start raising, so it needs Member 5's agreement first.
13. *Contract notice:* `ConstraintEvaluation` gained optional fields (additive, defaults); `ConstraintAssessment` is new. Members 3/4 should know before consuming them.
14. *Synthetic fallback in rescue (Member 5):* rescue's provider swaps a whole mission to synthetic geometry when it reaches past the dataset, and verdicts on it are definite but labelled synthetic. Since Phase 6 this is known to swap a whole simulation **batch** too (§5g finding 2b). Options: rescue truncates or refuses such missions; or the canonical engine reports synthetic-basis results as UNKNOWN (affects custom sites and every synthetic test fixture). Not changed here.

**Phase 4 decisions for team review:**
15. *Band boundary:* exactly 10 % headroom counts as `narrow` / HIGH (inclusive, resolving
    towards caution). The Phase 1 stub said "below 10 %". Revisit together with the 10 % / 25 %
    heuristic values, ideally with Member 6.
16. *Landing relevance:* landing indicators depend on `power_source` / `communication_mode`, the
    first engine use of those fields. `other` power counts as possibly sun-reliant.
17. *Coverage indicators* are emitted for every spacecraft (a property of the evidence), so an
    RTG relay rover can still get MODERATE from a data gap.
18. *Contract notice for Members 3/4/5:*
    - `assess_risks` takes `(scenario, ConstraintAssessment, margins | None)` instead of the
      Phase 1 stub `(scenario, metrics, margins, data_quality)`;
    - indicator codes follow §5d (`margin_headroom.<id>`, `unsupported_requirement.<id>`);
    - `MarginAssessment` is engine-internal, not part of `ViabilityAssessment`.

    No shared model changed. `evaluate_scenario` is not wired yet, so no consumer is affected
    today.
19. *Vacuous zero minimum* (e.g. `min_sunlight_percent = 0` with 0 % observed): the margin is
    `at_threshold` while risk is LOW, because the requirement cannot fail. Consider rejecting zero
    minimums at scenario construction.

**Phase 6 decisions for team review:**
20. *Rescue findings 1, 2, 2b, 3 (§5g):* Member 5's code; options listed there. Not changed here.
21. *Shared `ViabilityResult` has no field for explanations, risks, data basis or a score interval.* Proposal (needs
    Members 4 and 5): optional additive fields, e.g. `score_bounds` and `explanations`. Until then Rescue and the
    comparison see none of them; `evaluate_timeline_detailed` returns them.
22. *Contract notice for Members 3/4/5:* `explanations` is no longer empty (`explanations-v1`, §5g);
    `generate_explanations` gained keyword-only `score=` and `overall_risk=` (additive); `ENGINE_VERSION` is
    `0.6.0-phase6`, so Rescue results report `source = "viability-engine/0.6.0-phase6"`. No shared model changed.

**With Members 3/4/5:** the field names above; whether `windows[]` should be paginated or
down-sampled for long missions (a full 2-year analysis yields 300–600 windows per site). *Resolved in C0:* failed
scenarios may carry a descriptive score but are never ranked; UNKNOWN eligibility is never scored (§5e, D4).
