import os

from fastapi.testclient import TestClient

os.environ["ADMIN_API_TOKEN"] = "test-admin-token"
os.environ["TENNIS_EDGE_DATA_MODE"] = "sample"
os.environ["TENNIS_EDGE_PERSISTENCE_ENABLED"] = "false"

from tennis_edge.config import get_settings

get_settings.cache_clear()

from tennis_edge.main import app
from tennis_edge.services.agent_ops import AGENT_RUNS
from tennis_edge.services.execution_engine import ORDERS
from tennis_edge.services.provider_cursor import CURSORS


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


def test_v1_enterprise_observability_endpoints() -> None:
    data_quality = client.get("/api/v1/data-quality")
    cursors = client.get("/api/v1/provider-cursors")
    operational_state = client.get("/api/v1/operational-state")
    registry = client.get("/api/v1/models/registry")
    champion = client.get("/api/v1/models/champion")
    conflicts = client.get("/api/v1/entity-resolution/conflicts")
    paper = client.get("/api/v1/paper/performance")

    assert data_quality.status_code == 200
    assert cursors.status_code == 200
    assert operational_state.status_code == 200
    assert registry.status_code == 200
    assert champion.status_code == 200
    assert conflicts.status_code == 200
    assert paper.status_code == 200
    assert any(item["provider"] == "odds_api_io" for item in cursors.json())
    assert operational_state.json()["cost_profile"]["active_plan"] == "lean_atp"
    assert operational_state.json()["daily_cost_report"]["active_plan"] == "lean_atp"
    assert operational_state.json()["daily_cost_report"]["estimated_monthly_spend_usd"] <= 500
    assert operational_state.json()["execution_status"]["can_submit_real_orders"] is False
    assert "ingestion_runs" in operational_state.json()
    assert champion.json()["model_version"] == "baseline_v0"


def test_v1_ingestion_run_requires_token_and_returns_operational_summary() -> None:
    unauthorized = client.post("/api/v1/ingestion/run", json={})
    response = client.post("/api/v1/ingestion/run", headers=ADMIN_HEADERS, json={})

    assert unauthorized.status_code == 401
    assert response.status_code == 200
    assert response.json()["source"] == "sample"
    assert response.json()["matches"] >= 1
    assert response.json()["raw_payloads_saved"] >= 1
    assert "signals_generated" in response.json()


def test_v1_ingestion_runs_endpoint_is_available() -> None:
    response = client.get("/api/v1/ingestion/runs")

    assert response.status_code == 200
    assert response.json() == []


def test_v1_odds_api_io_message_ingestion_requires_token_and_tracks_cursor() -> None:
    CURSORS.clear()
    payload = {
        "payload": {
            "event_id": "event-1",
            "seq": 1,
            "timestamp": "2026-06-07T20:00:00Z",
            "data": {
                "bookmaker": "SharpBook",
                "market": "h2h",
                "selections": [
                    {"player_id": "p1", "odds": 1.8},
                    {"player_id": "p2", "odds": 2.1},
                ],
            },
        }
    }

    unauthorized = client.post("/api/v1/ingestion/odds-api-io/message", json=payload)
    response = client.post(
        "/api/v1/ingestion/odds-api-io/message",
        headers=ADMIN_HEADERS,
        json=payload,
    )

    assert unauthorized.status_code == 401
    assert response.status_code == 200
    assert response.json()["quotes"] == 2
    assert response.json()["raw_payloads_saved"] == 0
    assert response.json()["normalized_odds_saved"] == 0
    assert response.json()["persisted"] is False
    assert response.json()["cursor"]["last_seq"] == 1
    assert response.json()["resync_required"] is False


def test_v1_provider_cursor_resync_requires_token_and_persists_status() -> None:
    unauthorized = client.post(
        "/api/v1/ingestion/provider-cursors/resync",
        json={"provider": "odds_api_io", "stream": "tennis:moneyline", "last_seq": 12},
    )
    response = client.post(
        "/api/v1/ingestion/provider-cursors/resync",
        headers=ADMIN_HEADERS,
        json={"provider": "odds_api_io", "stream": "tennis:moneyline", "last_seq": 12},
    )

    assert unauthorized.status_code == 401
    assert response.status_code == 200
    assert response.json()["cursor"]["status"] == "resynced"
    assert response.json()["cursor"]["last_seq"] == 12
    assert response.json()["cursor"]["expected_next_seq"] == 13
    assert response.json()["cursor"]["resync_required"] is False


def test_v1_agent_ops_endpoints_expose_openclaw_router() -> None:
    briefing = client.get("/api/v1/agent/briefing")
    anomalies = client.get("/api/v1/agent/anomalies")
    runs = client.get("/api/v1/agent/runs")
    preflight = client.get("/api/v1/agent/preflight")

    assert briefing.status_code == 200
    assert anomalies.status_code == 200
    assert runs.status_code == 200
    assert preflight.status_code == 200
    assert briefing.json()["critical_model"] == "gpt-5.5"
    assert "create_paper_order" in briefing.json()["allowed_actions"]
    assert isinstance(anomalies.json(), list)
    assert "real_execution_hard_block" in {check["name"] for check in preflight.json()["checks"]}


def test_v1_agent_autopilot_requires_token() -> None:
    response = client.post("/api/v1/agent/autopilot/evaluate", json={})

    assert response.status_code == 401


def test_v1_agent_autopilot_creates_paper_orders_and_blocks_real_request() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()

    first = client.post(
        "/api/v1/agent/autopilot/evaluate",
        headers=ADMIN_HEADERS,
        json={
            "source": "openclaw",
            "create_paper_orders": True,
            "request_real_execution": True,
            "max_paper_orders": 2,
        },
    )
    second = client.post(
        "/api/v1/agent/autopilot/evaluate",
        headers=ADMIN_HEADERS,
        json={"source": "openclaw", "create_paper_orders": True, "max_paper_orders": 2},
    )
    orders = client.get("/api/v1/orders")
    runs = client.get("/api/v1/agent/runs")

    assert first.status_code == 200
    assert first.json()["paper_orders_created"] >= 1
    assert first.json()["real_execution_blocked"] is True
    assert any(action["status"] == "blocked" for action in first.json()["run"]["actions"])
    assert second.status_code == 200
    assert second.json()["paper_orders_skipped"] >= 1
    assert orders.status_code == 200
    assert all(order["status"] == "paper" for order in orders.json())
    assert runs.status_code == 200
    assert runs.json()[0]["model_routes"][-1]["model"] == "gpt-5.5"


def test_v1_replay_and_backtest() -> None:
    replay = client.post(
        "/api/v1/replay/run",
        headers=ADMIN_HEADERS,
        json={"match_id": "match_atp_002"},
    )
    backtest = client.post(
        "/api/v1/backtests/run",
        headers=ADMIN_HEADERS,
        json={"model_version": "prematch_ensemble_v1", "feature_set": "enterprise_v1"},
    )
    calibration = client.get(f"/api/v1/backtests/{backtest.json()['run_id']}/calibration")

    assert replay.status_code == 200
    assert replay.json()["events_replayed"] >= 1
    assert backtest.status_code == 200
    assert "brier_score" in backtest.json()
    assert calibration.status_code == 200
    assert calibration.json()["buckets"]


def test_v1_execution_endpoints_are_safe_by_default() -> None:
    status = client.get("/api/v1/execution/status")
    bankroll = client.get("/api/v1/bankroll")
    signals = client.get("/api/v1/signals/live").json()
    entry = next(signal for signal in signals if signal["status"] == "Entrada")
    paper = client.post(
        "/api/v1/orders/paper",
        headers=ADMIN_HEADERS,
        json={"signal_id": entry["id"]},
    )
    submit = client.post(
        "/api/v1/orders/submit",
        headers=ADMIN_HEADERS,
        json={"signal_id": entry["id"]},
    )
    orders = client.get("/api/v1/orders")

    assert status.status_code == 200
    assert status.json()["can_submit_real_orders"] is False
    assert status.json()["real_execution_hard_block"] is True
    assert bankroll.status_code == 200
    assert bankroll.json()["execution_stage"] == "paper"
    assert paper.status_code == 200
    assert paper.json()["status"] == "paper"
    assert paper.json()["matched_stake"] > 0
    assert submit.status_code == 200
    assert submit.json()["status"] == "execution_blocked"
    assert orders.status_code == 200
    assert len(orders.json()) >= 2


def test_v1_learning_promotion_rejects_bad_candidate() -> None:
    response = client.post(
        "/api/v1/models/promote-from-learning",
        headers=ADMIN_HEADERS,
        json={
            "candidate_model_version": "bad_candidate",
            "roi": 0.04,
            "clv": -0.01,
            "brier_score": 0.21,
            "log_loss": 0.6,
            "calibration_error": 0.03,
            "max_drawdown": 0.22,
        },
    )

    assert response.status_code == 200
    assert response.json()["promoted"] is False
    assert "CLV" in " ".join(response.json()["reasons"])


def test_operational_endpoints_require_token() -> None:
    response = client.post("/api/v1/replay/run", json={"match_id": "match_atp_002"})

    assert response.status_code == 401


def test_execution_submit_requires_token() -> None:
    response = client.post("/api/v1/orders/submit", json={"signal_id": "missing"})

    assert response.status_code == 401


def test_paper_settlement_requires_token_and_updates_performance() -> None:
    signals = client.get("/api/v1/signals/live").json()
    entry = next(signal for signal in signals if signal["status"] == "Entrada")
    paper = client.post(
        "/api/v1/orders/paper",
        headers=ADMIN_HEADERS,
        json={"signal_id": entry["id"]},
    ).json()

    unauthorized = client.post(
        "/api/v1/paper/settle",
        json={"order_id": paper["id"], "result_win": True, "closing_odds": paper["requested_odds"]},
    )
    settlement = client.post(
        "/api/v1/paper/settle",
        headers=ADMIN_HEADERS,
        json={"order_id": paper["id"], "result_win": True, "closing_odds": paper["requested_odds"] - 0.02},
    )
    performance = client.get("/api/v1/paper/performance")

    assert unauthorized.status_code == 401
    assert settlement.status_code == 200
    assert settlement.json()["status"] == "settled"
    assert performance.json()["settled_orders"] >= 1
    assert performance.json()["segments"]
    assert {segment["segment_type"] for segment in performance.json()["segments"]} >= {
        "model",
        "odds_bucket",
        "provider",
    }


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
