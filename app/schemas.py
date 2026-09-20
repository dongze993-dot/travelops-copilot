"""Request and response contracts for the TravelOps Copilot API."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


TravelStyle = Literal["budget", "balanced", "comfort"]
TicketPriority = Literal["low", "normal", "high"]
TicketStatus = Literal["open", "in_progress", "resolved"]


class APIModel(BaseModel):
    """Common Pydantic settings for public API models."""

    model_config = ConfigDict(str_strip_whitespace=True)


class TravelPlanningRequest(APIModel):
    """A bounded planning request, designed for an offline proof of concept."""

    destination: str = Field(..., min_length=1, max_length=80, examples=["杭州"])
    days: int = Field(..., ge=1, le=14, examples=[2])
    travelers: int = Field(1, ge=1, le=10, examples=[2])
    total_budget_cny: float = Field(..., gt=0, le=100_000, examples=[3000])
    interests: list[str] = Field(
        default_factory=list,
        max_length=8,
        examples=[["自然", "美食", "人文"]],
    )
    travel_style: TravelStyle = "balanced"
    start_date: date | None = None
    notes: str | None = Field(default=None, max_length=500)
    create_follow_up_ticket: bool = False
    contact_name: str | None = Field(default=None, max_length=80)

    @field_validator("destination")
    @classmethod
    def destination_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("destination must not be blank")
        return value.strip()

    @field_validator("interests")
    @classmethod
    def normalize_interests(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        for value in values:
            item = value.strip()
            if item and item not in normalized:
                normalized.append(item)
        return normalized


class Citation(APIModel):
    """A traceable local-data citation returned with a plan."""

    source_id: str
    title: str
    uri: str
    excerpt: str
    relevance: str


class Attraction(APIModel):
    """A normalized attraction record loaded from the local knowledge file."""

    id: str
    name: str
    city: str
    category: str
    summary: str
    price_cny: float = Field(ge=0)
    hours: str = "请以实际营业信息为准"
    tags: list[str] = Field(default_factory=list)
    source_title: str = "本地示例资料"
    source_url: str = "data/attractions.json"


class ItineraryItem(APIModel):
    slot: str
    title: str
    description: str
    estimated_duration_minutes: int = Field(ge=0)
    estimated_cost_cny: float = Field(ge=0)
    source_id: str


class DayItinerary(APIModel):
    day: int = Field(ge=1)
    theme: str
    items: list[ItineraryItem] = Field(min_length=1)


class BudgetLineItem(APIModel):
    category: str
    amount_cny: float = Field(ge=0)
    assumption: str


class BudgetBreakdown(APIModel):
    currency: Literal["CNY"] = "CNY"
    budget_cap_cny: float = Field(gt=0)
    line_items: list[BudgetLineItem]
    estimated_total_cny: float = Field(ge=0)
    remaining_cny: float


class ValidationResult(APIModel):
    passed: bool
    within_budget: bool
    coverage_ok: bool
    issues: list[str] = Field(default_factory=list)
    revision_count: int = Field(ge=0, le=1)


class WorkflowTraceEntry(APIModel):
    step: Literal[
        "parse",
        "retrieve",
        "plan",
        "validate",
        "revise_once",
        "finalize",
    ]
    status: Literal["completed", "warning"]
    detail: str


class TicketCreateRequest(APIModel):
    title: str = Field(..., min_length=3, max_length=160)
    description: str = Field(..., min_length=3, max_length=2_000)
    contact_name: str | None = Field(default=None, max_length=80)
    priority: TicketPriority = "normal"
    source_plan_id: str | None = Field(default=None, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)


class TicketRecord(TicketCreateRequest):
    ticket_id: str
    status: TicketStatus = "open"
    created_at: datetime
    updated_at: datetime


class PlanRequestSummary(APIModel):
    destination: str
    days: int
    travelers: int
    interests: list[str]
    travel_style: TravelStyle
    mock_mode: bool = True


class TravelPlanResponse(APIModel):
    plan_id: str
    request_summary: PlanRequestSummary
    itinerary: list[DayItinerary]
    budget: BudgetBreakdown
    citations: list[Citation]
    validation: ValidationResult
    workflow_trace: list[WorkflowTraceEntry]
    ticket: TicketRecord | None = None


class HealthResponse(APIModel):
    status: Literal["ok"] = "ok"
    mode: Literal["deterministic_mock"] = "deterministic_mock"
    knowledge_records: int = Field(ge=0)


class AttractionSearchResponse(APIModel):
    destination: str
    items: list[Attraction]
    citations: list[Citation]
