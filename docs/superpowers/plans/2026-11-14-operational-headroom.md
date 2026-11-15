# Implementation Plan: Operational Headroom Next to Every PASS

**Spec:** [2026-11-14-operational-headroom-design.md](./2026-11-14-operational-headroom-design.md)  
**Methodology:** Strict TDD (RED -> GREEN -> REFACTOR) + Parallel Disjoint Workstreams + Full Verification (`pytest`, `vitest`, `oxlint`, `tsc -b`, Playwright visual QA).

---

## Workstream 1: Backend Canonical Headroom Engine Bridge & Models
**Files:**
- Create `backend/app/viability/compat/headroom.py`
- Modify `backend/app/models.py`
- Modify `backend/app/viability/compat/rescue.py`
- Modify `backend/app/compare/schemas.py`
- Modify `backend/app/compare/evidence.py`
- Modify `docs/interfaces.md`

**Tasks:**
1. Write failing tests first in `backend/tests/test_headroom_contracts.py` asserting:
   - `ViabilityAssessment` margins -> `OperationalHeadroom` preserves Phase 4A `MarginClass` (`comfortable` vs `narrow` vs `at_threshold` vs `negative` vs `uncertain`).
   - 50 h darkness limit: 15 h gap -> `+35 h` darkness headroom (`comfortable`); 49 h gap -> `+1 h` (`narrow`, `qualified_verdict` contains `"passes with limited darkness margin"`, `closest_constraint` = `max_continuous_darkness`, disclaimer rejects guarantee).
   - Bounded/incomplete data keeps interval `[lower, upper]` in `headroom` (never collapses to a point).
   - Initial illumination & Earth contact windows report duration + first sunset/Earthset (`stays up` vs `T+X h`) even when `min_initial_*_hours == 0`, plus headroom when configured `> 0`.
   - `/api/compare` `assessment.margins`, `assessment.headroom`, and `assessment.metrics.time_to_first_sunset_h` / `time_to_first_earthset_h` are populated and consistent with Phase 4A.
   - Existing `docs/member2-part2-demo.json` snapshot check stays green.
2. Implement `backend/app/viability/compat/headroom.py`, wire into `models.py` (`ViabilityResult.headroom`), `compat/rescue.py`, `compare/schemas.py`, `compare/evidence.py`.
3. Run targeted backend tests and confirm PASS.

---

## Workstream 2: Backend Rescue, Explained Headlines & Tested Date-Slip Checks
**Files:**
- Modify `backend/app/rescue/schemas.py`
- Modify `backend/app/rescue/explain.py`
- Modify `backend/app/rescue/sensitivity.py`
- Modify `backend/app/rescue/search.py`
- Modify `backend/tests/test_rescue.py`, `backend/tests/test_sensitivity_compromise.py` (or add `backend/tests/test_headroom_rescue.py`)

**Tasks:**
1. Write failing backend tests in `backend/tests/test_headroom_rescue.py` asserting:
   - Passing changed plan (`still_viable`) includes `changed_robustness` with populated `date_checks` (`-24, -12, +12, +24 h`) and `summary` using limited-margin wording when narrow + non-guarantee caveat.
   - `AlternativeCard` / `Alternative.headline` & `reasons` expose darkness/comms headroom, initial sun/Earth windows, closest limit, and separate `robustness.date_checks`.
   - `SensitivityResponse` & `SensitivityPoint` carry `darkness_headroom_h`, `comms_headroom_h`, `closest_label`, `headroom_status`, `date_limited_offsets_hours`, `tightest_passing_headroom`, and `screening_note`.
2. Implement schema and logic updates cleanly (with defensive guards when custom fake `Evaluator` omits `viability.headroom`).
3. Run full backend pytest suite.

---

## Workstream 3: Frontend Canonical Types, Shared Headroom Presenter & UI Primitive
**Files:**
- Modify `frontend/src/types.ts`
- Create `frontend/src/lib/headroom.ts`
- Create `frontend/src/ui/PassHeadroom.tsx`
- Modify `frontend/src/features/compare/types.ts`
- Modify `frontend/src/features/rescue/types.ts`
- Create/Update `frontend/src/lib/headroom.test.ts`

**Tasks:**
1. Write failing unit tests in `frontend/src/lib/headroom.test.ts` covering:
   - Canonical backend `OperationalHeadroom` mapping (comfortable vs limited vs at_threshold vs bounded).
   - Fallback derivation from `ViabilityMetrics + MissionRequirements` + offline `MissionTrack` playback.
   - Explicit wording `"passes with limited darkness margin"`, closest constraint selection, initial windows formatting, tested date-slip summary formatting, and non-guarantee wording across every mode.
2. Implement TypeScript types + `headroom.ts` + `<PassHeadroom />` (supports `tone="compare"` for slate Compare surface and `tone="opaline"` for Opaline/sidebar/playback surfaces, plus `compact` / `full` variants).

---

## Workstream 4: Frontend Surfaces (Every PASS Location)
**Files (can execute in two disjoint sub-batches: Compare + Rescue/Playback):**
- **Batch 4A (Compare Workspace):**
  - `frontend/src/features/compare/analysis.ts`
  - `frontend/src/features/compare/decision.ts`
  - `frontend/src/features/compare/OverviewCards.tsx`
  - `frontend/src/features/compare/MetricsTable.tsx`
  - `frontend/src/features/compare/PerformancePanels.tsx`
  - `frontend/src/features/compare/SummaryPanel.tsx`
  - `frontend/src/features/compare/RescueStory.tsx`
  - `frontend/src/features/compare/export.ts` & `exportFields.ts`
  - Tests: update/extend `compare.test.tsx`, `decision.test.tsx`, `export.test.tsx`, `rescueFlow.test.tsx`
- **Batch 4B (Rescue, Sensitivity, Compromise, Plans & Playback):**
  - `frontend/src/features/rescue/RescuePanel.tsx`
  - `frontend/src/features/rescue/AlternativeCard.tsx`
  - `frontend/src/features/rescue/SensitivityView.tsx`
  - `frontend/src/features/rescue/CompromisePanel.tsx`
  - `frontend/src/features/rescue/walkthrough.ts`
  - `frontend/src/viz/useMissionPlayback.ts` & `frontend/src/viz/MissionPlayback.tsx`
  - `frontend/src/features/plans/PlansPanel.tsx`
  - Tests: extend `rescue.test.tsx`, add `MissionPlayback.test.tsx` (and fix any Node `localStorage` test setup issue if needed - wait: verify why `rescue.test.tsx:258` failed first!)

---

## Workstream 5: Full End-to-End Verification & Visual QA
1. Run full backend `pytest` (`backend/.venv/Scripts/pytest.exe`).
2. Run full frontend test suite (`vitest run`), `npm --prefix frontend run lint`, and `npm --prefix frontend run build`.
3. Update fixture snapshots cleanly if needed or verify live backend responses with PlayWright against `http://localhost:5173/#app/planner` and `http://localhost:5173/#app/compare`.
4. Capture and visually inspect screenshots across:
   - Compare Workspace Overview / Metrics / Performance Ranking / Summary Decision (both passing comfortable & limited margins).
   - Mission Rescue (`Plan still works`, `Alternatives` with limited/comfortable headroom & date-slip checks, `SensitivityView`, `CompromisePanel`).
   - 3D Mission Playback HUD (`MissionPanel`) showing headroom + non-guarantee note.
5. Audit every single line of Request #10 and conclude with `<!-- GOAL_COMPLETE -->`.
