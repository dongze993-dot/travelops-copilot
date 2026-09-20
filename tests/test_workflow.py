from __future__ import annotations

from pathlib import Path

from app.crm import SQLiteTicketStore
from app.knowledge import LocalKnowledgeBase
from app.schemas import TravelPlanningRequest
from app.workflow import TravelOpsTools, TravelPlanningWorkflow


def build_workflow(tmp_path: Path) -> TravelPlanningWorkflow:
    tools = TravelOpsTools(LocalKnowledgeBase(), SQLiteTicketStore(tmp_path / "tickets.db"))
    return TravelPlanningWorkflow(tools)


def test_deterministic_plan_has_traceable_citations(tmp_path: Path) -> None:
    result = build_workflow(tmp_path).run(
        TravelPlanningRequest(
            destination="杭州",
            days=2,
            travelers=2,
            total_budget_cny=4000,
            interests=["人文", "自然"],
        )
    )

    assert len(result.itinerary) == 2
    assert result.citations
    assert result.validation.passed
    assert [entry.step for entry in result.workflow_trace] == [
        "parse",
        "retrieve",
        "plan",
        "validate",
        "finalize",
    ]


def test_low_budget_runs_at_most_one_revision(tmp_path: Path) -> None:
    result = build_workflow(tmp_path).run(
        TravelPlanningRequest(
            destination="杭州",
            days=2,
            travelers=2,
            total_budget_cny=100,
            interests=["体验"],
        )
    )

    assert result.validation.revision_count == 1
    assert [entry.step for entry in result.workflow_trace].count("revise_once") == 1
    assert result.validation.within_budget is False


def test_plan_can_create_mock_crm_follow_up_ticket(tmp_path: Path) -> None:
    workflow = build_workflow(tmp_path)
    result = workflow.run(
        TravelPlanningRequest(
            destination="上海",
            days=1,
            travelers=1,
            total_budget_cny=2000,
            create_follow_up_ticket=True,
            contact_name="测试用户",
        )
    )

    assert result.ticket is not None
    assert result.ticket.source_plan_id == result.plan_id
    assert workflow.tools.query_ticket(result.ticket.ticket_id).ticket_id == result.ticket.ticket_id
    assert workflow.tools.query_tickets(contact_name="测试用户")[0].ticket_id == result.ticket.ticket_id


def test_unknown_city_is_flagged_instead_of_using_another_citys_source(tmp_path: Path) -> None:
    result = build_workflow(tmp_path).run(
        TravelPlanningRequest(
            destination="不存在的演示城市",
            days=1,
            travelers=1,
            total_budget_cny=2000,
        )
    )

    assert result.citations == []
    assert result.validation.coverage_ok is False
    assert result.validation.revision_count == 1
