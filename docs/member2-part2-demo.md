# Decision-evidence demonstration: Malapert Massif vs Connecting Ridge

A small, real example for the hackathon demo. Every number below was computed by the canonical engine
(`0.6.0-phase6`, score `desirability-v1`) on Member 1's committed site files (JPL Horizons ephemeris + LOLA terrain,
generator 1.2, 2026-01-01 → 2031-01-01). Reproduce:

```bash
cd backend
python -m app.viability.validation.demo                               # prints this example
python -m app.viability.validation.demo --out ../docs/member2-part2-demo.json
```

Snapshot: [member2-part2-demo.json](member2-part2-demo.json) (full payload, sorted keys, with the sha256 of each site
file). `tests/viability/test_part2_validation.py` rebuilds it and requires an identical result while those files are
unchanged.

## Mission

- **Candidates:** Malapert Massif (85.96° S, 2.37° W) and Connecting Ridge (89.53° S, 150.05° W), both south-polar
  Artemis candidate regions.
- **Dates:** land 2027-12-03T00:00Z, 14 days (to 2027-12-17T00:00Z).
- **Requirements (solar direct-to-Earth lander):** power-darkness ≤ 50 h (panel threshold: 25 % of the solar disk
  visible), Earth blackout ≤ 96 h, direct sunlight ≥ 50 % of the time, Earth line of sight ≥ 40 %, mean visible
  solar-disk fraction ≥ 0.5, ≥ 24 h power-lit and ≥ 12 h Earth-visible right after landing. Default score weights.

## Result

| | Malapert Massif | Connecting Ridge |
|---|---|---|
| Eligibility | **PASS** (all 7 requirements) | **PASS** (all 7 requirements) |
| Longest power-darkness (≤ 50 h) | 15 h | 43 h |
| Longest Earth blackout (≤ 96 h) | 0 h | 15 h |
| Direct sunlight (≥ 50 %) | 100 % | 88.1 % |
| Earth line of sight (≥ 40 %) | 100 % | 95.5 % |
| Mean visible solar-disk fraction (≥ 0.5) | 0.945 | 0.812 |
| Power-lit after landing (≥ 24 h) | 49 h | 272 h |
| Earth-visible after landing (≥ 12 h) | 336 h | 321 h |
| Screening risk | low | moderate (`darkness_exposure`: "Longest power-dark period is 43 h (86 % of the 50 h limit); a 11 h outage is in progress at mission end") |
| Desirability score (0–100) | **91.11** (exact) | **68.78** (exact) |
| Rank | **1** | 2 |

**Why Malapert is first:** both pass every requirement, so the ranking orders them by score (deciding criterion
`score_lower_bound`; both scores are exact).

**Is the advantage clearly established?** Yes. The score difference is +22.34 points and its interval
[+22.335294, +22.335294] excludes 0 (`selected_higher`): it holds everywhere within the recorded bounds. It is a
difference in a relative desirability index, not a probability of mission success.

**Precision.** Scores are stored to 6 decimals: 91.113497 and 68.778203, so the gap is exactly 22.335294 points (22.34 rounded). Before storage the component sums are 91.1134972 and 68.7782025 (gap 22.3352946). The evidence interval is computed exactly on the stored values and rounded outward, which is why its lower end prints as 22.335293999999998 in the JSON and a component difference of exactly 14.0 (17.5 vs 3.5 points) prints as [13.999999, 14.0]. The table below rounds to 2 decimals.

**Which measurements explain the difference** (score points, weight 0.25 each):

| Component | Measurement | Malapert | Connecting Ridge | Points to Malapert |
|---|---|---|---|---|
| Darkness margin | longest power-darkness vs the 50 h limit | 15 h | 43 h | **+14.00** |
| Blackout margin | longest Earth blackout vs the 96 h limit | 0 h | 15 h | +3.91 |
| Sunlight | mean visible solar-disk fraction | 0.945 | 0.812 | +3.31 |
| Earth visibility | share of time Earth is in line of sight | 100 % | 95.5 % | +1.12 |

Every component favours Malapert and each advantage is established. Most of the gap (14 of 22.3 points) comes from
darkness headroom: Connecting Ridge has a 43 h power-dark period inside this mission, close to the 50 h battery limit.

**Sampling sensitivity** (sample-and-hold, the engine default, vs nearest-sample on the same hourly data): verdict
**unchanged** at both sites, PASS under both methods with the same status for every requirement. Connecting Ridge's
longest blackout moves 15 h → 15.5 h and its score 68.78 → 68.57; Malapert's numbers do not move. The decision does
not rest on a sub-hour threshold crossing.

## What to say (and not say) in the demo

- The engine says both sites are viable for this mission and Malapert has more margin, mainly because its longest
  dark period is 15 h instead of 43 h.
- It does **not** say Malapert is safe, will produce enough power, or is "22 % better". The score is a relative
  index under the stated weights.
- Limitations (from the result): solar illumination is not electrical power (array orientation, efficiency, dust,
  temperature not modelled); Earth line of sight is not a radio link budget; no landing-safety assessment (slopes,
  hazards); terrain results inherit the elevation model's resolution; hourly samples can miss events shorter than an
  hour; the sampling comparison is not a statistical uncertainty and the two methods cannot validate each other.
- Other dates give other answers: on 2027-03-01 Connecting Ridge fails four requirements (see the validation cases).
