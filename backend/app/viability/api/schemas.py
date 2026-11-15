"""Request/response contracts of the viability HTTP API (Member 2). Documented in docs/viability-api.md.

Every model is a strict ``ContractModel`` (unknown fields rejected, no coercion of strings or booleans to
numbers, NaN/Inf rejected, UTC-only timestamps). The canonical ``ViabilityAssessment`` is embedded unchanged;
every other field is either input provenance or a verbatim projection of the assessment, never a second
evaluation.
"""

from __future__ import annotations

from typing import Annotated, Final, Literal

from pydantic import BaseModel, Field, JsonValue, StringConstraints

from ...models import Scenario
from ..conventions import (
    ContractModel,
    Identifier,
    NonEmptyStr,
    NonNegativeFloat,
    Percent,
    StrictBool,
    UTCDatetime,
)
from ..enums import (
    AngleType,
    CalculationBasis,
    DataBasis,
    Eligibility,
    RiskLevel,
    ScoreComponent,
    ScoreStatus,
    VisibilityCriterion,
)
from ..explain import ExplanationDetail
from ..inputs import Provenance, SamplingInfo
from ..mission import MissionRequirements, RankingPreferences, SpacecraftConfiguration
from ..outputs import Metric, ViabilityAssessment

API_VERSION: Final = "viability-api/1.0.0"

# A precomputed site file name stem (data/sites/<site_id>.json). No path separators can match.
SiteId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
# Exact rational written as "p/q" or "p" (fractions.Fraction text form).
RationalText = Annotated[str, StringConstraints(pattern=r"^[0-9]+(/[0-9]+)?$")]

RANKING_RULE: Final = (
    "Only rank_eligible assessments (eligibility PASS) receive a rank. UNKNOWN is neither scored nor ranked; "
    "FAIL keeps a descriptive score but is never ranked against viable scenarios. A bounded score is an "
    "interval, never a point value, and a missing score is never zero. Assessments may share one ranking "
    "only if their comparability fields are all equal (data_basis, scoring_method_version, effective_weights "
    "and, under the strict policy, configuration_key)."
)


# --- request ------------------------------------------------------------------------------------------------------


class AssessRequest(ContractModel):
    """One mission on one precomputed site, evaluated by the canonical engine.

    The site comes from the site file (``site_id``), so the scenario and the data always refer to the same
    location. Every operational limit is optional; ``None`` makes its constraint NOT_APPLICABLE.
    """

    site_id: SiteId = Field(description="Precomputed site id (data/sites/<site_id>.json), e.g. 'malapert-massif'")
    mission_start_utc: UTCDatetime = Field(description="Landing / mission start, ISO 8601 UTC ('Z')")
    mission_end_utc: UTCDatetime = Field(description="Mission end (exclusive), ISO 8601 UTC ('Z')")
    spacecraft: SpacecraftConfiguration
    requirements: MissionRequirements = Field(default_factory=MissionRequirements)
    preferences: RankingPreferences = Field(default_factory=RankingPreferences)
    scenario_id: Identifier | None = Field(
        default=None, description="Echoed in the assessment; default '<site_id>_<start YYYYmmddTHHMMSSZ>'"
    )
    name: NonEmptyStr | None = None
    include_explanation_details: StrictBool = Field(
        default=True, description="Add explanations with stable keys and technical evidence"
    )


class AssessScenarioRequest(BaseModel):
    """A team ``Scenario`` (site, landing, duration, Rescue-style requirements), as saved by the Mission Planner.

    Converted to the canonical request by ``app.viability.compat.rescue.requirements_to_canonical`` (the mapping
    Rescue and Comparison already use), so the planner, Rescue and Comparison all assess the same mission.
    Only precomputed sites are supported (``scenario.site.id`` = data/sites/<id>.json).
    """

    scenario: Scenario
    include_explanation_details: bool = True


# --- response -----------------------------------------------------------------------------------------------------


class ScoreComparability(ContractModel):
    """What a score is measured against (``ViabilityAssessment.comparability_key``), JSON-safe."""

    data_basis: DataBasis
    scoring_method_version: NonEmptyStr
    effective_weights: dict[ScoreComponent, RationalText]  # exact rationals; ACTIVE weights sum to 1
    configuration_key: NonEmptyStr | None


class RankingStatus(ContractModel):
    """Verbatim projection of the assessment's eligibility and score for ranking consumers."""

    eligibility: Eligibility
    rank_eligible: StrictBool  # assessment.score.rank_eligible (True iff eligibility is PASS)
    score_status: ScoreStatus | None
    score: Percent | None  # exact score only; None = not scored or only bounded (never 0 for "missing")
    score_bounds: Metric | None  # unit percent; KNOWN (= score) or BOUNDED [lower, upper]
    score_lower_bound: Percent | None  # exact score or guaranteed lower bound; for ordering only
    overall_risk: RiskLevel
    comparability: ScoreComparability
    rule: NonEmptyStr = RANKING_RULE


class InputDataset(ContractModel):
    """The scientific time series the assessment was computed from."""

    site_file: NonEmptyStr  # repository-relative path, e.g. data/sites/malapert-massif.json
    sha256: Sha256
    dataset_id: Identifier
    coverage_start_utc: UTCDatetime
    coverage_end_utc: UTCDatetime
    mission_within_coverage: StrictBool  # coverage_start <= mission start and mission end <= coverage_end
    sample_count: int = Field(ge=1, strict=True)
    sampling: SamplingInfo
    calculation_basis: CalculationBasis
    angle_type: AngleType
    sun_criterion: VisibilityCriterion
    earth_criterion: VisibilityCriterion
    fraction_decimals: int | None
    observer_height_m: NonNegativeFloat | None
    provenance: Provenance


class MethodVersions(ContractModel):
    api: NonEmptyStr
    schema_version: NonEmptyStr
    engine: NonEmptyStr
    scoring: NonEmptyStr
    ranking: NonEmptyStr
    explanations: NonEmptyStr


class AssessResponse(ContractModel):
    api_version: Literal["viability-api/1.0.0"] = API_VERSION
    assessment: ViabilityAssessment  # the canonical result, unchanged
    ranking_status: RankingStatus
    explanation_details: list[ExplanationDetail] | None  # None when not requested
    input_dataset: InputDataset
    methods: MethodVersions


# --- validation summary -------------------------------------------------------------------------------------------


class CheckResult(ContractModel):
    name: NonEmptyStr
    passed: StrictBool
    detail: str


class ValidationCase(ContractModel):
    name: NonEmptyStr
    category: NonEmptyStr
    synthetic: StrictBool  # True only for the explicitly labelled SYNTHETIC fixture case
    passed: StrictBool
    check_count: int = Field(ge=0, strict=True)
    failed_checks: list[CheckResult]
    inputs: dict[str, JsonValue]  # as recorded by the suite (site, landing, duration, ...)
    outcome: dict[str, JsonValue]  # as recorded by the suite (eligibility, score, risks, ...)


class ValidatedDataset(ContractModel):
    site_id: NonEmptyStr
    file: NonEmptyStr
    sha256: Sha256
    current_sha256: Sha256 | None  # None = the file is no longer present
    unchanged: StrictBool
    is_synthetic: StrictBool
    calculation_basis: NonEmptyStr
    coverage_start_utc: NonEmptyStr
    coverage_end_utc: NonEmptyStr
    sample_count: int = Field(ge=0, strict=True)


class ReportCurrency(ContractModel):
    """Whether the stored report still describes the running code and the committed data."""

    current: StrictBool  # True iff every version matches and every validated file is unchanged
    version_mismatches: list[NonEmptyStr]
    changed_datasets: list[NonEmptyStr]
    unvalidated_datasets: list[NonEmptyStr]  # site files present now but not in the report
    note: NonEmptyStr


class CheckTotals(ContractModel):
    checks: int = Field(ge=0, strict=True)
    failed: int = Field(ge=0, strict=True)
    smoke_checks: int = Field(ge=0, strict=True)
    smoke_failed: list[CheckResult]


class TimingSummary(ContractModel):
    evaluate_scenario_median_ms: NonNegativeFloat
    evaluate_scenario_p95_ms: NonNegativeFloat
    evaluate_scenario_workload: str
    data_load_total_s: NonNegativeFloat
    data_prepare_total_s: NonNegativeFloat
    machine: dict[str, str | int | None]


class ValidationSummaryResponse(ContractModel):
    api_version: Literal["viability-api/1.0.0"] = API_VERSION
    status: Literal["passed", "failed"]
    validation_version: NonEmptyStr
    generated_utc: NonEmptyStr
    report_file: NonEmptyStr
    regenerate_command: NonEmptyStr
    versions: dict[str, str]
    currency: ReportCurrency
    totals: CheckTotals
    cases: list[ValidationCase]
    invariants: list[CheckResult]
    datasets: list[ValidatedDataset]
    standard_lander: dict[str, str | float | None]
    timing: TimingSummary
    limitations: list[NonEmptyStr]
