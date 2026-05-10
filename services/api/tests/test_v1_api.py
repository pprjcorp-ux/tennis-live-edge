import os

from fastapi.testclient import TestClient

os.environ["ADMIN_API_TOKEN"] = "test-admin-token"

from tennis_edge.config import get_settings

get_settings.cache_clear()

from tennis_edge.main import app


client = TestClient(app)
ADMIN_HEADERS = {"x-admin-token": "test-admin-token"}


def test_v1_live_matches_and_provider_health() -> None:
    matches = client.get("/api/v1/live/matches")
    health = client.get("/api/v1/provider-health")
    cost_profile = client.get("/api/v1/cost-profile")
    cost_report = client.get("/api/v1/cost-report/daily")

    assert matches.status_code == 200
    assert health.status_code == 200
    assert cost_profile.status_code == 200
    assert cost_report.status_code == 200
    assert len(matches.json()) >= 1
    assert {item["provider"] for item in health.json()} >= {"sportradar", "txodds"}
    assert all("cost_tier" in item for item in health.json())
    assert cost_profile.json()["active_plan"] == "lean_atp"
    assert cost_report.json()["estimated_monthly_spend_usd"] <= 500


def test_v1_replay_and_backtest() -> None:
    replay = client.post(
        "/api/v1/replay/run",
        headers=ADMIN_HEADERS,
        json={"match_id": "match_atp_002"},
    )
    backtest = client.post("/api/v1/backtests/run", headers=ADMIN_HEADERS)

    assert replay.status_code == 200
    assert replay.json()["events_replayed"] >= 1
    assert backtest.status_code == 200
    assert "brier_score" in backtest.json()


def test_operational_endpoints_require_token() -> None:
    response = client.post("/api/v1/replay/run", json={"match_id": "match_atp_002"})

    assert response.status_code == 401


def test_unknown_backtest_returns_404() -> None:
    response = client.get("/api/v1/backtests/missing-run")

    assert response.status_code == 404


def test_admin_model_promotion_allows_local_token() -> None:
    client.post("/api/v1/backtests/run", headers=ADMIN_HEADERS)
    response = client.post(
        "/api/v1/admin/model/promote",
        headers=ADMIN_HEADERS,
    )

    assert response.status_code == 200
    assert response.json()["promoted"] is True
