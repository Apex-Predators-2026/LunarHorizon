# Member 2, Part 2B: sampling-policy sensitivity of viability verdicts

Module: `backend/app/viability/sampling_sensitivity.py` · method version `1.0.0-part2b` · engine `0.6.0-phase6`
Tests: `backend/tests/viability/test_sampling_sensitivity_part2.py` (synthetic, analytical),
`backend/tests/viability/test_real_sites_sampling_part2.py` (real curated site files)

## 1. Purpose

The engine turns *instantaneous* hourly samples into time intervals with a sampling policy (§5b of
`viability-engine.md`). Two policies are supported and neither interpolates. This report answers one question:

> Would the viability decision for this mission change if the **same** measurements were interpreted with the
> other supported sampling policy?

It is a robustness check on the *interpretation of the data*, not a new data source, not a new scientific
engine and not a statistical uncertainty estimate.

## 2. Policies compared

| Role | Policy | Sample *i* represents | Transition placed |
|---|---|---|---|
| **Baseline (canonical)** | `sample_hold` (engine default, unchanged) | `[tᵢ, tᵢ₊₁)` | at a sample time (≤ 1 spacing late) |
| Alternate | `nearest_sample` | midpoint with *i−1* → midpoint with *i+1* | at a midpoint (≤ ½ spacing either way) |

Both are the engine's own `SamplingPolicy` values, applied through the existing, tested
`analyze_scenario(scenario, series, policy=...)` parameter. The canonical verdict is always the
sample-and-hold result; the report never replaces it.

## 3. What is held constant

Identical in both runs (checked at run time; `ValueError` if not):

- landing site, landing timestamp and mission end (hence duration);
- spacecraft configuration (solar-power disk-fraction threshold, darkness and blackout limits);
- every hard requirement (operational thresholds);
- the scientific measurements: the same `ScientificTimeSeries` samples, `dataset_id`, provenance, coverage;
- scoring preferences, effective weights, scoring method version and `configuration_key`;
- risk thresholds (engine default `RiskPolicy`) and every constraint rule.

Only `SamplingPolicy` changes.

## 4. How both results are computed

```python
from app.viability.sampling_sensitivity import prepare_policy_series, sampling_sensitivity_report

pair = prepare_policy_series(series)               # once per dataset: SH + NN prepared series (~90 ms, 2-year file)
report = sampling_sensitivity_report(scenario, pair)   # ~8 ms for a 14-day mission (median, Windows laptop)
report.verdict, report.summary, report.statements
report.baseline.assessment                         # == evaluate_scenario(scenario, series), exactly
report.alternate.assessment                        # same pipeline under nearest-sample
```

`evaluate_scenario_under_policy(scenario, series, policy)` composes the canonical stages in the same order as
`engine.evaluate_scenario`: `analyze_scenario(policy=...)` → `build_constraint_assessment` →
`margins_from_assessment` → `assess_risks` / `overall_risk` → `score_scenario` → `generate_explanations`.
**No constraint, margin, risk, scoring or explanation algorithm is duplicated.** The only policy-dependent stage
is Phase 2; everything downstream consumes its output unchanged. Tests assert that with the default policy the
result is identical to `evaluate_scenario` (byte-identical JSON for all 11 synthetic fixtures; model equality for
every representative real mission), which guards against the two wirings drifting apart. `compare_policy_assessments(baseline, alternate)` builds the
report from two finished assessments.

### Report contents (`SamplingSensitivityReport`)

Per policy (`baseline`, `alternate`: `PolicyEvaluation`): policy id, `engine_default`, the sampling assumptions
in words, and the complete `ViabilityAssessment` (eligibility; every constraint with status, threshold and
measured value or bounds; all metrics with KNOWN/BOUNDED/UNAVAILABLE status; windows; margins; risk indicators and
overall screening risk; exact or bounded score; explanations; data provenance and coverage).

Comparison:

| Field | Content |
|---|---|
| `verdict`, `summary` | rule in §5; one plain-language sentence |
| `eligibility_changed`, `changed_constraints`, `constraints` | per configured constraint: both statuses, unknown reasons, both measured values, delta |
| `outages` | longest power-dark period, longest period without direct sunlight, longest communication blackout |
| `opportunities` | initial power-lit and Earth-visible durations after landing, time to first sunset / Earthset |
| `metrics` | all 24 `MetricsSummary` fields: `changed`, `status_changed`, `became_known`, `became_uncertain`, `delta` (only when both KNOWN) |
| `margins` | every configured margin under both policies |
| `score` | both statuses, exact scores or bounds, delta (only when both exact) |
| `risk` | both overall levels and every indicator whose level differs or that is raised under one policy only |
| `coverage` | `CoverageAdequacy`, Sun/Earth coverage, uncovered time and sample counts per policy, data-limited and unsupported constraints, notes |
| `statements`, `limitations` | plain-language lines; the limitations in §7 (plus a `[SYNTHETIC DATA]` line for synthetic inputs) |

The report is a frozen pydantic contract model: JSON round-trip safe, deterministic, and validated (e.g. a
verdict that contradicts the two eligibilities is rejected).

## 5. Verdict and coverage rules

`SensitivityVerdict`, first match wins:

1. **`inconclusive`**: eligibility is UNKNOWN under either policy *because a constraint lacks data*
   (`incomplete_data` / `no_data`). UNKNOWN is not a verdict, so PASS vs UNKNOWN is not called a change.
2. **`changed`**: eligibility differs. *"Verdict changes depending on how the hourly measurements are interpreted."*
3. **`constraints_changed`**: eligibility equal, at least one configured constraint's status differs (for example
   FAIL under both, for different reasons).
4. **`unchanged`**: eligibility and every configured constraint status equal.
   *"Verdict unchanged under the two tested sampling methods."*

`CoverageAdequacy` is reported separately so that missing data is never mistaken for a sampling difference:
`complete` (no unknown Sun or Earth time under either policy), `decisive` (some unknown time, but every evaluable
configured check is decided under both), `insufficient` (a check lacks data under a policy, or the Sun or Earth state
is unknown for the entire mission under a policy). An *unsupported* requirement (Sun/Earth clearance) is UNKNOWN under both policies regardless
of data; it is listed but is not a coverage problem.

The two policies can cover slightly different time: SH lets the last sample before a gap or the series end hold
one nominal interval, NN half an interval on each side. With the real files (final sample *at* coverage end)
both cover the full two years. When coverage does differ, a note says so, and an UNKNOWN it causes is reported
as `inconclusive`, never as `changed`.

## 6. Supported conclusions

- Whether the eligibility verdict, and each configured constraint, is **robust to the choice between the two
  supported sampling interpretations** of the same samples.
- Which outage, opportunity, margin, score and risk values move, by how much (in hours, percentage points or
  score points), and whether a metric is exact under one policy but only bounded under the other.
- Whether missing coverage, rather than interpretation, prevents a decision.

## 7. What cannot be concluded

- **Not statistical uncertainty.** No probability, confidence interval or error bar is produced or implied.
- **Not independent validation.** Both results read the same samples with the same model; agreement between them
  is *not* evidence that a site is safe or that the verdict is correct.
- **Events between samples.** Both policies miss Sun or Earth events that begin and end between two samples
  (shorter than one hour on the real files).
- **No automatic downgrade.** A `changed` verdict does not turn the canonical PASS into UNKNOWN; consumers decide
  how to present it. The canonical engine, its default policy, constraints, risk thresholds and score weights are
  untouched.
- **No NASA validation** of the sensitivity result; it reflects the engine's illumination and line-of-sight model
  only (no power, battery, thermal, radio-link or terrain-hazard modelling).

## 8. Known limits of the hourly data (what the analytical tests establish)

All synthetic expectations are derived by hand from the support rules (test module docstring):

| Situation | Effect | Test |
|---|---|---|
| Interior outage, regular spacing | identical duration (both ends shift ½ h) | `test_policies_agree_on_interior_outage_and_verdict` |
| Outage clipped by landing at a fractional hour | SH 3.5 h vs NN 3.0 h; limit 3.0 h passes NN only (inclusive) | `test_threshold_near_measurement_...` |
| Outage clipped by mission end | SH 2.75 h vs NN 3.25 h blackout | `test_outage_clipped_at_mission_end_...` |
| Missing sample (spacing 2 h ≤ max gap) | SH holds 2 h, NN 1.5 h | `test_missing_sample_...` |
| Irregular spacing | interior outages differ too (1 h vs 1.5 h) | `test_irregular_sampling_...` |
| Coverage gap (> max gap) | same bounds `[2 h, 6 h]`, shifted in time; decisive at an 8 h limit, inconclusive at 4 h | `test_coverage_gap_is_separated_...` |
| Unknown sample state | bounded under both; inconclusive | `test_unknown_sample_state_...` |
| Landing between samples | different sample represents landing: initial sunlight 0 h vs 3.9 h | `test_landing_between_samples_...` |
| Fractional start and duration (2.25 h, 7.4 h) | initial 0.75 h vs 0.25 h; total sunlight equal | `test_fractional_start_and_duration` |
| 18-minute mission | 100 % vs 0 % sunlight | `test_short_mission_...` |
| Mission ending at the dataset end | NN uses the final sample for the last ½ h (100 % vs 87.5 %) | `test_mission_ending_at_dataset_end` |
| Mission past the dataset end | bounded, never extrapolated | `test_mission_extending_past_dataset_end_...` |
| Coverage differs between policies | PASS vs UNKNOWN → `inconclusive`, `became_uncertain` | `test_policy_dependent_coverage_...` |
| No data at all | `inconclusive`, `insufficient`, all `no_data` | `test_mission_without_any_data_...` |

On hourly data with whole-hour landings, every duration differs by at most 1 h between the policies (each
transition moves by ≤ ½ h; tested on the real sweep), consistent with §5b.

## 9. Real lunar site results (generator 1.2 files, committed 2026-11-14)

Lander as in §5c/§5e: panel threshold 0.25, ≤ 50 h power-dark, ≤ 96 h blackout, ≥ 40 % Earth visibility,
≥ 24 h initial power-lit, ≥ 12 h initial Earth visibility, mean disk fraction ≥ 0.5, direct sunlight ≥ 50 %.
Every whole-hour landing from 2027-01-01T00Z to 2028-12-18T00Z (17,209 per site), 14-day missions, Phase 3
eligibility under both policies (exploration run; the tests rediscover the change cases from raw columns):

| Site | PASS→PASS | FAIL→FAIL | PASS→FAIL | FAIL→PASS | Landings with ≥ 1 constraint status change | Cause of the eligibility changes |
|---|---|---|---|---|---|---|
| Connecting Ridge | 158 | 17,046 | **5** | 0 | 178 | darkness 50 h → 50.5 h (end-clipped) |
| Peak Near Shackleton | 319 | 16,886 | **4** | 0 | 140 | blackout 96 h → 96.5 h (end-clipped) |
| Malapert Massif | 8,272 | 8,913 | **24** | 0 | 69 | darkness 50 → 50.5 h (16); initial power-lit 24 → 23.5 h (8) |
| Shackleton Floor | 0 | 17,209 | 0 | 0 | 0 | permanently shadowed: no transitions |
| *Mons Mouton* | 35 | 17,169 | **5** | 0 | 164 | darkness 50 h → 50.5 h (end-clipped) |
| *Haworth Rim* | 0 | 17,209 | 0 | 0 | 112 | – (FAIL under both; constraint-only changes) |
| *De Gerlache Rim* | 0 | 17,209 | 0 | 0 | 92 | – |
| *Nobile Rim 1* | 0 | 17,209 | 0 | 0 | 64 | – |
| *Faustini Rim A* | 0 | 17,209 | 0 | 0 | 79 | – |

Italic rows are additional curated sites (same files, same lander). Across all nine sites: 38 eligibility changes
in 154,881 landings (0.025 %), every one PASS→FAIL by exactly the mechanisms below.

**Genuine real-data verdict changes exist:** 33 of 68,836 landings at the four original sites (0.05 %), all
PASS under sample-and-hold and FAIL under nearest-sample. None is UNKNOWN (full coverage). Every one is a
measurement sitting **exactly at an inclusive whole-hour threshold** under sample-and-hold:

- an outage clipped by the mission **end** that is exactly at the limit (50 h darkness, 96 h blackout) under SH;
  under NN the outage starts at the midpoint before its first sample and the outage sample at the mission end
  represents the final half hour, so it measures limit + 0.5 h;
- an **initial** power-lit run of exactly 24 h under SH; under NN the landing sample represents only the first half
  hour and the first dark sample takes over half an hour early, giving 23.5 h.

Why only PASS→FAIL here: with whole-hour landings, SH durations are whole hours and NN durations differ by ±½ h at
clipped edges. At whole-hour inclusive thresholds a SH value at the limit can become limit ± ½ h under NN, but a
SH value one hour past the limit stays past it. With fractional thresholds or landing times, changes go both
ways (synthetic tests show FAIL→PASS). The direction is an artefact of the grid, not a bias of either policy.

Constraint-only changes (eligibility FAIL under both) also involve the percentage requirements (sunlight, Earth
visibility, mean disk fraction), which move by up to 1 h / mission duration (≤ 0.3 pp for 14 days).

### Representative measured examples (full reports)

| Mission (14 d unless noted) | Verdict | Key differences (SH vs NN) |
|---|---|---|
| Malapert, 2027-07-20T00Z | unchanged, PASS | power-dark 36 vs 36.5 h; initial power-lit 281 vs 280.5 h; score 78.044 vs 77.757 |
| Malapert, 2027-07-20T14Z | **changed**, PASS→FAIL | `max_continuous_darkness`: 50 h (PASS) vs 50.5 h (FAIL); score 70.097 vs 70.061 |
| Malapert, 2027-01-09T11Z | **changed**, PASS→FAIL | `min_initial_sunlight`: 24 h (PASS) vs 23.5 h (FAIL); score 74.406 both (no initial-sunlight score component) |
| Connecting Ridge, 2027-12-04T15Z | **changed**, PASS→FAIL | darkness 50 vs 50.5 h; blackout 54 vs 54.5 h |
| Peak Near Shackleton, 2027-10-13T02Z | **changed**, PASS→FAIL | `max_communication_blackout`: 96 h vs 96.5 h |
| Peak Near Shackleton, 2027-04-01T00Z (117-day night) | unchanged, FAIL | power-dark 336 h both; blackout 42 vs 41.5 h |
| Connecting Ridge, 2027-03-01T00Z | unchanged, FAIL | power-dark 63 vs 62.5 h; blackout 136 vs 135.5 h |
| Shackleton Floor, 2027-06-01, 30 d | unchanged, FAIL | identical states; only the time-mean Sun elevation moves (< 0.01°) |
| Malapert, 2028-12-25 → 2029-01-08 | **inconclusive** | 168 h past the dataset end, uncovered under both; darkness and blackout UNKNOWN for lack of data under both; not scored |
| Haworth Rim, 2027-10-03T00Z | unchanged, FAIL | blackout 193 vs 192.5 h; initial power-lit 15 vs 14.5 h |
| De Gerlache Rim, 2028-01-20T00Z | unchanged, FAIL | blackout 240 vs 239.5 h |

Overall screening risk was the same under both policies in every example above.

These dates are a snapshot of the committed files and change whenever Member 1 regenerates them. The tests do not
pin them: `test_discovered_real_data_verdict_changes` finds every SH-at-threshold landing from the raw columns
(initial 24 h runs; end-clipped 50 h darkness and 96 h blackout), checks both policies' durations against an
independent half-hour re-derivation, checks each constraint status against that derivation, and requires at
least one genuine PASS→FAIL eligibility change per mechanism.

### Interpretation for consumers

A `changed` result on real data means the mission's verdict rests on a measurement within half an hour of a
threshold, which is below the time resolution of hourly samples. It is a reason to treat the verdict as
**marginal**, to look at the margin (which Phase 4 already classifies as NARROW below one sample spacing), or to
request finer sampling. It is not a probability that the mission fails.

## 10. Integration requirements for main

**No shared-module change is required.** All work composes public, tested functions; `evaluate_scenario`, the
default policy and every downstream rule are unchanged (tested). Files added (only these):

- `backend/app/viability/sampling_sensitivity.py`
- `backend/tests/viability/test_sampling_sensitivity_part2.py`
- `backend/tests/viability/test_real_sites_sampling_part2.py`
- `docs/member2-part2-sampling.md`

Recommended at the final integration session (shared files outside this worktree's ownership):

1. *Optional, smallest engine change:* add a keyword-only `policy: SamplingPolicy | None = None` to
   `engine.evaluate_scenario` and pass it to `analyze_scenario`. `None` keeps today's behaviour exactly. Then
   `evaluate_scenario_under_policy` can delegate to it instead of mirroring the six-stage wiring. Until then the
   byte-identity test guards against drift.
2. *Optional exports:* re-export `sampling_sensitivity_report`, `prepare_policy_series`,
   `SamplingSensitivityReport`, `SensitivityVerdict` and `CoverageAdequacy` from `app/viability/__init__.py`.
3. *Docs:* link this file from `viability-engine.md` §5b ("Sampling semantics") and §10 item 7.
4. No API route or frontend change is part of this work. If exposed, show the canonical verdict first and the
   sensitivity verdict as a secondary "robustness to sampling" note, with the limitations of §7.

No file overlaps the parallel Part 2 decision-evidence worktree (`ranking_evidence.py` and its tests/docs).
