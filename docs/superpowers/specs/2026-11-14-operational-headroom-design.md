# Design Spec: Operational Headroom Next to Every PASS

**Date:** 2026-11-14  
**Goal:** Put canonical operational headroom next to every `PASS` across the backend contracts and frontend UI so engineers and educators immediately distinguish a comfortable pass (e.g., 35 h of darkness headroom for a 50 h battery limit) from a borderline pass (e.g., 1 h of headroom), without ever misrepresenting model screening results as guarantees of spacecraft survival.

---

## 1. Non-Negotiable Architecture Principles

1. **Single Canonical Source of Truth (`backend/app/viability/margins.py`):**
   - `evaluate_scenario()` already computes Phase 4A `OperationalMargin` (`value: Metric`, `reference`, `description`), `relative_margin()`, and `classify_margin()` (`comfortable`, `narrow`, `at_threshold`, `negative`, `uncertain`, `unsupported`, `not_applicable`).
   - Do **not** alter `ViabilityAssessment` (`backend/app/viability/outputs.py`), `margins.py`, or `docs/member2-part2-demo.json` (preserving the strict `ContractModel` JSON schemas and byte-for-byte snapshot checks).
   - Add one canonical serialization builder (`backend/app/viability/compat/headroom.py`) that transforms a finished `ViabilityAssessment` into a portable, JSON-friendly `OperationalHeadroom` model using `margins.py`'s exact `classify_margin`, `relative_margin`, and `margin_bounds`.

2. **Honesty Under Incomplete Data:**
   - Never collapse `MetricStatus.BOUNDED` or `UNAVAILABLE` margins into exact point headroom. Carry `status` (`known | bounded | unavailable | not_applicable`), `value`, `lower`, and `upper` into both Compare (`AssessmentInfo`) and Rescue (`ViabilityResult`).
   - `narrow` (`limited`) matches Phase 4A `MarginClass.NARROW`: least-favourable headroom `> 0` and either `relative_margin <= 0.10` (`NARROW_MARGIN_FRACTION`) or (`unit == "h"` and `headroom < sample_resolution_h`). Zero proven headroom (`lo == 0`) is `at_threshold`.

3. **Screening Framing (No Survival Guarantees):**
   - Every PASS summary with narrow margins uses wording like `"passes with limited darkness margin"`.
   - Every headroom summary carries or sits beside an explicit screening note: model margins cover illumination and geometric Earth line-of-sight only and are **not a guarantee of spacecraft survival**.

---

## 2. Backend Contract Additions (Backward-Compatible, Additive Optional Fields)

### 2.1 Shared Models (`backend/app/models.py` + `backend/app/viability/compat/headroom.py`)
Define reusable Pydantic models (consumed by both `ViabilityResult` and `compare.AssessmentInfo`):
- **`MarginStatus`** (`Literal["comfortable", "narrow", "at_threshold", "negative", "uncertain", "unsupported", "not_applicable"]`)
- **`MarginMetricValue`**: `{ status: Literal["known", "bounded", "unavailable", "not_applicable"], unit: str, value: float | None, lower: float | None, upper: float | None, reason: str | None }`
- **`CanonicalMarginItem`**:
  - `id: str` (e.g. `"max_continuous_darkness"`), `requirement_field: str | None` (`"battery_hours"`, etc.)
  - `name: str`, `short_label: str`, `comparison: Literal["at_least", "at_most"] | None`
  - `unit: str` (`"h"`, `"%"`, `"fraction"`), `threshold: float | None`, `measured: MarginMetricValue` (observed value), `margin: MarginMetricValue` (signed headroom: `limit - observed` or `observed - required`)
  - `relative_margin: MarginMetricValue | None` (`margin / threshold` when `threshold > 0`)
  - `margin_class: MarginStatus`, `narrow_reason: str | None`, `description: str`
- **`InitialWindowSummary`**:
  - `kind: Literal["sunlight", "earth"]`
  - `duration: MarginMetricValue` (`initial_sunlight_duration` / `initial_earth_visibility_duration` in `h`)
  - `first_end_hours: MarginMetricValue` (`time_to_first_sunset` / `time_to_first_earthset` in `h`; `not_applicable` = stays up all mission)
  - `requirement_hours: float | None`, `headroom: CanonicalMarginItem | None`
  - `summary_text: str` (e.g. `"216 h continuous from landing (first sunset T+216 h)"` or `"168 h (stays lit full mission)"`)
- **`ClosestRequirementInfo`**:
  - `constraint_id: str`, `requirement_field: str | None`, `label: str`, `margin_class: MarginStatus`, `unit: str`
  - `headroom_text: str` (e.g. `"+1.0 h remaining of 50 h limit"` or `"between +1.0 h and +4.0 h"`), `relative_pct: float | None`
  - `summary_text: str`
- **`OperationalHeadroom`**:
  - `status: Literal["comfortable", "limited", "at_threshold", "failed", "uncertain", "vacuous"]`
  - `qualified_verdict: str` (e.g. `"Passes with limited darkness margin (1.0 h left of 50 h limit)"` or `"Passes with comfortable margins (35.0 h darkness, 48.0 h blackout)"`)
  - `limited_constraints: list[str]` (requirement fields in `narrow` or `at_threshold`)
  - `darkness: CanonicalMarginItem | None`
  - `communication_blackout: CanonicalMarginItem | None`
  - `initial_sunlight: InitialWindowSummary`
  - `initial_earth: InitialWindowSummary`
  - `closest_constraint: ClosestRequirementInfo | None`
  - `constraints: list[CanonicalMarginItem]`
  - `screening_note: str` (`"Model screening result (illumination & Earth LOS geometry only); not a guarantee of spacecraft survival."`)

Add `headroom: OperationalHeadroom | None = None` to `ViabilityResult` (`backend/app/models.py`).  
`assessment_to_result()` in `backend/app/viability/compat/rescue.py` always populates `headroom=build_operational_headroom(assessment)`.

### 2.2 Compare API (`backend/app/compare/schemas.py` & `evidence.py`)
- Add `"time_to_first_sunset_h": "time_to_first_sunset"` and `"time_to_first_earthset_h": "time_to_first_earthset"` to `METRIC_FIELDS` in `evidence.py`.
- Add `margins: list[CanonicalMarginItem] = []` and `headroom: OperationalHeadroom | None = None` to `AssessmentInfo`, populated by `assessment_info(a)`.

### 2.3 Rescue & Sensitivity API (`backend/app/rescue/schemas.py`, `explain.py`, `search.py`, `sensitivity.py`)
- **`DateSlipCheck`**:
  - `date_offset_hours: float`, `status: SensitivityStatus`, `passes: bool`
  - `darkness_headroom_h: float | None`, `comms_headroom_h: float | None`
  - `closest_label: str | None`, `closest_headroom_text: str | None`, `headroom_status: str | None`
  - `failing_constraints: list[RequirementKey]`
- **`Robustness`**: add `date_checks: list[DateSlipCheck] = []`, `date_passing: int = 0`, `date_checked: int = 0`, `date_note: str | None = None`.
- **`SensitivityPoint`**: add `darkness_headroom_h: float | None = None`, `comms_headroom_h: float | None = None`, `closest_label: str | None = None`, `closest_headroom_text: str | None = None`, `headroom_status: str | None = None`.
- **`SensitivityResponse`**: add `date_limited_offsets_hours: list[float] = []`, `tightest_passing_headroom: str | None = None`, `screening_note: str`.
- **`RescueResponse`**: add `changed_robustness: Robustness | None = None` (populated via `quick_robustness` when `changed.passes` so `"Plan still works"` immediately exposes tested date-slip checks).
- **Wording (`explain.py`, `search.py`):**
  - `headline_for`: use `c.result.headroom.qualified_verdict` when available so headlines say `"passes with limited darkness margin..."` vs `"passes with comfortable margins..."`, never bare `"passes all requirements"`.
  - `reasons_for`: include darkness/blackout headroom, initial illumination/contact windows, and closest-to-limit note.
  - `search.py`: when `changed.passes`, include qualified verdict and tested date-slip result summary + screening caveat in `summary`.

---

## 3. Frontend UI Integration (Every PASS Surface)

1. **Shared Presenter (`frontend/src/lib/headroom.ts`) & Shared Component (`frontend/src/ui/PassHeadroom.tsx`):**
   - Consumes canonical backend `OperationalHeadroom` first (`viability.headroom` or `assessment.headroom`), with pure fallback from `ViabilityMetrics + MissionRequirements` (plus client `MissionTrack` for offline 3D playback).
   - Formats exact values OR bounded intervals (`between +X h and +Y h`), never collapsing bounded metrics or treating missing data as `0`.
   - Exposes consistent badge/tone (`comfortable` emerald check, `limited` / `at_threshold` amber warning `"Passes · limited <constraint> margin"`) + explicit screening caveat (`"Screening result only - not a guarantee of spacecraft survival."`).
   - Preserves existing `headroom()` / `headroomSummary()` behavior in `features/rescue/format.ts`.

2. **Mounted UI Surfaces:**
   - **Compare Overview (`OverviewCards.tsx`):** Qualified PASS margin badge beside `EligibilityBadge`, canonical **Operational Headroom** card block (darkness headroom, blackout headroom, initial sun/Earth windows with first sunset/Earthset, closest limit, screening note).
   - **Compare Metrics Table (`MetricsTable.tsx` & `analysis.ts`):** Canonical margin class + signed headroom on every constraint row (`requirementMatrix`) from `assessment.margins`; qualified tag beside Eligibility; initial window sunset/Earthset & closest-constraint rows.
   - **Compare Ranking & Charts (`PerformancePanels.tsx`):** Qualified PASS margin block + headroom breakdown in `MissionPerformance`; amber limited-margin flag in `AvailabilityCharts` instead of identical green OK text.
   - **Compare Decision & Story (`SummaryPanel.tsx`, `decision.ts`, `RescueStory.tsx`):** Qualified requirement sentences naming limited margins, closest constraint, and screening non-guarantee statement.
   - **Compare Export (`export.ts`, `exportFields.ts`):** Export canonical headroom (`status`, `qualified_verdict`, `closest_constraint`, `margins`) + first sunset/Earthset columns in JSON & CSV.
   - **Mission Rescue (`RescuePanel.tsx`, `AlternativeCard.tsx`, `SensitivityView.tsx`, `CompromisePanel.tsx`):**
     - `RescuePanel`: when changed plan passes (`still_viable`), render `<PassHeadroom>` + `changed_robustness` tested date-slip pills immediately inside the status banner.
     - `AlternativeCard`: render canonical `PassHeadroom` (darkness, comms blackout, initial illumination/contact windows, closest limit, screening caveat) AND separate **Tested date-slip checks** pills/summary (`date_checks`) from off-target checks!
     - `SensitivityView`: display per-date-slip headroom & limited-margin highlight pills, `safe_date_window_hours`, `tightest_passing_headroom`, and discrete-check non-guarantee disclaimer.
     - `CompromisePanel`: show PASS/FAIL/UNKNOWN eligibility badge and compact canonical headroom (`limited` warning vs `comfortable`) on `best` and Pareto table options.
   - **3D Mission Playback (`MissionPlayback.tsx`, `useMissionPlayback.ts`, `PlansPanel.tsx`):**
     - Fix `verdictFor` `samePlan` to match `requirements` too.
     - Replace bare `Viability engine: PASS` and `Mission over: every requirement held` with canonical/track headroom breakdown (darkness headroom, blackout headroom, initial sun/contact windows, closest limit, `"Passes with limited <x> margin"`, screening non-guarantee note).
