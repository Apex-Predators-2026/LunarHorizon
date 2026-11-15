# Core recovery progress (role ME, branch `recovery/core-remaining`)

Base: `origin/main` @ `444f3ca` (PR #1 merged). The hourly-grid policy (`backend/app/timegrid.py`) and the canonical
viability/ranking logic are untouched: this stage changes frontend files only (plus docs).

## Prompt 1 - scientific display, fair comparisons and timing

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

## Prompt 2 - assessment panel and evidence navigation

Recovered from `809c482`, `1b5f5f3` (frontend), and the assessment-state intent of `9b32a4a` / `2432dba`, adapted to
current main. `App.tsx`, `store.ts`, `appRoute.ts`, `types.ts` and `backend/app/main.py` are NOT edited.

### What exists now
- **Shared canonical client/state** `features/assessment/useAssessmentStore.ts`: one `POST /api/viability/assess-scenario`
  per exact mission (`scenarioKey` = site, landing instant, duration, every requirement). In-flight requests are shared;
  a response is stored only under its own key, so an edited mission can never show an old answer (it reads `loading`
  until its own arrives); errors are retryable; there is never a verdict while loading/failed/refused.
- **Compatibility adapter** `lib/planVerdict.ts` (`usePlanVerdict`, `fetchPlanVerdict`, `planVerdictKey`, new
  `toPlanVerdict`) now reads that store, so Planner plan cards, Mission Playback and the panel share one request and one
  verdict. Callers are unchanged.
- **Mission assessment panel** `features/assessment/MissionAssessment.tsx`, mounted by `PlansPanel` (Planner-owned) under
  the plan list, with `EvidenceBanner` (portalled to `<body>`, so it floats over the 3D view). First view: verdict,
  plain sentence, score, the deciding requirement (`planDecision`), the evaluated window; failing/undecided requirements
  are listed first, met requirements are in a collapsed group (open when nothing needs attention); risk screen and
  data/assumptions/limitations are disclosures. Per requirement: threshold, measured value or bounds, margin, plain-English
  purpose, "Show why". Unknown data is "Undecided", never a failure; a bounded value is a range; no window = "No time
  window to show" (nothing invented). Tabs: Original plan / After change (preview of the Rescue form change) / Rescue pick.
- **Reliable evidence navigation** `viz/evidence.ts` (from `1b5f5f3`): validated requests, monotonic ids, viewer attach
  that also takes a request made before the 3D view mounted, site-list resolution with data-range checks, highlight band
  on the `TimeBar` next to the mission band, `Scene` pauses, selects site/time and turns toward the Sun/Earth. The
  navigator is injectable (`setEvidenceNavigator`; default = hash router `goToView('planner')`).
- **Comparison "Show why"** (`features/compare/evidence.ts`, `ShowWhy`): on failed/undecided requirements in the Ranking
  rows and the At-a-glance cards; refuses demonstration data and unassessed results with a reason.

### APIs for the guided-mission owner
```ts
// canonical assessment of an exact mission
useAssessmentStore.getState().assess(scenario): Promise<AssessState>   // loading | done{response} | error{message,httpStatus}
useAssessmentStore((s) => s.results[scenarioKey(scenario)])           // reactive read
scenarioKey(scenario)                                                  // identity of the exact inputs
fetchPlanVerdict(scenario) / usePlanVerdict(scenario)                  // small {status, eligibility, failed[], undecided[]} view
// evidence for one requirement, then navigate
const ev = evidenceForConstraint({ site, windows }, constraint)        // null = nothing to show (never invented)
openEvidence({ ...ev.request, origin: { kind: 'guide', label: 'Try a mission' } })  // switches to the Planner, returns {ok}|{ok:false,reason}
showEvidence(request)                                                  // same without switching view
clearEvidence(); returnFromEvidence(highlight)                         // leave / go back to origin
compareEvidence(result, siteId, constraintItem, 'B', 'cmp-performance')// from a Comparison result
```
`EvidenceRequest` = `{ siteId, startUtc, endUtc?, body: 'sun'|'earth', title?, detail?, requirement?, measured?, dataMissing?, bodies?, origin? }`;
times must be ISO 8601 with `Z`/offset. `origin.kind: 'guide'` makes the banner's way back read "Exit evidence view".
`PlansPanel` already mounts `<MissionAssessment />` and `<EvidenceBanner />`: do not mount them again in `App.tsx`.

### Checks run
`npx tsc -b`, `npx oxlint` (no errors), `npx vitest run` (45 files, 485 tests), `npm run build` in `frontend/`.
New: `assessment/sharedState.test.tsx` (single shared request, stale/edited mission, retry, 404, UNKNOWN stays UNKNOWN,
progressive disclosure, empty evidence). Ported: `assessment.test.tsx`, `viz/evidence.test.tsx` (navigation test uses the
injectable navigator; uses new fixture `compare-response-current.json`, generated by `backend/scripts/make_compare_fixture.py`
logic against current main, because the committed `compare-response.json` predates the engine windows).

### Not verified / remaining
- No browser run: the planner flow (Show why from the panel, banner portal position, strip band) is covered by unit and
  SSR tests only. `frontend/scripts/e2e-evidence.mjs` from `1b5f5f3` is a browser script owned by the other developer and
  was not ported.
- Rescue `useRescueStore` is read, not edited; the panel's tabs depend on `original`, `selected`, `rescue.changed.scenario`
  and `change`.

---

## Stage 2: reconciliation with latest main (final)

**Starting SHA** `8d37144` (four recovery commits `742b21c`, `3f5a4bc`, `f5a4c42`, `8d37144`; branched from `444f3ca`).
**Main at integration** `6ad075b` (35 commits ahead of the branch point). **Merge commit** `f32dfa3` (no force-push, no rewrite).
The final remote SHA is stated in the completion report (a doc cannot contain the SHA of the commit that contains it).

### What main already had (superseded: main's version kept)
| Source commit | On main as | Decision |
|---|---|---|
| `742b21c` fair real/synthetic ranking, bestPool | `0c100d8`, `8b38d74` | main's `bestPool`/`comparableEntries` kept; my `bestPool.test.tsx` kept as `bestPoolRecovery.test.tsx` and passes against it |
| `3f5a4bc` one evaluated snapshot, requested vs evaluated separate | `f6586e4`, `3b651ad`, frozen report `2b34dd2` | main's `missionTime`/report/export kept; my `missionTime.test.tsx` kept as `missionTimeRecovery.test.tsx` and passes |
| `f5a4c42` unknown lanes / withheld stats | `b5a869e` (lanes.ts, SyncTimeline, TimeBar hatch) | main's markup and wording kept; tests adapted to it |
| `8d37144` Mission assessment panel | `6a56580` `AssessmentPanel`/`AssessmentDialog` + `lib/assessment.ts` | both surfaces kept (dialog from a plan card, panel for the running plan); one fetch layer (below) |

### Completed on top of main
- **One assessment request/cache layer.** `lib/assessment.ts` (`fetchAssessment`, `useAssessment`, `clearAssessmentCache`) now
  delegates to `features/assessment/useAssessmentStore`. A mission is requested once (in-flight dedupe, key = site + landing
  instant + duration + every requirement), errors are retryable and never a verdict, and an edited mission can never read an old
  response. `lib/planVerdict.ts` uses the same store.
- **Sample-and-hold** (`analysis.ts`: `sampleIndex`, `conditionsAt` with `held`/`selectedMet`, `mergeSeries` hold + unknown
  intervals survive thinning; `lanes.ts: sunPath`; `TimeBar` spans cover [t, t+1 h) like `backend/app/timegrid.py`); a visible
  sliver that rounds to 0 is drawn as light, not darkness.
- **Bounded/withheld rows**: `METRICS` rows show the engine's range ("a – b (bounds: data incomplete)") or "Unknown (data
  incomplete)", never a number; `get()` stays null so no best is claimed.
- **Cards**: dataset file + SHA-256 (`data-testid="dataset-identity"`) and the incomplete-data/withheld note with known hours.
- **TimeBar evidence overlay** (`StripEvidence`, `EVIDENCE_COLOR`/`MISSING_COLOR`, legend entry, mission `label`) next to the mission band.
- **Types**: `TimelineColumns` (`source_step_hours`, `stride`, `mission_*_utc`, `sun_visible`), `EvidenceWindow.duration_s`,
  `AssessmentInfo.windows`, which the backend already sends.

### Files changed in the merge resolution
`frontend/src/lib/assessment.ts`, `features/compare/{analysis,lanes,types,OverviewCards}.ts(x)`, `viz/TimeBar.tsx`, tests
`compare/{missingData,missionTimeRecovery,bestPoolRecovery}.test.tsx`; conflicted files otherwise resolved to main
(`AtAGlance, ComparisonDashboard, MetricsTable, SyncTimeline, export, fallback, docs/comparison.md`), `planVerdict.ts` to the store adapter.

### Scientific contract decisions
Hourly grid and sample-and-hold are authoritative (`timegrid.py`); PASS/FAIL/UNKNOWN/NOT_EVALUATED are the engine's only;
missing stays missing, bounded stays a range; real and demonstration data never compete for "best"; requested and evaluated
mission timing are separate fields; report/export code is main's, unchanged (frozen snapshot, dataset file + SHA-256, CSV/JSON).

### Tests (frontend/)
`npx tsc -b` clean; `npx vitest run`: **53 files, 582 tests passed**; `npx oxlint`: 0 errors (warnings only, in files not touched
here: RoverFlag, RoverMascot, TileTree); `npx vite build` succeeds.
Backend tests were **not run**: Python is not installed in this environment; no backend file was edited by this stage.

### Browser evidence
**None.** No browser tool was available in this session, so the live 1366×768 / 1920×1080 inspection and the full
click-through (select plan → assess → Show why → 3D → return) were **not performed**; that flow is covered by
`assessment/sharedState.test.tsx`, `viz/evidence.test.tsx`, `lib/assessment.test.tsx` and SSR tests only.

### Known limitations
- "Show in 3D" from main's per-plan `AssessmentDialog` calls `showEvidence` without an `origin`; the banner's return then goes to
  the Mission assessment panel, not back to the dialog (and the panel may be for a different plan than the dialog's).
- The lane/strip unknown bands use main's hatch rendering (labelled in tooltips/legend), not my `unknown-band` test ids.
- Two assessment surfaces exist (dialog + panel); they share data but not layout.

### For the guided-workflow developer
Use the API block above unchanged; additionally `fetchAssessment(scenario)`/`useAssessment(scenario)` from `lib/assessment.ts`
are now thin views of `useAssessmentStore`. Pass `origin: { kind: 'guide', ... }` to `openEvidence` so return works from the guide.
