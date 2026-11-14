# Member 2 Part 2A: consumer handoff (viability results, ranking evidence)

For Members 3 (UI), 4 (comparison), 5 (Rescue) and 6 (validation). This page covers how to call the
viability engine, how to read its results correctly, and how to show *why* one scenario ranks above
another without overstating the evidence. The full contract is in [viability-engine.md](viability-engine.md)
(§5, §5e–§5g); this page does not change it.

Part 2A adds no shared-schema change. New code is in `backend/app/viability/ranking_evidence.py` and
`backend/app/viability/consumer_examples.py`, plus a corrected explanation and two read-only helpers in
`ranking.py`.

## 1. Calling the engine

### Canonical engine (full result)

```python
from app.viability import evaluate_scenario, MissionScenario
from app.viability.adapters import load_site_file

series = load_site_file("data/sites/malapert-massif.json")      # Member 1's precomputed file
assessment = evaluate_scenario(mission, series)                # -> ViabilityAssessment (validated, frozen)
assessment.model_dump(mode="json")                             # JSON for an API / frontend
```

`evaluate_scenario` is pure and deterministic. A mission that runs past the data is not an error: the
uncovered time is UNKNOWN and is never extrapolated.

### Rescue compatibility adapter (legacy `ViabilityResult` + full assessment)

```python
from app.viability.compat.rescue import evaluate_timeline, evaluate_timeline_detailed, make_evaluate_fn

result = evaluate_timeline(scenario, timeline)                       # drop-in: shared ViabilityResult
result, assessment = evaluate_timeline_detailed(scenario, timeline)  # same call + full canonical assessment
evaluator = Evaluator(evaluate=make_evaluate_fn())                   # plug into Rescue's Evaluator
```

`ViabilityResult` (in `app/models.py`) has no fields for score bounds, data basis, risk or explanations.
**Use `evaluate_timeline_detailed` whenever you display any of those.** The second element is the same
`ViabilityAssessment` that `evaluate_scenario` returns.

### Ranking and evidence

```python
from app.viability import rank_assessments, partition_comparable, ranking_explanations
from app.viability import compare_scenarios, explain_adjacent       # re-exported since the Part 2 integration

for group in partition_comparable(assessments):     # never mix incompatible scenarios
    ranking = rank_assessments(group)              # RankingResult (PASS ranked 1..n, then UNKNOWN, then FAIL)
    text = ranking_explanations(group, ranking)    # one sentence per entry
    why = explain_adjacent(group, ranking)         # PairwiseEvidence for rank 1 vs 2, 2 vs 3, ...

ev = compare_scenarios(selected, competitor)       # any two scenarios, comparable or not
```

Since the Part 2 final integration, `compare_scenarios`, `explain_adjacent`, `PairwiseEvidence`, `RankingCriterion`
and `EVIDENCE_METHOD_VERSION` are re-exported from `app.viability` (the submodule import keeps working).

## 2. Units: canonical vs Rescue

| Quantity | Canonical (`ViabilityAssessment`) | Rescue (`ViabilityResult`, `MissionRequirements`) | Conversion |
|---|---|---|---|
| Durations | seconds, fields end in `_s` / metric `unit = "seconds"` | hours (`*_hours`, violation `unit = "h"`) | h = s / 3600 |
| Shares of time | percent 0–100 (`*_percent`) | fraction 0–1 (`*_fraction`) | fraction = percent / 100 |
| Mean solar-disk fraction | fraction 0–1 (`mean_solar_disk_fraction`) | fraction 0–1 (`sunlight_fraction`) | none |
| Score | 0–100 desirability index | 0–100 or `null` | none (a bounded score is `null` in Rescue) |
| Angles | degrees | degrees | none |

Rescue requirement → canonical field (`compat.rescue.requirements_to_canonical`):
`battery_hours` → `spacecraft.max_continuous_darkness_s`; `max_comms_gap_hours` →
`spacecraft.max_communication_blackout_s`; `panel_threshold` → `spacecraft.solar_power_min_disk_fraction`;
`min_sunlight_fraction` → `requirements.min_mean_solar_disk_fraction`; `min_earth_visibility_fraction` →
`requirements.min_earth_visibility_percent` (× 100); `min_initial_sun_hours` / `min_initial_comms_hours` →
`requirements.min_initial_sunlight_s` / `min_initial_earth_visibility_s` (× 3600).

Rescue's single floats for an unknown or bounded metric are the **unfavourable** bound (never optimistic).
The canonical metric keeps `status` (`known` / `bounded` / `unavailable` / `not_applicable`) and both bounds.

## 3. PASS, FAIL and UNKNOWN: display requirements

Show eligibility first, always.

| Eligibility | Meaning | Rank | Score | UI must |
|---|---|---|---|---|
| `pass` | every hard constraint is proven satisfied | 1..n within its comparable group | exact, bounded or none | show rank, score (see §4), risk separately |
| `fail` | at least one hard constraint is proven violated | none | descriptive only | list the failed constraints; never rank it among viable sites, whatever its score |
| `unknown` | no failure is proven, but at least one constraint cannot be decided from the data | none | always `null` (`eligibility_unknown`) | say "cannot be decided: missing data" and list the undetermined constraints; never show it as a failure or as passing |

Rescue: `passes` is `True` only for `pass`. **UNKNOWN is not FAIL.** Read `eligibility` (or
`ViabilityResult.verdict`), not `passes`. UNKNOWN violations carry `is_unknown = True` and a message starting
`UNKNOWN`.

## 4. Scores: `score = None` is not `score = 0`

`ScoreBreakdown.status` (and `RankedScenario.score_status`) says what kind of score exists:

| `score_status` | `score` | `score_bounds` | Show as |
|---|---|---|---|
| `known` | exact number | same value | "73.10" |
| `bounded` | `None` | `[lower, upper]` (rounded outward) | "between 79.04 and 80.50". Never print the lower bound alone. |
| `eligibility_unknown` | `None` | `None` | "not scored: eligibility unknown" |
| `no_scorable_components` | `None` | `None` | "not scored: no active score component" |

`score = None` means **no exact number exists**. It never means 0 and must never sort as 0. A score of 0
is a real, exact value (`status = known`). The ranking orders a bounded score by its guaranteed lower
bound. That is a **conservative ordering policy, not an estimate**: the entry keeps `score = None` and its
interval.

The score is a relative desirability index of illumination and line-of-sight geometry under the stated
weights. It is **not** a probability of mission success, a power or link budget, or a landing-safety rating,
and it never changes eligibility.

## 5. Ranking and comparability groups

`rank_assessments` ranks **one comparable group** and raises `RankingComparabilityError` otherwise. Two
assessments may share one ranking only if they have the same:

- data basis (`real_terrain_aware` / `real_geometric_only` / `synthetic`), **under every policy**;
- scoring `method_version` and exact effective weights;
- under the default `STRICT` policy, also the requirements fingerprint (`score.configuration_key`: spacecraft
  limits, panel threshold, every hard requirement, mission duration) and the evaluated duration.

`SAME_METHOD_AND_WEIGHTS` is an explicit opt-in that drops the last two. Use `partition_comparable` to split
a mixed list, then render **one table per group**.

PASS order (D8): scored before unscored, then score lower bound descending; at an equal lower bound an exact
score before a bounded one; then risk (low < moderate < high < unknown); then min(sun, earth coverage)
descending; then `scenario_id`. Risk and coverage are tie-breakers only. `ranking.ORDER_KEY_CRITERIA` names
every key position; `ranking.ranking_order_key` returns the exact key.

*Fixed in Part 2A:* `ranking_explanations` previously said "Ties are broken by risk, then coverage, then
scenario id" and omitted the exact-before-bounded step. It now lists every PASS step in the order the code
applies them. Ordering itself is unchanged (regression test:
`test_pass_explanation_names_every_tie_break_in_the_actual_key_order`).

## 6. Synthetic data

`data_basis = "synthetic"` (from `data_quality.provenance.is_synthetic`) covers test fixtures, Rescue's
synthetic placeholder timeline, simulation mode and custom sites without real data. Requirements:

- label it as simulation or demonstration on every view; keep the `[SYNTHETIC DATA]` prefix that explanations,
  score notes and evidence carry;
- never rank, sort or chart it together with real results; `rank_assessments` refuses, and evidence states no
  order (`comparable = false`).

## 7. Versions to record

Every displayed or stored result should keep: `engine_version` (now `0.6.0-phase6`), `score.method_version`
(`desirability-v1`), `explanations` method (`explanations-v1`, `explain.EXPLANATION_METHOD_VERSION`), evidence
`method_version` (`ranking-evidence-v1`), sampling sensitivity `method_version` (`1.0.0-part2b`) when shown, and through Rescue `ViabilityResult.source`
(`viability-engine/0.6.0-phase6`) and `data_source` (`precomputed:<file>` or `synthetic-placeholder`). Scores
with different method versions are never comparable.

## 8. Evidence-based explanations (`ranking_evidence`)

`compare_scenarios(selected, competitor, *, policy=None, ranking=None) -> PairwiseEvidence` answers "why does
A rank above B, and how decisive is that?" It reads the finished assessments only. It does not compute a new
score or change any policy. Fields:

| Field | Content |
|---|---|
| `comparable`, `comparability_issues` | the ranking's own rule; issues are e.g. `data basis (real_terrain_aware vs synthetic)` |
| `selected` / `competitor` | eligibility, exclusion reason, failed / unknown constraints, score state, exact score or bounds, risk and its indicator codes, min coverage, data basis, synthetic flag, dataset, versions, configuration key, rank (if a `RankingResult` was given) |
| `higher_id`, `selected_ranks_higher` | who the ranking policy places first (`null` if not comparable) |
| `deciding_criterion`, `deciding_detail` | the first ranking-key position where they differ: `eligibility`, `fail_constraint_count`, `unknown_constraint_count`, `scored_before_unscored`, `score_lower_bound`, `exact_before_bounded`, `overall_risk`, `min_coverage`, `scenario_id` |
| `score_difference` | conservative interval of selected − competitor (below) |
| `components` | per score component: effective weight, both normalized values (known or bounded), both contributions in score points, their difference interval, and which side it favours |
| `limitations`, `explanation` | caveats and one planner-facing paragraph |

**Score difference.** For A = [aL, aU] and B = [bL, bU] (exact = [s, s]), A − B ∈ [aL − bU, aU − bL]. It is
computed exactly on the stored 6-decimal values and rounded outward, so it always contains the true interval.

| `score_difference.status` | Meaning | Say |
|---|---|---|
| `selected_higher` / `competitor_higher` | the interval excludes 0 | "higher everywhere within the recorded bounds" |
| `not_established` | the interval contains 0 | "the ranges overlap; the evidence does not prove which is higher". Overlap is **not** evidence that the sites are equally good. |
| `unavailable` | a score is missing | "no difference: X is not scored". Never treat it as 0. |
| `not_comparable` | different basis / method / weights / requirements | no number at all; show the scenarios in separate groups |

**Showing it.** Render `explanation` as is, or build your own text from the fields. Keep the deciding
criterion and the difference status visible together. When the criterion is `exact_before_bounded`,
`overall_risk`, `min_coverage` or `scenario_id`, the order is a policy tie-break, not a measured
difference. A component advantage is reported only when its own interval excludes 0.

**Demonstrated on real data** (Rescue's production path, Rescue default requirements, 3-day missions at
Connecting Ridge ending at the last sample of the committed files; generator-1.2 files covering 2026-01-01 to
2031-01-01, regenerated 2026-11-14; regenerate with the command in §9):

| Scenario | Eligibility | Score | Risk | Rank |
|---|---|---|---|---|
| landing 2030-12-29T00:00Z | PASS | exact 87.219675 | low | 1 |
| landing 2030-12-29T01:00Z (last mission hour beyond the data) | PASS | bounded [86.264814, 87.219676] | moderate | 2 |

Deciding criterion `score_lower_bound` (87.219675 vs 86.264814). Difference (00:00 − 01:00) =
**[−0.000001, +0.954861]**, which contains 0, so `not_established`. No single component's advantage is
established. (Before the regeneration the same pair sat at 2028-12-29 with 80.499086 vs [79.044225, 80.499087]; the
examples now follow the files' last sample automatically.) Explanation: *"…ranks above … under the conservative scoring policy (higher guaranteed lower
bound), but their score ranges overlap … The recorded evidence does not prove [it] has a higher desirability
score."* Through Rescue the bounded scenario's `ViabilityResult.score` is `null`.

## 9. Reproducible consumer examples

`python -m app.viability.consumer_examples [OUT.json]` (from `backend/`) builds eight examples through the
real pipeline and writes canonical JSON (sorted keys; byte-identical for one checkout). Each holds the full
canonical assessment(s), Rescue's `ViabilityResult` where Rescue's path produced it, a display summary
(eligibility, score, bounds, data basis, provenance, constraints, explanations, versions) and, where
relevant, ranking, comparability groups and evidence. Values come from the committed site files and are not
pinned.

| Key | Case | Path |
|---|---|---|
| `pass_exact` | Malapert, 7 d from 2028-06-15: PASS, exact score | Rescue adapter |
| `fail_confirmed` | Connecting Ridge, 7 d from 2027-03-01: proven FAIL | Rescue adapter |
| `unknown_inadequate_data` | Connecting Ridge, 3 d from 12 h before the last sample (60 h past the data; 2030-12-31T12:00Z): UNKNOWN, not scored | engine (Rescue answers this case itself) |
| `pass_bounded` | Connecting Ridge, 3 d from 71 h before the last sample (2030-12-29T01:00Z): PASS, bounded [86.264814, 87.219676], Rescue `score = null` | Rescue adapter |
| `score_unavailable` | `pass_exact` mission with only the unsupported clearance weight: PASS, `no_scorable_components` | engine |
| `synthetic_input` | `intermittent_sunlight` fixture, labelled `[SYNTHETIC DATA]` | engine |
| `comparable_pair` | the two Connecting Ridge scenarios of §8, ranked, with evidence | Rescue adapter |
| `separate_leaderboards` | real 7 d + real 3 d + synthetic: one ranking refused, three groups, evidence states no order | both |

## 10. Known issues in teammates' components (not changed here)

**Rescue (Member 5), details in viability-engine.md §5g:**

1. `ViabilityResult.score_or_zero` (`app/models.py`) is used by `app/rescue/search.py` (`_rank_score`, the
   "+5 points better option" check), `app/rescue/compromise.py` and `app/rescue/sensitivity.py`. A PASS with a
   bounded score (`score = None`) is then ranked as 0. Fix: order by
   `evaluate_timeline_detailed(...)[1].score.score_bounds.lower` (the canonical conservative policy), or put
   unscored candidates in their own tier.
2. Simulation mode ranks real and synthetic candidates together in `rescue()`. Fix: rank them separately, or
   real first.
3. (2b) `Evaluator.evaluate_many` fetches one timeline per batch; the precomputed provider falls back to
   synthetic for the whole batch if any start is uncovered.
4. End-of-dataset coverage counts the final sample as one more hour, giving one unknown hour (bounded score,
   rarely UNKNOWN) at the latest accepted landing.

**Comparison (Member 4):**

5. `frontend/src/features/compare/analysis.ts`: `rankByViability` sorts by `passes` then `score ?? 0`, and
   the "best viability" pick uses `(score ?? 0) + (passes ? 1000 : 0)`. With the canonical engine this ranks a
   bounded PASS as 0 and puts UNKNOWN in the same tier as FAIL. Fix: sort by `verdictOf(v)` tier
   (pass, unknown, fail), keep `score = null` in a separate "not scored" position, and show "not scored"
   instead of `n/a` as a number. Demonstration results are already ranked separately (good).
6. `backend/app/compare/service.py` uses the swap point `app.rescue.viability.evaluate_timeline`, so it
   switches together with Rescue and sees only `ViabilityResult`. Bounds, data basis and explanations need
   `evaluate_timeline_detailed` or an additive shared-contract field (§10 item 21 of viability-engine.md).

**Production switch (owner: Member 5, with Member 4).** In `backend/app/rescue/viability/__init__.py`
import `evaluate_timeline` from `app.viability.compat.rescue` instead of `.placeholder` (keep `CHECKS` /
`CHECK_BY_CONSTRAINT` from the placeholder). Do it together with or after fixes 1 and 5. Rank-dependent Rescue
tests and thresholds need review because the score formula differs.

### Files each owner should review

| Owner | Files |
|---|---|
| Member 5 (Rescue) | `backend/app/rescue/viability/__init__.py` (switch), `backend/app/rescue/search.py`, `backend/app/rescue/compromise.py`, `backend/app/rescue/sensitivity.py`, `backend/app/rescue/engine.py` (`evaluate_many`, coverage), `backend/app/rescue/timeline/precomputed.py` (batch fallback), `backend/app/models.py` (`score_or_zero`; any additive `score_bounds` field needs Members 4 and 5) |
| Member 4 (Comparison) | `frontend/src/features/compare/analysis.ts` (`rankByViability`, best-viability pick, summary text), `frontend/src/features/compare/MetricsTable.tsx` and `OverviewCards.tsx` (score display), `backend/app/compare/service.py` |
| Member 3 (UI) | §3, §4, §6, §8 of this page. `frontend/src/types.ts` already types `score: number \| null` and `eligibility`. |
| Member 6 (Validation) | `backend/app/viability/ranking_evidence.py` (interval rounding, wording), `backend/tests/viability/test_ranking_evidence_part2.py` |

## 11. Integration status (Part 2 final integration, 2026-11-14)

- Done: `compare_scenarios`, `explain_adjacent`, `PairwiseEvidence`, `RankingCriterion`, `EVIDENCE_METHOD_VERSION` and
  the Part 2B entry points (`sampling_sensitivity_report`, `prepare_policy_series`, `SamplingSensitivityReport`,
  `SensitivityVerdict`, `CoverageAdequacy`, `PolicySeriesPair`, `SENSITIVITY_METHOD_VERSION`) are re-exported from
  `app.viability`. Additive only.
- Done: linked from `docs/viability-engine.md` §5h.
- `engine.evaluate_scenario` gained a keyword-only `policy=None` (default behaviour unchanged, tested); the Part 2B
  report delegates to it.
- No shared model (`app/models.py`, `frontend/src/types.ts`), no output field, no `ENGINE_VERSION` and no Rescue or
  comparison file was changed. Production activation stays with Member 5 (§10).
- Validation package and demonstration: `docs/member2-part2-validation.md`, `docs/member2-part2-demo.md`.

## 12. Instructions for Member 5 (Arush, Rescue) and Member 4 (comparison)

These are the rules for showing canonical results. They apply as soon as `app/rescue/viability/__init__.py` imports
`evaluate_timeline` from `app.viability.compat.rescue` (still the placeholder on `origin/main` at the time of the
Part 2 integration). Activating that switch is your release decision, separate from Member 2's completion.

1. **Missing scores.** `score = None` (Rescue `ViabilityResult.score`, canonical `ScoreBreakdown.score`) means *no exact
   number exists*. Never coerce it to 0 (`score_or_zero`, `score ?? 0`), never sort it as 0 and never print `0`.
   Show `score_status`: "between L and U" for `bounded`, "not scored: eligibility unknown", "not scored: no active
   score component". A real `0.0` with status `known` is a valid score.
2. **UNKNOWN eligibility.** Read `eligibility` / `ViabilityResult.verdict`, not `passes`. UNKNOWN is a third tier
   between PASS and FAIL: never show it as failed, never rank it among viable options, never score it. List its
   undecided constraints (`is_unknown = True` violations, messages start with `UNKNOWN`) and say "cannot be decided:
   missing data". Rescue's own coverage check (`source = "rescue-coverage-check"`) already does this for missions
   outside real data.
3. **Score intervals.** For `score_status = bounded` use the full interval from the canonical assessment
   (`evaluate_timeline_detailed(...)[1].score.score_bounds`); `ViabilityResult` has no interval field. Order bounded
   candidates by the guaranteed lower bound (what `rank_assessments` does) and never print the lower bound alone.
   When two candidates' intervals overlap, `compare_scenarios(...).score_difference.status` is `not_established`:
   say the order is a conservative policy, not a proven difference.
4. **Synthetic versus real.** `data_basis = "synthetic"` (Rescue `data_source = "synthetic-placeholder"`, simulation
   mode, fixtures) must be labelled on every view and kept in its own list/table/chart. Do not merge synthetic and
   real candidates into one ranking (`rank_assessments` refuses; Rescue simulation mode currently mixes them, §10
   item 2). Keep the `[SYNTHETIC DATA]` prefix of explanations.
5. **Incompatible rankings.** Different data basis, scoring method, weights, requirements or mission duration make
   scenarios incomparable. Call `partition_comparable(assessments)` and render one ranking per group; never compute a
   score difference across groups (`compare_scenarios` returns `not_comparable` with `comparability_issues`).
6. **Canonical explanations.** Display `assessment.explanations` (or `explain_assessment_details` for structured
   fields) verbatim, with `explanations-v1`. Do not paraphrase numbers or add claims; for "why is A above B" use
   `compare_scenarios(...).explanation` / `deciding_criterion`. Rescue's own explanation texts may keep describing
   its search, but not re-word viability results.
7. **Detailed assessment data.** Anything beyond pass/score/violations (bounds, data basis, coverage, risk
   indicators, margins, windows, explanations, sampling sensitivity) comes from the `ViabilityAssessment`:
   `evaluate_timeline_detailed` for Rescue and `compare/service.py`; an additive shared-contract field would need
   Members 4 and 5 to agree first (viability-engine.md §10). Record `engine_version`, `score.method_version`,
   `dataset_id` and, through Rescue, `ViabilityResult.source` / `data_source` with every stored result.
8. **Sampling sensitivity (optional display).** If shown, put the canonical verdict first and
   `sampling_sensitivity_report(...).summary` as a secondary "robustness to hourly sampling" note with its
   limitations. A `changed` verdict marks a marginal decision; it never turns a canonical PASS into UNKNOWN.
9. **Data range changed upstream.** Since commit 4ebc988 the site files cover 2026-01-01 to 2031-01-01. Eleven
   teammate tests still assert the old 2029 end and fail on `origin/main`: `tests/test_compare.py`
   (`test_out_of_range_is_unavailable_not_fabricated`, Member 4), `tests/test_rescue_coverage.py` (9 cases) and
   `tests/test_rescue_real_data.py::test_provider_coverage_and_unaligned_times` (Member 5). Member 2's own tests now
   read the bounds from the files (`tests/viability/real_data.py`); the same approach would fix these.
