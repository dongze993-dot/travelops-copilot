"""FastAPI entry point for the deterministic TravelOps Copilot demo."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import LLMSettings
from .crm import SQLiteTicketStore, TicketNotFoundError
from .knowledge import LocalKnowledgeBase
from .llm import DeepSeekNarrativeGenerator
from .schemas import (
    AttractionSearchResponse,
    HealthResponse,
    ModelAssistedPlanResponse,
    TicketCreateRequest,
    TicketRecord,
    TicketStatus,
    TravelPlanResponse,
    TravelPlanningRequest,
)
from .workflow import ModelEnhancedTravelPlanningWorkflow, TravelOpsTools, TravelPlanningWorkflow


def _default_db_path() -> Path:
    configured = os.getenv("TRAVELOPS_DB_PATH")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[1] / "runtime" / "travelops_mock_crm.db"


def create_app(
    *,
    db_path: str | Path | None = None,
    knowledge_path: str | Path | None = None,
    llm_settings: LLMSettings | None = None,
    llm_transport: httpx.BaseTransport | None = None,
) -> FastAPI:
    """Create an app instance; injectable paths keep integration tests isolated."""

    knowledge = LocalKnowledgeBase(knowledge_path)
    tickets = SQLiteTicketStore(db_path or _default_db_path())
    tools = TravelOpsTools(knowledge, tickets)
    workflow = TravelPlanningWorkflow(tools)
    settings = llm_settings or LLMSettings.from_environment()
    model_workflow = ModelEnhancedTravelPlanningWorkflow(
        tools,
        DeepSeekNarrativeGenerator(settings, transport=llm_transport),
    )

    app = FastAPI(
        title="TravelOps Copilot API",
        version="0.1.0",
        description=(
            "A controlled-data TravelOps proof of concept. v1 is deterministic; "
            "v2 can add a validated DeepSeek explanation without changing the "
            "deterministic budget, source, or mock-CRM controls. It is not a booking system "
            "and does not provide live travel advice."
        ),
    )
    app.state.knowledge = knowledge
    app.state.tickets = tickets
    app.state.workflow = workflow
    app.state.model_workflow = model_workflow

    # `check_dir=False` lets API-only tests instantiate the app before the
    # separately owned frontend files are present.
    frontend_dir = Path(__file__).resolve().parents[1] / "frontend"
    app.mount(
        "/frontend",
        StaticFiles(directory=str(frontend_dir), check_dir=False),
        name="frontend",
    )

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    def health() -> HealthResponse:
        return HealthResponse(knowledge_records=knowledge.record_count)

    @app.get("/api/v1/attractions", response_model=AttractionSearchResponse, tags=["knowledge"])
    def search_attractions(
        destination: Annotated[str, Query(min_length=1, max_length=80)],
        interests: str | None = Query(default=None, max_length=200),
        limit: Annotated[int, Query(ge=1, le=20)] = 8,
    ) -> AttractionSearchResponse:
        interest_list = [item.strip() for item in (interests or "").split(",") if item.strip()]
        records = knowledge.search(destination, interest_list, limit=limit)
        return AttractionSearchResponse(
            destination=destination,
            items=records,
            citations=knowledge.citations_for(records, interest_list),
        )

    # Versioned path is the public API. The unversioned alias keeps the static
    # demo front-end ergonomic without hiding the real contract from reviewers.
    @app.post("/api/v1/plans", response_model=TravelPlanResponse, tags=["planning"])
    @app.post("/api/plan", response_model=TravelPlanResponse, include_in_schema=False)
    def create_plan(request: TravelPlanningRequest) -> TravelPlanResponse:
        return workflow.run(request)

    @app.post(
        "/api/v2/plans",
        response_model=ModelAssistedPlanResponse,
        tags=["planning v2"],
    )
    def create_model_assisted_plan(request: TravelPlanningRequest) -> ModelAssistedPlanResponse:
        """Return a v1-compatible plan plus a guarded optional model explanation."""

        return model_workflow.run(request)

    @app.post("/api/v1/tickets", response_model=TicketRecord, status_code=201, tags=["mock crm"])
    @app.post("/api/tickets", response_model=TicketRecord, status_code=201, include_in_schema=False)
    def create_ticket(request: TicketCreateRequest) -> TicketRecord:
        return tickets.create_ticket(request)

    @app.get("/api/v1/tickets/{ticket_id}", response_model=TicketRecord, tags=["mock crm"])
    @app.get("/api/tickets/{ticket_id}", response_model=TicketRecord, include_in_schema=False)
    def get_ticket(ticket_id: str) -> TicketRecord:
        try:
            return tickets.get_ticket(ticket_id)
        except TicketNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Mock CRM ticket not found") from exc

    @app.get("/api/v1/tickets", response_model=list[TicketRecord], tags=["mock crm"])
    def query_tickets(
        status: TicketStatus | None = None,
        contact_name: str | None = Query(default=None, max_length=80),
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> list[TicketRecord]:
        return tickets.query_tickets(status=status, contact_name=contact_name, limit=limit)

    # The frontend is owned separately.  Serve it only when present so the API
    # also remains usable as a standalone package or in API-focused tests.
    @app.get("/", include_in_schema=False, response_model=None)
    def landing_page() -> FileResponse | dict[str, str]:
        index = frontend_dir / "index.html"
        if index.exists():
            return FileResponse(index)
        return {"message": "TravelOps Copilot API is running. Visit /docs for the API."}

    return app


app = create_app()
