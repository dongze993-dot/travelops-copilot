"""LangGraph workflow for a deterministic travel-planning proof of concept.

The graph is intentionally transparent: parse -> retrieve -> plan -> validate
-> (optionally revise once) -> finalize.  It models the control flow commonly
used in LLM applications, while the mock implementation remains repeatable and
does not make claims about live inventory or booking availability.
"""

from __future__ import annotations

from collections.abc import Iterable
from math import ceil
from typing import Any, Literal
from uuid import uuid4

from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict

from .crm import SQLiteTicketStore
from .knowledge import LocalKnowledgeBase
from .llm import DeepSeekNarrativeGenerator
from .schemas import (
    Attraction,
    BudgetBreakdown,
    BudgetLineItem,
    Citation,
    DayItinerary,
    GenerationMetadata,
    ItineraryItem,
    LLMTravelNarrative,
    ModelAssistedPlanResponse,
    PlanRequestSummary,
    TicketCreateRequest,
    TicketRecord,
    TicketStatus,
    TravelPlanResponse,
    TravelPlanningRequest,
    ValidationResult,
    WorkflowTraceEntry,
)


class PlanningState(TypedDict, total=False):
    request: dict[str, Any]
    parsed: dict[str, Any]
    retrieved: list[dict[str, Any]]
    citations: list[dict[str, Any]]
    itinerary: list[dict[str, Any]]
    budget: dict[str, Any]
    validation: dict[str, Any]
    revision_count: int
    trace: list[dict[str, Any]]
    plan_id: str
    ticket: dict[str, Any] | None
    generation: dict[str, Any]
    narrative: dict[str, Any] | None


_STYLE_COSTS: dict[str, dict[str, int]] = {
    "budget": {"room_per_night": 150, "food_per_day": 75},
    "balanced": {"room_per_night": 260, "food_per_day": 110},
    "comfort": {"room_per_night": 420, "food_per_day": 170},
}


def calculate_budget(
    *,
    selected_attractions: Iterable[Attraction],
    days: int,
    travelers: int,
    total_budget_cny: float,
    travel_style: Literal["budget", "balanced", "comfort"],
) -> BudgetBreakdown:
    """Calculate a reproducible in-city estimate from explicit assumptions.

    It deliberately excludes intercity transport and booking inventory.  The
    resulting line-item assumptions make that scope visible in API output and
    allow a reviewer to challenge or change each number.
    """

    style_costs = _STYLE_COSTS[travel_style]
    rooms = ceil(travelers / 2)
    attraction_total = round(sum(item.price_cny for item in selected_attractions) * travelers, 2)
    lodging = float(style_costs["room_per_night"] * rooms * days)
    food = float(style_costs["food_per_day"] * travelers * days)
    local_transport = float(max(days - 1, 0) * 25 * travelers + 15 * travelers)
    pre_contingency = attraction_total + lodging + food + local_transport
    contingency = round(pre_contingency * 0.08, 2)
    estimated_total = round(pre_contingency + contingency, 2)

    line_items = [
        BudgetLineItem(
            category="景点与体验",
            amount_cny=attraction_total,
            assumption="按每位旅客参与所选本地示例点位估算",
        ),
        BudgetLineItem(
            category="住宿",
            amount_cny=lodging,
            assumption=f"{rooms} 间房 × {days} 晚 × {style_costs['room_per_night']} 元（{travel_style} 示例标准）",
        ),
        BudgetLineItem(
            category="餐饮",
            amount_cny=food,
            assumption=f"{travelers} 人 × {days} 天 × {style_costs['food_per_day']} 元（示例标准）",
        ),
        BudgetLineItem(
            category="市内交通",
            amount_cny=local_transport,
            assumption="示例地铁/打车组合，不含抵离目的地的大交通",
        ),
        BudgetLineItem(
            category="预留金",
            amount_cny=contingency,
            assumption="以上可见成本的 8%",
        ),
    ]
    return BudgetBreakdown(
        budget_cap_cny=round(total_budget_cny, 2),
        line_items=line_items,
        estimated_total_cny=estimated_total,
        remaining_cny=round(total_budget_cny - estimated_total, 2),
    )


class TravelOpsTools:
    """Tool layer used by the graph and directly testable outside the graph."""

    def __init__(self, knowledge: LocalKnowledgeBase, tickets: SQLiteTicketStore) -> None:
        self.knowledge = knowledge
        self.tickets = tickets

    def lookup_attractions(
        self, destination: str, interests: Iterable[str], *, limit: int = 8
    ) -> list[Attraction]:
        return self.knowledge.search(destination, interests, limit=limit)

    def create_ticket(self, payload: TicketCreateRequest) -> TicketRecord:
        return self.tickets.create_ticket(payload)

    def query_ticket(self, ticket_id: str) -> TicketRecord:
        return self.tickets.get_ticket(ticket_id)

    def query_tickets(
        self,
        *,
        status: TicketStatus | None = None,
        contact_name: str | None = None,
        limit: int = 20,
    ) -> list[TicketRecord]:
        return self.tickets.query_tickets(
            status=status,
            contact_name=contact_name,
            limit=limit,
        )


class TravelPlanningWorkflow:
    """A deterministic LangGraph workflow with one bounded revision pass."""

    def __init__(self, tools: TravelOpsTools) -> None:
        self.tools = tools
        self.graph = self._build_graph()

    @staticmethod
    def _trace(
        state: PlanningState,
        step: Literal[
            "parse",
            "retrieve",
            "plan",
            "validate",
            "revise_once",
            "augment_with_llm",
            "finalize",
        ],
        detail: str,
        *,
        warning: bool = False,
    ) -> list[dict[str, Any]]:
        trace = list(state.get("trace", []))
        trace.append(
            WorkflowTraceEntry(
                step=step,
                status="warning" if warning else "completed",
                detail=detail,
            ).model_dump(mode="json")
        )
        return trace

    @staticmethod
    def _normalise_request(request: TravelPlanningRequest) -> dict[str, Any]:
        return {
            "destination": request.destination,
            "days": request.days,
            "travelers": request.travelers,
            "total_budget_cny": request.total_budget_cny,
            "interests": request.interests,
            "travel_style": request.travel_style,
            "start_date": request.start_date.isoformat() if request.start_date else None,
            "notes": request.notes,
            "create_follow_up_ticket": request.create_follow_up_ticket,
            "contact_name": request.contact_name,
        }

    def _parse_request(self, state: PlanningState) -> dict[str, Any]:
        request = state["request"]
        interests = list(request.get("interests") or [])
        if not interests:
            interests = ["城市漫游", "人文"]
        parsed = {
            **request,
            "interests": interests,
            "planning_scope": "本地示例资料与市内预算；不包含真实预订或实时价格",
        }
        return {
            "parsed": parsed,
            "trace": self._trace(
                state,
                "parse",
                f"已标准化 {parsed['destination']}、{parsed['days']} 天、{parsed['travelers']} 位旅客的需求。",
            ),
        }

    def _retrieve(self, state: PlanningState) -> dict[str, Any]:
        parsed = state["parsed"]
        records = self.tools.lookup_attractions(
            parsed["destination"], parsed["interests"], limit=max(4, parsed["days"] * 3)
        )
        citations = self.tools.knowledge.citations_for(records, parsed["interests"])
        no_exact_city_match = not any(
            parsed["destination"].lower() in record.city.lower()
            or record.city.lower() in parsed["destination"].lower()
            for record in records
        )
        detail = f"从本地资料检索到 {len(records)} 个可引用点位。"
        if no_exact_city_match:
            detail += " 未找到同城资料，已停止生成无来源的候选点位。"
        return {
            "retrieved": [record.model_dump(mode="json") for record in records],
            "citations": [citation.model_dump(mode="json") for citation in citations],
            "trace": self._trace(state, "retrieve", detail, warning=no_exact_city_match),
        }

    @staticmethod
    def _select_attractions(
        records: list[Attraction], days: int, *, conservative: bool = False
    ) -> list[Attraction]:
        if not records:
            return []
        desired_count = min(len(records), max(days, days * (1 if conservative else 2)))
        ordered = sorted(records, key=lambda item: (item.price_cny, item.id)) if conservative else records
        selected = list(ordered[:desired_count])
        # A sparse local catalogue may have fewer records than requested days.
        # Repeating the chosen point makes the matching itinerary cost visible
        # instead of silently undercounting a repeated day.
        while len(selected) < days:
            selected.append(ordered[len(selected) % len(ordered)])
        return selected

    @staticmethod
    def _make_itinerary(
        selected: list[Attraction], days: int, *, conservative: bool = False
    ) -> list[DayItinerary]:
        if not selected:
            return [
                DayItinerary(
                    day=day,
                    theme="自由活动与人工确认",
                    items=[
                        ItineraryItem(
                            slot="全天",
                            title="待人工确认的本地活动",
                            description="本地资料未返回可引用点位，建议人工补充后再生成行程。",
                            estimated_duration_minutes=180,
                            estimated_cost_cny=0,
                            source_id="manual-review",
                        )
                    ],
                )
                for day in range(1, days + 1)
            ]

        itinerary: list[DayItinerary] = []
        for day in range(1, days + 1):
            day_records = [
                attraction
                for index, attraction in enumerate(selected)
                if index % days == day - 1
            ]
            if not day_records:
                day_records = [selected[(day - 1) % len(selected)]]
            items: list[ItineraryItem] = []
            for index, attraction in enumerate(day_records):
                slot = ("上午", "下午", "傍晚")[min(index, 2)]
                items.append(
                    ItineraryItem(
                        slot=slot,
                        title=attraction.name,
                        description=(
                            f"{attraction.summary}（{'预算优先的修订建议' if conservative else '初版建议'}）"
                        ),
                        estimated_duration_minutes=120 if index < 2 else 90,
                        estimated_cost_cny=attraction.price_cny,
                        source_id=attraction.id,
                    )
                )
            itinerary.append(
                DayItinerary(
                    day=day,
                    theme=f"{day_records[0].category}主题（第 {day} 天）",
                    items=items,
                )
            )
        return itinerary

    def _build_candidate(
        self, state: PlanningState, *, conservative: bool = False
    ) -> tuple[list[DayItinerary], BudgetBreakdown]:
        parsed = state["parsed"]
        records = [Attraction.model_validate(record) for record in state.get("retrieved", [])]
        selected = self._select_attractions(records, parsed["days"], conservative=conservative)
        itinerary = self._make_itinerary(selected, parsed["days"], conservative=conservative)
        budget = calculate_budget(
            selected_attractions=selected,
            days=parsed["days"],
            travelers=parsed["travelers"],
            total_budget_cny=parsed["total_budget_cny"],
            travel_style="budget" if conservative else parsed["travel_style"],
        )
        return itinerary, budget

    def _plan(self, state: PlanningState) -> dict[str, Any]:
        itinerary, budget = self._build_candidate(state)
        return {
            "itinerary": [day.model_dump(mode="json") for day in itinerary],
            "budget": budget.model_dump(mode="json"),
            "trace": self._trace(state, "plan", "已生成初版日程和逐项预算估算。"),
        }

    def _validate(self, state: PlanningState) -> dict[str, Any]:
        parsed = state["parsed"]
        budget = BudgetBreakdown.model_validate(state["budget"])
        itinerary = [DayItinerary.model_validate(day) for day in state["itinerary"]]
        issues: list[str] = []
        within_budget = budget.remaining_cny >= 0
        if not within_budget:
            issues.append(
                f"初版估算超出预算 {abs(budget.remaining_cny):.2f} 元，触发一次预算优先修订。"
            )
        has_retrieved_sources = bool(state.get("retrieved"))
        coverage_ok = (
            len(itinerary) == parsed["days"]
            and all(day.items for day in itinerary)
            and has_retrieved_sources
        )
        if not coverage_ok:
            issues.append("行程未覆盖所有天数、存在空日程，或缺少同城可引用资料；需要人工确认。")
        validation = ValidationResult(
            passed=within_budget and coverage_ok,
            within_budget=within_budget,
            coverage_ok=coverage_ok,
            issues=issues,
            revision_count=state.get("revision_count", 0),
        )
        detail = "预算与日程覆盖校验通过。" if validation.passed else "发现可修订的预算或覆盖问题。"
        return {
            "validation": validation.model_dump(mode="json"),
            "trace": self._trace(state, "validate", detail, warning=not validation.passed),
        }

    @staticmethod
    def _route_after_validation(state: PlanningState) -> Literal["revise_once", "finalize"]:
        validation = ValidationResult.model_validate(state["validation"])
        if not validation.passed and state.get("revision_count", 0) < 1:
            return "revise_once"
        return "finalize"

    def _revise_once(self, state: PlanningState) -> dict[str, Any]:
        itinerary, budget = self._build_candidate(state, conservative=True)
        parsed = state["parsed"]
        coverage_ok = (
            len(itinerary) == parsed["days"]
            and all(day.items for day in itinerary)
            and bool(state.get("retrieved"))
        )
        within_budget = budget.remaining_cny >= 0
        issues: list[str] = []
        if not within_budget:
            issues.append(
                "在一次预算优先修订后，住宿、餐饮和市内交通的示例基础成本仍超过预算；请提高预算或减少天数/人数。"
            )
        if not coverage_ok:
            issues.append("修订后仍缺少完整日程，需人工补充资料。")
        validation = ValidationResult(
            passed=within_budget and coverage_ok,
            within_budget=within_budget,
            coverage_ok=coverage_ok,
            issues=issues,
            revision_count=1,
        )
        return {
            "itinerary": [day.model_dump(mode="json") for day in itinerary],
            "budget": budget.model_dump(mode="json"),
            "validation": validation.model_dump(mode="json"),
            "revision_count": 1,
            "trace": self._trace(
                state,
                "revise_once",
                "已按低价点位和 budget 示例标准完成唯一一次修订。",
                warning=not validation.passed,
            ),
        }

    def _finalize(self, state: PlanningState) -> dict[str, Any]:
        plan_id = state.get("plan_id") or f"PLAN-{uuid4().hex[:10].upper()}"
        ticket: TicketRecord | None = None
        parsed = state["parsed"]
        if parsed.get("create_follow_up_ticket"):
            validation = ValidationResult.model_validate(state["validation"])
            ticket = self.tools.create_ticket(
                TicketCreateRequest(
                    title=f"行程方案跟进：{parsed['destination']} {parsed['days']} 天",
                    description=(
                        "由 TravelOps Copilot 自动创建的模拟 CRM 跟进工单。"
                        f"预算估算：{BudgetBreakdown.model_validate(state['budget']).estimated_total_cny:.2f} 元；"
                        f"校验结果：{'通过' if validation.passed else '需人工确认'}。"
                    ),
                    contact_name=parsed.get("contact_name"),
                    priority="high" if not validation.passed else "normal",
                    source_plan_id=plan_id,
                    metadata={
                        "destination": parsed["destination"],
                        "days": parsed["days"],
                        "workflow": "deterministic_mock",
                    },
                )
            )
        detail = "已输出可引用的方案。"
        if ticket:
            detail += f" 已创建模拟 CRM 工单 {ticket.ticket_id}。"
        return {
            "plan_id": plan_id,
            "ticket": ticket.model_dump(mode="json") if ticket else None,
            "trace": self._trace(state, "finalize", detail),
        }

    def _build_graph(self) -> Any:
        graph = StateGraph(PlanningState)
        graph.add_node("parse_request", self._parse_request)
        graph.add_node("retrieve", self._retrieve)
        graph.add_node("plan", self._plan)
        graph.add_node("validate", self._validate)
        graph.add_node("revise_once", self._revise_once)
        graph.add_node("finalize", self._finalize)
        graph.add_edge(START, "parse_request")
        graph.add_edge("parse_request", "retrieve")
        graph.add_edge("retrieve", "plan")
        graph.add_edge("plan", "validate")
        graph.add_conditional_edges(
            "validate",
            self._route_after_validation,
            {"revise_once": "revise_once", "finalize": "finalize"},
        )
        graph.add_edge("revise_once", "finalize")
        graph.add_edge("finalize", END)
        return graph.compile()

    def run(self, request: TravelPlanningRequest) -> TravelPlanResponse:
        """Run the full deterministic graph and return a typed response."""

        initial: PlanningState = {
            "request": self._normalise_request(request),
            "revision_count": 0,
            "trace": [],
        }
        result = self.graph.invoke(initial)
        parsed = result["parsed"]
        return TravelPlanResponse(
            plan_id=result["plan_id"],
            request_summary=PlanRequestSummary(
                destination=parsed["destination"],
                days=parsed["days"],
                travelers=parsed["travelers"],
                interests=parsed["interests"],
                travel_style=parsed["travel_style"],
            ),
            itinerary=[DayItinerary.model_validate(item) for item in result["itinerary"]],
            budget=BudgetBreakdown.model_validate(result["budget"]),
            citations=[Citation.model_validate(item) for item in result["citations"]],
            validation=ValidationResult.model_validate(result["validation"]),
            workflow_trace=[WorkflowTraceEntry.model_validate(item) for item in result["trace"]],
            ticket=TicketRecord.model_validate(result["ticket"]) if result.get("ticket") else None,
        )


class ModelEnhancedTravelPlanningWorkflow(TravelPlanningWorkflow):
    """A v2 path that adds a guarded model explanation after deterministic checks.

    The v1 graph is intentionally left unchanged so its existing contract suite
    remains a stable baseline. This graph reuses the same deterministic search,
    budget, validation, and mock-CRM steps, then optionally asks a provider to
    explain the already-validated candidate.
    """

    def __init__(self, tools: TravelOpsTools, generator: DeepSeekNarrativeGenerator) -> None:
        self.generator = generator
        super().__init__(tools)

    @staticmethod
    def _route_after_validation_v2(
        state: PlanningState,
    ) -> Literal["revise_once", "augment_with_llm"]:
        validation = ValidationResult.model_validate(state["validation"])
        if not validation.passed and state.get("revision_count", 0) < 1:
            return "revise_once"
        return "augment_with_llm"

    def _augment_with_llm(self, state: PlanningState) -> dict[str, Any]:
        validation = ValidationResult.model_validate(state["validation"])
        records = [Attraction.model_validate(record) for record in state.get("retrieved", [])]
        itinerary = [DayItinerary.model_validate(day) for day in state["itinerary"]]

        if not records:
            result = self.generator.skip("knowledge_empty")
        elif not validation.passed:
            result = self.generator.skip("validation_not_passed")
        else:
            result = self.generator.generate(
                parsed_request=state["parsed"],
                records=records,
                itinerary=itinerary,
            )

        if result.narrative:
            detail = "已生成模型说明，并完成 JSON 结构与来源白名单校验。"
            warning = False
        else:
            detail = (
                "未采用模型说明，保留可复现的确定性结果"
                f"（{result.metadata.fallback_code or 'deterministic'}）。"
            )
            warning = result.metadata.mode == "deterministic_fallback"
        return {
            "narrative": result.narrative.model_dump(mode="json") if result.narrative else None,
            "generation": result.metadata.model_dump(mode="json"),
            "trace": self._trace(state, "augment_with_llm", detail, warning=warning),
        }

    def _build_graph(self) -> Any:
        graph = StateGraph(PlanningState)
        graph.add_node("parse_request", self._parse_request)
        graph.add_node("retrieve", self._retrieve)
        graph.add_node("plan", self._plan)
        graph.add_node("validate", self._validate)
        graph.add_node("revise_once", self._revise_once)
        graph.add_node("augment_with_llm", self._augment_with_llm)
        graph.add_node("finalize", self._finalize)
        graph.add_edge(START, "parse_request")
        graph.add_edge("parse_request", "retrieve")
        graph.add_edge("retrieve", "plan")
        graph.add_edge("plan", "validate")
        graph.add_conditional_edges(
            "validate",
            self._route_after_validation_v2,
            {"revise_once": "revise_once", "augment_with_llm": "augment_with_llm"},
        )
        graph.add_edge("revise_once", "augment_with_llm")
        graph.add_edge("augment_with_llm", "finalize")
        graph.add_edge("finalize", END)
        return graph.compile()

    def run(self, request: TravelPlanningRequest) -> ModelAssistedPlanResponse:
        """Run the v2 graph and expose only validated model metadata/output."""

        initial: PlanningState = {
            "request": self._normalise_request(request),
            "revision_count": 0,
            "trace": [],
        }
        result = self.graph.invoke(initial)
        parsed = result["parsed"]
        return ModelAssistedPlanResponse(
            plan_id=result["plan_id"],
            request_summary=PlanRequestSummary(
                destination=parsed["destination"],
                days=parsed["days"],
                travelers=parsed["travelers"],
                interests=parsed["interests"],
                travel_style=parsed["travel_style"],
            ),
            itinerary=[DayItinerary.model_validate(item) for item in result["itinerary"]],
            budget=BudgetBreakdown.model_validate(result["budget"]),
            citations=[Citation.model_validate(item) for item in result["citations"]],
            validation=ValidationResult.model_validate(result["validation"]),
            workflow_trace=[WorkflowTraceEntry.model_validate(item) for item in result["trace"]],
            ticket=TicketRecord.model_validate(result["ticket"]) if result.get("ticket") else None,
            generation=GenerationMetadata.model_validate(result["generation"]),
            narrative=(
                LLMTravelNarrative.model_validate(result["narrative"])
                if result.get("narrative")
                else None
            ),
        )
