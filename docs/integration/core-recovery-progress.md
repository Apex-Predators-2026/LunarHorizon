# Core recovery progress (role ME, branch `recovery/core-remaining`)

Base: `origin/main` @ `444f3ca` (PR #1 merged). The hourly-grid policy (`backend/app/timegrid.py`) and the canonical
viability/ranking logic are untouched: this stage changes frontend files only (plus docs).

## Prompt 1 — scientific display, fair comparisons and timing

| Source | Recovered | How |
|---|---|---|
| `6f2bc5f` | `bestPool` / `bestOf`: real and synthetic results never share a "best"; a missing or bounded competitor blocks a lead instead of dropping out; At a glance note | cherry-picked, conflicts resolved against main's `AtAGlance` / `buildSummary` |
| `74ab073` | `features/compare/missionTime.ts` snapshot used by cards, axis, cursor, conditions, Rescue story and assistant context | cherry-picked; export kept at `comparison-export-v1` (additive `mission_time`, v1 `landing_utc`/`duration_days` still hold the REQUESTED values) |
| `a733b85` (frontend only) | unknown Sun/Earth lanes + legend (Comparison `SyncTimeline`, `lanes.ts`), unknown bands + legend in the 3D `TimeBar`, held-sample `conditionsAt`, `mergeSeries` held steps, withheld-aware metric rows (`withCanonical`), coverage note, all-or-nothing `pick` | patch applied selectively; `mission.ts` / `useMissionPlayback.ts` and the exact-interval policy deliberately NOT taken |

Unknown rendering: unknown intervals are a labelled grey hatch in both views, never darkness or blackout; the sunlight
area path breaks at unknown samples; a visible sliver (`sun_visible === true` with fraction 0) is drawn as light.
Existing `SeriesChart` gap handling (`connectNulls={false}`, step lines) is unchanged.

Backend fields now typed and shown: `unknown_windows`, `sun_known_hours`, `earth_known_hours`, `withheld`,
`dataset_file`, `dataset_sha256` (card footer, hash shortened, full value in the tooltip). A body with missing data keeps
the other body's valid statistics (tested both ways).

### Mission-time helper contract (`frontend/src/features/compare/missionTime.ts`)

`missionTime(entry)` / `missionTimeOf(scenario, state, { expectedKey? })` return a `MissionTimeSnapshot`:

| Field | Meaning |
|---|---|
| `requested` | `{ landing_utc, duration_days, duration_hours, end_utc }` exactly as entered |
| `evaluated` | same shape from the backend's `evaluated_landing_utc` / `evaluated_duration_days`; `null` unless `status === 'evaluated'` |
| `status` | `evaluated`, `pending`, `error`, `not_requested`, `not_assessed`, `not_reported`, `stale` (stale only when `expectedKey` is passed and differs) |
| `available` | `status === 'evaluated'` |
| `adjusted` | request differs from evaluation; `null` when nothing evaluated |
| `time_note` | the backend's own explanation, or `null` |

Report / guided-mission code should read the window only from this snapshot, never re-derive grid rounding
(`Math.round` and Python `round` differ at ties). Text helpers: `missionTimeLines`, `evaluatedWindowText`,
`requestedWindowText`, `describedWindowText`, `evaluationStatusText`. `axisPlacement` is a provisional estimate for the
shared axis only; it must never be shown or exported as evaluated. Export field `mission_time` carries
`evaluation_status`, `evaluated_*`, `requested_*`, `time_adjusted`, `time_note`.

Other fields available per `CompareResult` for a report: `evaluated_start_utc`, `evaluated_end_utc`, `evaluated_hours`,
`time_note`, `unknown_windows`, `sun_known_hours`, `earth_known_hours`, `withheld`, `dataset_file`, `dataset_sha256`,
and `CompareResponse.time_policy`.

### Checks run
- `npx tsc -b`, `npx oxlint` (no errors), `npx vitest run` (43 files, 442 tests) in `frontend/`.
- New/adapted tests: `bestPool.test.tsx`, `missionTime.test.tsx`, `missingData.test.tsx` (partial Sun and Earth data,
  all-unknown, bounded competitor, dataset identity), `timeline.test.ts`.

### Known limits / notes
- Export v2 and the summary report are intentionally deferred to prompt 3.
- The committed `compare-response.json` fixture predates the new backend fields; tests add them by controlled edits
  (regenerating it changes verdict-dependent assertions in older tests).
- `viz/mission.ts` canonical-only playback is unchanged; its unknown handling already comes from main.
