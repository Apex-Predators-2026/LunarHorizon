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

## Requirement evidence on the timeline

`assessment.constraints[].evidence_windows` carries the windows the engine cites for each verdict (hours after
landing and UTC; `clipped_at_start` = already in progress at landing). The synchronized timeline outlines the windows
behind a **failed** requirement in red and behind an **undecided** one dashed, on the Sun or Earth lane, with a
"Go to first violation" button. The measured longest gaps stay as neutral dashed outlines.

## Mission Rescue -> comparison

"Compare original, changed plan and top alternatives" (in the scenario workspace once Rescue has results) imports
the original plan (when the change produced a different plan), the changed plan (set as baseline) and Rescue's
top alternatives, up to four. Every plan is re-assessed by the canonical engine, and the **Mission Rescue: from
problem to decision** panel shows: original plan -> what changed -> the problem (failed / undecided requirements)
-> each alternative's verified outcome (confirmed fix, passes but not comparable, cannot be decided, still fails),
what it fixes, Rescue's own note, any disagreement with Rescue's verdict -> the decision. Rescue's rank and the
canonical rank can differ (Rescue's ordering also weighs date shift and distance); the decision uses the canonical
ranking. Logic: `frontend/src/features/compare/rescueFlow.ts`.

## Export (CSV / JSON)

"Export JSON" / "Export CSV" in the comparison summary save the comparison exactly as displayed (enabled once the
selection has been ranked). Built in the browser from the same data (`frontend/src/features/compare/export.ts`,
format `comparison-export-v1`, export revision 2 (`export_revision`)); nothing is recomputed and nothing is sent anywhere.

- Mission window (revision 2, additive): the window the backend **evaluated** on its hourly grid (`evaluated_landing_utc`,
  `evaluated_duration_days` from each result, see `backend/app/timegrid.py`), with the user's request kept
  separately. JSON `mission_time`: `evaluation_status` (`evaluated` | `pending` | `error` | `not_requested` |
  `not_assessed` | `not_reported` | `stale`), `evaluated_landing_utc`, `evaluated_duration_days`,
  `evaluated_duration_hours`, `evaluated_end_utc`, `requested_landing_utc`, `requested_duration_days`,
  `requested_duration_hours`, `requested_end_utc`, `time_adjusted`, `time_note` (the backend's own explanation). CSV columns are appended after every v1 column
  (`evaluation_status`, `evaluated_landing_utc`, `evaluated_duration_hours`, `evaluated_end_utc`, `requested_landing_utc`,
  `requested_duration_days`, `requested_end_utc`, `time_adjusted`, `time_note`). When nothing was evaluated the evaluated
  fields are `null` / empty, never the request and never 0. v1's `landing_utc` / `duration_days` are unchanged and remain
  the *requested* values (kept for existing consumers). The same snapshot (`frontend/src/features/compare/missionTime.ts`) drives the shared time axis, mission
  extents, the scenario cards, the Mission Assistant context (`comparison-assistant-context-v3`, `mission_time`)
  and the 3D-view cursor.
- JSON: per scenario the plan and requirements, data provenance (kind, source, dataset, engine and scoring
  versions, coverage), eligibility, canonical rank and group, `recommended`, score (status, exact, bounds), risk,
  failed / undecided requirements, every requirement verdict, the canonical metrics with their status, and the
  engine's ranking explanation; plus the ranking groups, the decision per group and the notes.
- CSV: one row per scenario; each metric has `value`, `_lower`, `_upper` and `_status` columns.
- Integrity: missing values are `null` / empty cells with a status, never 0; UNKNOWN stays `unknown`; a rank is only
  exported for a PASS scenario (any other rank is dropped and listed under `warnings`); `recommended` is only true
  for the scenario the decision panel recommends.
- Shareable links were not added: the workspace is session-only and there is no sharing backend to build on.

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

## Guided tour and Mission Assistant

**Guided tour** (`frontend/src/features/compare/tour/`). "How to compare missions" in the page header starts a
five-stop spotlight tour (select missions, viability, conditions, trade-offs, assistant). A one-time offer appears
on first visit; completion and dismissal are remembered in `localStorage` (`lunar-compare-tour`). The page stays
usable during the tour; Esc skips, arrow keys move between stops. It is separate from the Mission Planner's tour.

**Mission Assistant** (`frontend/src/features/compare/assistant/`, `backend/app/assistant/`). A read-only chat panel
that explains the comparison on screen and how to use the page. It cannot change scenarios, requirements, rankings or
Rescue plans; links in its answers only scroll the page or start the tour.

| Piece | What it does |
|---|---|
| `context.ts` | Builds what the assistant reads from the page itself: verdicts, ranks, groups and the recommendation from `buildExport()`; figures as the page displays them (At a glance, Key metrics, Requirements); why figures are withheld; the Mission Rescue story; the interface guide. Rebuilt on every change, so answers never use a stale comparison. While the ranking is updating, no rank or recommendation is sent. |
| `navigation.ts` | Factual guide to the page's controls (checked against the components). The AI may describe only these, and `[[go:section]]` links only to real sections. |
| `fallback.ts` | Basic answers without AI (summary, requirements, Rescue, how-to), assembled from the same context and labelled "Basic answer · not AI". Never sent to the AI. |
| `backend/app/assistant/` | `GET /api/assistant/status`, `POST /api/assistant/chat`. Adds the system instruction and the API key and forwards to an OpenAI-compatible service (OpenRouter by default) using the Python standard library. Failures return 503 with a reason; no answer is ever made up. |

**Setup.** Copy `backend/.env.example` to `backend/.env` and set `OPENROUTER_API_KEY` (optional: `OPENROUTER_MODEL`,
default `openai/gpt-4o-mini`; `OPENROUTER_BASE_URL`; `ASSISTANT_TIMEOUT_S`). The file is read on every request, so
press "Check again" in the panel; no restart is needed. `backend/.env` is git-ignored: each machine needs its own copy,
and without it the panel says "not configured" and gives basic answers. The key never reaches the browser, a log or an
error message. `LUNAR_OFFLINE=1` turns the assistant off (the comparison itself still works).

**Answer rules** (system prompt in `backend/app/assistant/prompt.py`): the team's required instruction word for word,
plus how to read the context. UNKNOWN is never FAIL, missing figures are never 0, only eligible PASS scenarios are
ranked, the page's own recommendation is never overridden, demonstration data is flagged, and navigation answers use
only the interface guide. Each answer shows the page's own verdict chips so it can be checked at a glance.

**Privacy.** Each question sends the current comparison (scenarios, sites, dates, requirements, results) and the
conversation to the configured AI service. No personal data is involved.

**Tests.** `frontend/src/features/compare/assistant/assistant.test.tsx`, `tour/tour.test.tsx`,
`backend/tests/test_assistant.py`, `backend/tests/test_assistant_setup.py` (the AI service is stubbed; no key needed).

**AI disclosure for the submission page.** The app contains an LLM-powered feature (the Mission Assistant, OpenRouter
model `openai/gpt-4o-mini` by default) that explains results computed by the team's own engine; it does not compute,
change or rank anything. Parts of the comparison, tour and assistant code were written with an AI coding assistant.

## Known limitations

- Real data covers the curated sites for 2026-01-01 → 2031-01-01 (hourly). Custom sites created through
  `/api/sites/custom` work; `custom:<lat>,<lon>` ids from Rescue have no real data and show as UNKNOWN (not assessed).
- Viability, scores and ranks come from the canonical engine through `app/viability/compat/rescue.evaluate_timeline_detailed`.
  If the engine's contract changes (new constraint ids, metric fields), `app/compare/evidence.py` (METRIC_FIELDS) and the
  frontend `exportFields.ts` list must follow.
- Ranking uses the engine's STRICT comparability policy: scenarios with different requirements or mission length are
  ranked in separate groups, never against each other.
- The idealised panel incidence factor and the trade-off panel are this module's own presentation aids, labelled as such;
  they never affect eligibility, ranks or the decision.
- Workspace and the imported Rescue story persist in `sessionStorage` (current browser session only); no sharing links.

## Integration notes for the team

| Member | What the comparison relies on | Action needed |
|---|---|---|
| Brandon (viability) | `evaluate_timeline_detailed`, `partition_comparable`, `rank_assessments`, `ranking_explanations`, `comparability_issues`, `compare_scenarios`, constraint `evidence_windows`, `MetricsSummary` fields | None. Contract changes to those names need a matching change in `app/compare/` |
| Arush (Rescue) | `useRescueStore` (`rescue`, `change`) and the `RescueResponse` shape; `sendToComparison()` is available for code that wants to push plans | None. A "Compare" button inside the Rescue panel could call `sendToComparison` directly if wanted |
| Andrew (data, 3D) | `app/store.py` site records (including `known` masks for unknown samples), `/api/sites`, `/api/sites/{id}/horizon`; the comparison cursor writes `siteId` / `timeUtc` into `useAppStore` | None |
| UI / design | The comparison uses the shared Tailwind tokens and the page's own `compare.css` | None |
| Member 6 (validation) | `docs/comparison.md` (this page) states every rule: no zero-filling, UNKNOWN kept, ranks only for PASS within a group | Review welcome |


## Summary report (frozen snapshot)

"Generate Mission Report" (page header, and the Decision area of the Comparison) freezes the evaluated selection into a detached, deep-frozen
snapshot (`frontend/src/features/compare/report.ts`, `ReportPreview.tsx`, print CSS in `report.css`). The preview renders
only the snapshot: later edits to scenarios, landing date, duration, requirements, rankings or background requests never
change an open report. The preview flags itself out of date and offers **Regenerate**; regeneration is refused while any
result is loading or the ranking is stale. **Close** returns to the Comparison workspace exactly as it was (the dashboard
stays mounted under the preview).

**Mission Report Card.** The preview shows the snapshot as the "Lunar Mission Comparison Report", a formal technical
report: black text on white, serif type, thin rules, three-rule tables and status as plain words (PASS / FAIL / UNKNOWN);
colour only in the figures, in muted tones. A title page (document details and contents) is followed by nine numbered
sections (executive summary, mission overview, mission performance, comparison analysis, requirements assessment,
strengths and weaknesses, final assessment, data sources and methodology, disclaimer). Five figures, all from the
snapshot: mean visible solar disk, longest power darkness, Earth in line of sight and longest communication blackout per
plan, each with its axis and the requirement limit as a dashed line (no bar where there is no exact value), and the
requirement outcomes per plan. The content is `reportCard.ts` (a pure function of the snapshot, with the same integrity
rules), laid out by `ReportCardDocument.tsx` (preview) and `ReportCardPdf.tsx` (PDF) from one page/section list and one
figure geometry in `reportLayout.ts`. A bar at the top jumps between sections and shows the page; the summary report's
detailed record follows as a technical appendix (preview and JSON only). **Download PDF** builds a real PDF in the browser
with `@react-pdf/renderer` (loaded only on that click, in its own chunk): A4, built-in Times fonts, running header, footer
with "Page n of N", vector figures, tables kept whole with their captions. Characters the built-in fonts cannot draw are
written out ("≤ 100 h" prints as "max 100 h"). **Print** remains for the browser print dialog. Renderer notes for
maintainers: no `lineHeight` on the PDF page or on a View (it hides the pinned page number, or doubles the spacing);
a pinned `Text` needs a child to be drawn.

- Same data everywhere: the report embeds the structured export built from the same entries (`snapshot.export`), and
  **Download JSON** saves that snapshot. Report rows and export agree on identity, requested vs evaluated window
  (`mission_time`), verdicts, ranking groups, scores and bounds, requirement margins, evidence windows, dataset file +
  SHA-256, engine / scoring versions, limitations.
- Requested and evaluated time are separate. The plans table leads with the evaluated window and shows the request when
  the grid adjusted it; with no evaluated window it says "not evaluated" and never substitutes the request.
- UNKNOWN stays UNKNOWN (never FAIL); a bounded score prints as bounds; a missing value or hash prints as unavailable.
- Export compatibility: format stays `comparison-export-v1`; `schema_revision: 2` is additive (identity, evaluated
  interval, dataset file + hash, selection key, story, preferences, reproduction block, `mission_time`). `landing_utc` /
  `duration_days` keep their v1 meaning (requested) and CSV columns keep their positions; new CSV columns are appended.
- Entry points: `useReportStore.getState().generate()` / `.reopen()` / `.close()`, `cannotGenerate()`,
  `ReportButton`, `LastReportButton`, `ReportPreview` (mounted once in `App.tsx`), `reportHooks.mission` for a guided
  mission to attach its title / objective.
