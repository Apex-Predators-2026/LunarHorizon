# Member 2 Part 2: validation package (Work Package E)

Package: `backend/app/viability/validation/` (`suite.py`, `demo.py`) · version `member2-part2-validation-v1`
Tests: `backend/tests/viability/test_part2_validation.py` · demonstration: [member2-part2-demo.md](member2-part2-demo.md)

```bash
cd backend
python -m app.viability.validation                  # full run: summary, exit code 1 if any check fails
python -m app.viability.validation --quick --out report.json   # smaller timing workload, JSON report
```

Everything is computed through the canonical engine (`evaluate_scenario`, `rank_assessments`, `compare_scenarios`,
`sampling_sensitivity_report`) on Member 1's committed site files. Nothing is pinned or typed in. Each check is a
named `Check(name, passed, detail)`, so a failure says what was found.

## 1. What it covers

| Part | Content |
|---|---|
| Smoke (all 24 committed files) | Inputs: real (not synthetic), terrain-aware, hourly, samples span exactly the stated coverage, no gaps, same coverage as the reference file, site id. Evaluation of the standard lander (§2) for 14 days at the first, middle and last possible landing: engine and scoring versions, eligibility re-derived from the constraints, rank-eligible iff PASS, UNKNOWN never scored, exact score iff status KNOWN, explanations present and not labelled synthetic, real data basis, no unknown time, no missing-data UNKNOWN, JSON round trip. |
| Deep cases | 11 cases (§3), all real data except the one that must be synthetic. |
| Invariants | 5 properties checked on 22 real missions (§4). |
| Timing | data preparation separately from repeated evaluations, with workload and machine (§5). |
| Records | engine, scoring, ranking, explanation, evidence and sensitivity versions; sampling policies; per dataset: file, sha256, `dataset_id`, generator, generation time, ephemeris and terrain sources, coverage, sample count. |

## 2. Standard lander

Same as `viability-engine.md` §5c/§5e and the Part 2B report: solar, direct-to-Earth, panel threshold 0.25,
≤ 50 h continuous power-darkness, ≤ 96 h Earth blackout, ≥ 40 % Earth visibility, ≥ 24 h initial power-lit,
≥ 12 h initial Earth visibility, mean solar-disk fraction ≥ 0.5, direct sunlight ≥ 50 %; default preferences.

## 3. Deep cases (measured 2026-11-14, generator-1.2 files covering 2026-01-01 → 2031-01-01)

| Case | Mission | Result |
|---|---|---|
| PASS | Malapert Massif, 2027-07-20, 14 d | PASS, every constraint passes, exact score 78.044229, risk low |
| Confirmed FAIL | Connecting Ridge, 2027-03-01, 14 d | FAIL: darkness, blackout, initial sunlight, initial Earth visibility, each with the measurement past its threshold; score 33.641069 descriptive only, not rank-eligible |
| PASS with high screening risk | Peak Near Shackleton, 2027-10-13, 14 d | PASS, score 64.093922, overall risk HIGH (`communication_exposure`); still rank-eligible: risk never changes eligibility |
| UNKNOWN from missing data | Connecting Ridge, 2030-12-25 → 2031-01-08 (7 d past the last sample) | UNKNOWN: darkness, blackout, sunlight %, mean disk fraction undecided (incomplete data); no FAIL; not scored; 168 h uncovered |
| Bounded score | Connecting Ridge, 3 d from 2030-12-29T01:00Z (last hour past the data) | PASS, score BOUNDED [86.264814, 87.219676], no point value |
| Overlapping intervals / uncertain ranking | the bounded mission vs the same mission one hour earlier (exact 87.219675) | exact one ranked first by guaranteed lower bound; difference [−0.000001, +0.954861] contains 0: `not_established`; explanation says the ranges overlap |
| Exact ranking | Malapert Massif vs Connecting Ridge, 2027-12-03, 14 d | both PASS with exact scores 91.113497 vs 68.778203; difference +22.335294: `selected_higher` |
| Incompatible configurations | Malapert 14 d, 7 d, and 14 d with sunlight-only weights | one ranking refused (`RankingComparabilityError`), three groups, evidence `not_comparable`; the reweighted scenario has identical eligibility and constraints |
| Synthetic kept separate (SYNTHETIC fixture `intermittent_sunlight`) | fixture vs a real PASS | synthetic basis, every explanation `[SYNTHETIC DATA]`, refused even under `same_method_and_weights`, separate groups, no order stated |
| Dataset boundaries | Connecting Ridge | ending at the last sample: 0 h uncovered; one hour past: exactly 1 h uncovered, never an exact score; starting 2 d before the first sample: 48 h uncovered; entirely after: UNKNOWN, all `no_data` |
| Sampling agreement / disagreement | Malapert 2027-07-20T00Z and T14Z, 14 d | T00Z `unchanged` (PASS/PASS); T14Z `changed` PASS → FAIL on `max_continuous_darkness` (50 h vs 50.5 h); the baseline equals the canonical result |

## 4. Invariants (all hold)

| Invariant | How it is tested | Measured |
|---|---|---|
| Stricter operational limits never improve the corresponding constraint | 8 tightenings (darkness and blackout limits × 0.6, panel threshold 0.25 → 0.6, Earth/sunlight +20 pp, mean fraction +0.2, initial durations × 3 / × 4) on 22 missions; order FAIL < UNKNOWN < PASS, also for eligibility | 176 evaluations, no improvement |
| Missing data never creates fake certainty | each mission re-evaluated on a re-validated sub-series with 24 h of samples removed mid-mission: every constraint decided with the gap must equal the full-data status; every bounded metric and score interval must contain the full-data value; no exact score with unknown Sun time | 22 missions, 149 decided constraints and 464 bounded metrics compared, all consistent |
| Preference weights never alter eligibility | 4 seeded random weight sets per mission | 88 evaluations: eligibility, constraints, metrics, margins and risk identical |
| Explanations never change the calculations | the same stages run without the explanation step; explaining an assessment twice; reproducibility | 22 missions identical |
| Ranking independent of input order | 6 comparable assessments (3 PASS incl. high risk, 1 UNKNOWN, 2 FAIL) in all 720 orders; ranking and ranking explanations | identical |

## 5. Timing (measured, full run)

Machine: Windows 11 (10.0.26200), Intel64 Family 6 Model 170 (22 logical CPUs), CPython 3.14.10, numpy 2.5.4,
pydantic 2.14.3. Single process; times vary with machine load.

| Step | Workload | Result |
|---|---|---|
| Load (`adapters.load_site_file`) | 24 five-year files, 43,825 samples each: JSON parse + contract validation of every sample | 41.2 s total (median 1.49 s per file) |
| Prepare (`prepare_series`, sample-and-hold) | once per dataset | 2.86 s total (median 0.12 s per file) |
| Prepare both policies (`prepare_policy_series`) | Malapert, once | 0.30 s |
| `evaluate_scenario` | 200 × 14-day missions at Malapert on the prepared series (full pipeline incl. explanations) | median 3.66 ms, p95 6.58 ms |
| `sampling_sensitivity_report` | 40 × 14-day missions on the prepared pair | median 6.84 ms, p95 11.7 ms |
| `rank_assessments` | 50 × 24 assessments | median 0.66 ms |

Data preparation dominates and happens once per dataset; repeated evaluations take milliseconds. **No cache was
added.** Loading grew from about 0.5 s to 1.5 s per file when the files went from 2 to 5 years; a consumer that
reloads a file per request should keep the loaded series (Rescue's provider reads the JSON itself and is not
affected by `load_site_file`).

## 6. Limitations

- Validation is internal consistency and soundness against the engine's own model and Member 1's data. It is not
  independent scientific validation and not NASA validation; Member 6 covers the data engine's science
  (`docs/validation-engine.md`).
- Deep-case dates come from a sweep of the committed files. If Member 1 regenerates them, a case may no longer show
  its condition; the corresponding check then fails with what was found instead (end-of-data cases follow the
  files' last sample automatically).
- Invariants are checked on a deterministic sample of missions, not proved for all inputs.
- Timing is one machine, one run.
