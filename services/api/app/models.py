from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class AnalysisStatus(str, Enum):
    uploaded = "uploaded"
    validating = "validating"
    forecasting = "forecasting"
    optimizing = "optimizing"
    reasoning = "reasoning"
    verifying = "verifying"
    completed = "completed"
    completed_with_warnings = "completed_with_warnings"
    failed = "failed"


class QualityReport(BaseModel):
    dataset_type: str
    valid_rows: int
    rejected_rows: int = 0
    duplicate_rows: int = 0
    missing_lead_times: int = 0
    unknown_skus: int = 0
    warnings: list[str] = Field(default_factory=list)
    critical_errors: list[str] = Field(default_factory=list)
    analysis_ready: bool


class BusinessSettings(BaseModel):
    available_cash: float = 160_000
    minimum_cash_reserve: float = 70_000
    purchasing_budget: float = 90_000
    safety_stock_days: int = 3
    storage_capacity_units: int = 2_000


class AnalysisRequest(BaseModel):
    use_seeded_demo: bool = True
    settings: BusinessSettings = Field(default_factory=BusinessSettings)


class SimulationRequest(BaseModel):
    analysis_run_id: str
    purchasing_budget: float | None = None
    minimum_cash_reserve: float | None = None
    supplier_lead_time_days: int | None = None
    demand_multiplier: float = 1.0
    payment_received: float = 0


class Evidence(BaseModel):
    id: str
    label: str
    value: str
    source: str


class SpecialistAssessment(BaseModel):
    specialist: str
    position: str
    evidence_ids: list[str]
    risks: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    confidence: float


class DailyAction(BaseModel):
    id: str
    action_type: Literal["reorder", "collection", "defer", "abstain"]
    title: str
    reason: str
    urgency: Literal["critical", "high", "medium", "low"]
    confidence: float
    financial_amount: float
    impact: str
    evidence_ids: list[str]
    requires_human_context: bool = False
    allowed_relationship_actions: list[str] = Field(default_factory=list)


class AnalysisResult(BaseModel):
    id: str
    status: AnalysisStatus
    snapshot_id: str
    warnings: list[str]
    forecasts: list[dict[str, Any]]
    anomalies: list[dict[str, Any]]
    inventory_metrics: list[dict[str, Any]]
    cashflow: dict[str, Any]
    optimizer: dict[str, Any]
    assessments: list[SpecialistAssessment]
    evidence: list[Evidence]
    actions: list[DailyAction]
    verifier: dict[str, Any]


class ApprovalRequest(BaseModel):
    relationship_action: Literal["friendly", "payment-date", "formal", "personal-call"] | None = None


class OutcomeRequest(BaseModel):
    action_id: str
    outcome_type: Literal["stockout_avoided", "payment_received", "purchase_avoided", "margin_protected", "other"]
    amount: float = Field(default=0, ge=0)
    notes: str = ""
