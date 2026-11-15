# Multi-Scenario Comparison (Member 4)

Compare 2–4 landing scenarios (sites, dates, durations, spacecraft settings) side by side, on
synchronized timelines, using the data engine's real JPL Horizons + LOLA timelines.

Open it from the **Scenario comparison** tab in the app header.

## Where things live

| Part | Path |
|---|---|
| API endpoint | `backend/app/compare/` (`POST /api/compare`, registered in `app/main.py`) |
| Backend tests | `backend/tests/test_compare.py` |
| Frontend feature | `frontend/src/features/compare/` (entry: `ComparisonDashboard`) |
| Comparison logic (pure) | `frontend/src/features/compare/analysis.ts` |
| Scenario objects / adapters | `frontend/src/features/compare/scenario.ts` |
| State + integration API | `frontend/src/features/compare/useCompareStore.ts` |
| Frontend tests | `frontend/src/features/compare/compare.test.tsx` (fixture = real `/api/compare` response) |

## What it reuses (and does not duplicate)

- **Timelines** – the data engine's site records (`app/store.py`, same data as
  `/api/sites/{id}/timeline`). No Sun/Earth or terrain geometry is computed here.
- **Terrain horizons** – `GET /api/sites/{id}/horizon` (frontend, cached per site).
- **Viability** – `app/viability/compat/rescue.evaluate_timeline_detailed` (Member 2's canonical engine,
  the same adapter Rescue uses): the shared `ViabilityResult` plus the full canonical assessment.
- **Ranking** – `app/viability/ranking` via `app/compare/ranking.py`: `partition_comparable` splits the
  selected scenarios into comparable groups, `rank_assessments` ranks each group, `ranking_explanations`
  gives each scenario's reason. The comparison never ranks, sorts or re-scores on its own.
- **PSR distances** – Mission Rescue's approximate PSR catalog (`app/rescue/catalog.py`), only for
  the clearly labelled *demonstration* science criterion of the trade-off panel.

What this module adds: sunlight / darkness / Earth-visibility / blackout windows, elevation
statistics, events (sunrise, sunset, Earthrise, Earthset), an idealised panel incidence factor,
baseline deltas, the user-weighted trade-off, and the written summary.

## `POST /api/compare`

```jsonc
{
  "scenarios": [
    { "key": "client-id", "scenario": Scenario,             // team Scenario (src/types.ts)
      "spacecraft": { "panel_mode": "vertical_sun_tracking", // | vertical_fixed | horizontal | two_axis
                      "panel_azimuth_deg": 0, "panel_rated_power_w": 400,
                      "average_load_w": 150, "battery_capacity_wh": 7500 } }
  ],                                   // 1–6 scenarios
  "allow_demo_data": false,            // true = synthetic placeholder where no real data exists
  "max_points": 1500                   // timeline decimation for charts
}
```

Each result: `status` (`ok` | `unavailable`), `data_kind` (`real` | `demonstration` | `unavailable`),
`data_source`, `viability` (team `ViabilityResult`), `solar`, `earth`, `power`, the four window
lists, `events`, `site_context`, `science_context` and a columnar `timeline` (hours after landing).
Full schema: `backend/app/compare/schemas.py` or http://localhost:8000/docs.

Statistics are computed on the full hourly data even when the returned timeline is decimated.

### Canonical ranking (`ranking`, `ranking_groups`, `ranking_method`)

The selected scenarios are ranked **together** in one request (a ranking belongs to a set). Per result:

```jsonc
"ranking": {                       // null when the scenario has no canonical assessment (e.g. no data)
  "eligibility": "pass",           // pass | fail | unknown   (UNKNOWN = cannot be decided, never FAIL)
  "rank": 1,                       // PASS only; null for FAIL and UNKNOWN
  "group": "G1", "group_size": 3, "ranked_in_group": 2,
  "explanation": "Rank 1: all hard constraints pass; ...",   // the engine's own text
  "score_status": "known",         // known | bounded | eligibility_unknown | no_scorable_components
  "score": 97.4,                   // exact score only; null = no exact number (never 0)
  "score_lower": 97.4, "score_upper": 97.4,   // bounds for a bounded score
  "overall_risk": "moderate", "data_basis": "real_terrain_aware"
}
```

`ranking_groups[]`: `{ id, primary, keys (canonical order: PASS, UNKNOWN, FAIL), ranked_keys, data_basis,
policy, method_version, separate_reason }`. Scenarios with a different data basis, scoring method, requirements
or mission duration are in separate groups (STRICT policy) and are **never ranked against each other**; the
primary group is the largest. A PASS scenario in a non-primary group shows "rank n in separate group Gx",
never a place in the main ranking.

### Pairwise evidence (`pairwise`) and the decision panel

`pairwise[]` restates the engine's `ranking_evidence.compare_scenarios` for every pair of assessed scenarios:
who ranks first (`higher`), the `deciding_criterion` (eligibility, score lower bound, or a policy tie-break such as
overall risk), the conservative score difference (`selected_higher` / `not_established` / `unavailable` /
`not_comparable`), per-component advantages and the engine's own explanation (`selected_id` / `competitor_id` are
the engine ids used in its texts; the UI shows scenario letters instead).

The decision panel (`frontend/src/features/compare/decision.ts`) keeps four kinds of statement apart:
requirement verdicts, canonical ranking evidence, measured trade-offs (individual engine metrics, meaningful
differences only) and uncertainty. A scenario is only called preferred when it passes every requirement and holds
rank 1 of at least two passing scenarios in its group; with one pass it is "the only option that meets the
requirements"; with no pass and any UNKNOWN there is no conclusion; with all FAIL nothing is recommended.

## Data honesty rules

- Scenarios without real data (dates outside 2027–2028, unknown sites) come back **unavailable**.
  The browser never makes up numbers. Demonstration data must be switched on explicitly, is
  badged everywhere, and is ranked/charted separately from real data.
- "Earth in view" is geometric line of sight only, not link availability.
- The incidence factor `visible_fraction × max(0, cos θ)` is an idealised upper bound, not
  electrical output; the "idealised energy ÷ load" ratio uses it.
- The trade-off ranking is the user's preference weighting, not a mission assessment, and always
  shows the measured values behind each score.

## Integration points

**Mission Rescue → comparison** (Member 5 / Arush). The scenario workspace shows an *Import from
Mission Rescue* bar whenever rescue has results (it reads `useRescueStore`). From code:

```ts
import { sendToComparison } from '../compare'
sendToComparison([res.changed.scenario, ...res.alternatives.slice(0, 3).map((a) => a.scenario)],
                 { origin: 'rescue', names: ['Delayed plan', 'Alt 1', 'Alt 2', 'Alt 3'] })
```
The first scenario becomes the baseline, so every metric shows ▲/▼ against it.

**3D view (Andrew).** Selecting a time on the comparison timeline writes `siteId` and `timeUtc`
into the shared `useAppStore` for the followed scenario; "View in 3D ↗" switches to the planner.

**Mission configuration (Member 3).** Scenarios are team `Scenario`s plus a `SpacecraftConfig`;
`fromTeamScenario` / `toTeamScenario` convert between them.

## Known limitations

- Real data covers the curated sites for 2026-01-01 → 2031-01-01 (hourly). Custom sites created
  through `/api/sites/custom` work; `custom:<lat>,<lon>` ids from rescue have no real data.
- Workspace persists in `sessionStorage` (current browser session only).
- The viability score shown is whatever `app/rescue/viability` points at (currently `placeholder-v1`).
