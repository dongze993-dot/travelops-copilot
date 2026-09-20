from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app


def test_health_and_attraction_search(tmp_path) -> None:
    client = TestClient(create_app(db_path=tmp_path / "crm.db"))

    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["mode"] == "deterministic_mock"

    response = client.get("/api/v1/attractions", params={"destination": "杭州", "interests": "人文,自然"})
    assert response.status_code == 200
    assert response.json()["items"]
    assert response.json()["citations"]

    unknown_city = client.get(
        "/api/v1/attractions", params={"destination": "不存在的演示城市"}
    )
    assert unknown_city.status_code == 200
    assert unknown_city.json()["items"] == []
    assert unknown_city.json()["citations"] == []


def test_plan_and_ticket_endpoints(tmp_path) -> None:
    client = TestClient(create_app(db_path=tmp_path / "crm.db"))
    plan = client.post(
        "/api/v1/plans",
        json={
            "destination": "杭州",
            "days": 2,
            "travelers": 2,
            "total_budget_cny": 4000,
            "interests": ["自然", "人文"],
            "create_follow_up_ticket": True,
        },
    )
    assert plan.status_code == 200
    body = plan.json()
    assert body["request_summary"]["mock_mode"] is True
    assert body["ticket"]["ticket_id"].startswith("TCK-")

    ticket = client.get(f"/api/v1/tickets/{body['ticket']['ticket_id']}")
    assert ticket.status_code == 200
    assert ticket.json()["source_plan_id"] == body["plan_id"]


def test_missing_ticket_returns_404(tmp_path) -> None:
    client = TestClient(create_app(db_path=tmp_path / "crm.db"))
    response = client.get("/api/v1/tickets/TCK-DOES-NOT-EXIST")
    assert response.status_code == 404
