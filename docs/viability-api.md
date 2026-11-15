# Viability API (Member 2)

HTTP access to the canonical viability engine (`backend/app/viability`). Package: `backend/app/viability/api/`
(`schemas.py`, `service.py`, `router.py`) · version `viability-api/1.0.0` ·
tests: `backend/tests/viability/test_api_viability.py`.

| Endpoint | Purpose |
|---|---|
| `POST /api/viability/assess` | Full canonical assessment of one mission at one precomputed site |
| `GET /api/viability/validation-summary` | Structured summary of the engine's validation suite, with a currency check |

**Registration.** The router is mounted in `backend/app/main.py` next to the rescue, compare, assistant, terrain
and atlas routers (smoke test: `tests/test_api.py::test_viability_endpoints_are_registered`).

## 1. `POST /api/viability/assess`

The endpoint runs the same pipeline as the rest of the project on Member 1's committed site files:
`adapters.load_site_file` → `windows.prepare_series` → `engine.evaluate_scenario`. The response contains the
`ViabilityAssessment` unchanged. The API never computes a second verdict, never turns UNKNOWN into FAIL, never
writes a bound or a missing value into `score`, and never extrapolates past the data.

### Request (strict)

```json
{
  "site_id": "malapert-massif",
  "mission_start_utc": "2027-07-20T00:00:00Z",
  "mission_end_utc": "2027-08-03T00:00:00Z",
  "spacecraft": {
    "name": "Solar direct-to-Earth lander",
    "power_source": "solar",
    "communication_mode": "direct_to_earth",
    "max_continuous_darkness_s": 180000.0,
    "max_communication_blackout_s": 345600.0,
    "solar_power_min_disk_fraction": 0.25
  },
  "requirements": {
    "min_mean_solar_disk_fraction": 0.5,
    "min_earth_visibility_percent": 40.0,
    "min_initial_sunlight_s": 86400.0,
    "min_initial_earth_visibility_s": 43200.0,
    "min_sunlight_percent": 50.0
  },
  "preferences": {"sunlight_weight": 1.0, "earth_visibility_weight": 1.0},
  "scenario_id": "plan-a",
  "name": "Plan A",
  "include_explanation_details": true
}
```

- `site_id`: the stem of `data/sites/<site_id>.json`. Custom sites created through `POST /api/sites/custom`
  (`data/sites/custom/<id>.json`) are also found. Only `[A-Za-z0-9._-]` is accepted, and the resolved path
  must stay inside `data/sites/`.
- `spacecraft`, `requirements`, `preferences`: the engine's own `SpacecraftConfiguration`,
  `MissionRequirements` and `RankingPreferences` (units: seconds, percent 0–100, fractions 0–1; see
  `viability-engine.md` §4). A limit left out or `null` makes its constraint `not_applicable`. There is no hidden
  default lander, so `spacecraft` is required.
- The scenario's site is the site file's own `site` block, so the scenario and the data always describe the
  same location.
- Strictness (`ContractModel`): unknown fields, numeric strings, booleans as numbers, NaN/Inf, naive or
  non-UTC timestamps and epoch numbers are rejected with **422**. An end time not after the start, or a mission
  longer than the 10-year sanity cap, is also **422** (`loc` starts with `"body"`).
- Unknown site: **404**. A site file that breaks the input contract: **422** with the adapter's reason. The
  API never guesses around bad data.

### Response

| Field | Content |
|---|---|
| `assessment` | The canonical `ViabilityAssessment` (`viability-engine.md` §5). It holds eligibility PASS / FAIL / UNKNOWN; every `constraints[]` item with status, threshold, measured `Metric` (known / bounded / unavailable / not_applicable), message, `unknown_reason` and `evidence_windows`; `metrics`; `windows`; operational `margins`; `risks` and `overall_risk`; `score`; `explanations`; `data_quality` (provenance, data basis, coverage, `assumptions`, `warnings`); and `limitations`. |
| `ranking_status` | A verbatim projection of the assessment for ranking consumers: `eligibility`, `rank_eligible` (= `score.rank_eligible`, true only for PASS), `score_status` (`known` / `bounded` / `eligibility_unknown` / `no_scorable_components`), `score` (exact only), `score_bounds`, `score_lower_bound` (for ordering only), `overall_risk`, `comparability` (`data_basis`, `scoring_method_version`, exact `effective_weights` as `"p/q"`, `configuration_key`) and the ranking `rule` text. |
| `explanation_details` | `explain_assessment_details(assessment)`: the same explanations with stable keys, related risk codes and technical evidence. `null` when `include_explanation_details` is false. |
| `input_dataset` | The input series: repository-relative `site_file`, its `sha256`, `dataset_id`, coverage start and end, `mission_within_coverage`, `sample_count`, `sampling`, calculation basis, angle type, Sun and Earth criteria, `fraction_decimals`, `observer_height_m` and the full `provenance` (JPL Horizons ephemeris, Moon Trek LOLA terrain tiers, generator and generation time). |
| `methods` | API, schema, engine, scoring, ranking and explanation versions. |

Consumers must read eligibility and score semantics from these fields, never from a re-derivation:

- **UNKNOWN is not FAIL.** `eligibility == "unknown"` means the data cannot decide. It is neither scored nor ranked.
- **A missing or bounded score is never 0.** `score: null` with `score_status: "bounded"` comes with
  `score_bounds` `[lower, upper]`. `eligibility_unknown` and `no_scorable_components` carry no number at all.
- **Only `rank_eligible` scenarios are ranked.** A FAIL keeps a descriptive `score`, but it is not a rank.
- **Ranking needs equal comparability fields.** Synthetic and real data, different weights and (strict policy)
  different spacecraft or requirement configurations must not share one leaderboard (`viability-engine.md` §5e, D6–D8).

### Performance

The first request for a site loads and validates its 5-year hourly file (43 825 samples, about 1.5–2 s) and
prepares it once. The prepared series is cached per file, keyed by path, size and modification time, so a
regenerated file is reloaded. At most 4 files are cached (about 150 MB each). Later requests take about 20 ms.
`evaluate_scenario` on a `PreparedSeries` is identical to evaluating the raw series; the tests compare both.

## 1a. `POST /api/viability/assess-scenario`

The Mission Planner's own plan shape. Body: `{"scenario": <team Scenario>, "include_explanation_details": true}`
where `Scenario` is `{site, landing_utc, duration_days, requirements}` (`backend/app/models.py`, Rescue-style
requirements in hours and fractions). The requirements are converted with
`app.viability.compat.rescue.requirements_to_canonical`, the same mapping Rescue and Comparison use, then the
request goes through `/assess` unchanged; the response is the same `AssessResponse`.

- Same verdict, score and `configuration_key` as `/api/compare` for the same scenario (tested in
  `tests/viability/test_api_assess_scenario.py`).
- Time policy: the scenario is evaluated on the shared hourly grid (`app/timegrid.py`, as Comparison, Rescue and
  the Atlas do): landing rounded to the nearest whole UTC hour, duration to whole hours. The evaluated interval is
  `assessment.evaluated_start_utc` / `evaluated_end_utc`. `/assess` itself takes explicit instants and is not
  rounded.
- Only precomputed sites: a `custom:...` or unknown site id is a 404 with an explanation; invalid input is 422.
- Used by the planner's Mission assessment panel and "Show why" (`frontend/src/features/assessment/`).
- Frontend fixtures are real responses written by `backend/scripts/make_assessment_fixtures.py`.

## 2. `GET /api/viability/validation-summary`

This endpoint serves a structured summary of the stored validation report written by the Part 2 validation suite
(`member2-part2-validation.md`). A full run takes about a minute, so the endpoint does not re-run it. It reports
whether the stored report is still current instead:

```bash
cd backend && python -m app.viability.validation --out ../data/validation/viability_validation.json
```

| Field | Content |
|---|---|
| `status` | `passed` iff the report has no failed check |
| `totals` | total and failed checks; smoke checks and any failed smoke checks |
| `cases[]` | each deep case (PASS, confirmed FAIL, high screening risk, UNKNOWN from missing data, bounded score, overlapping intervals, exact ranking, incompatible configurations, SYNTHETIC separation, dataset boundaries, sampling policy): `passed`, `check_count`, `failed_checks`, the recorded `inputs` and `outcome`. `synthetic` is true only for the labelled fixture case. |
| `invariants[]` | the five invariants with their measured detail |
| `datasets[]` | every validated site file with its recorded SHA-256, the file's current SHA-256 and `unchanged` |
| `currency` | `current` is true iff every engine and method version matches the running code and every validated file is unchanged, with no new site file left unvalidated. Otherwise it lists `version_mismatches`, `changed_datasets` and `unvalidated_datasets`. |
| `standard_lander`, `timing`, `versions`, `limitations` | the suite's lander, measured timings with the machine, method versions and the engine's standard limitations |

Missing report: **404**, with the regeneration command in `detail`.

## 3. Tests

```bash
cd backend
python -m pytest tests/viability/test_api_viability.py -q
```

The tests cover these cases on real data. Each one is cross-checked against a direct `evaluate_scenario` call on
the raw validated series:

- PASS with an exact score;
- confirmed FAIL with evidence windows (not rank-eligible, descriptive score kept);
- UNKNOWN past the end of the data (no FAIL, not scored, not ranked);
- a mission entirely after the data (`no_data`);
- a bounded score (interval, `score` null);
- `no_scorable_components`.

They also cover:

- the complete response sections;
- optional explanation details;
- scenario id defaults;
- deterministic repeated responses;
- 12 kinds of strict-validation rejections, missing fields, window errors, an unknown site (404) and path traversal;
- invalid site data (422);
- custom-site lookup and reloading of a regenerated file;
- the validation summary on the committed report, plus failure and currency detection on temporary reports;
- no route collision with `app.main`;
- the core package staying free of FastAPI.
