from tennis_edge.config import Settings
from tennis_edge.domain import ExecutionStage, ExecutionStatus, ExecutionVenue, Provider, ProviderHealth
from tennis_edge.services.agent_ops import build_agent_preflight


def _execution_status(*, hard_block: bool = True) -> ExecutionStatus:
    return ExecutionStatus(
        execution_enabled=False,
        venue=ExecutionVenue.BETFAIR,
        stage=ExecutionStage.PAPER,
        betfair_configured=False,
        betfair_live_key_approved=False,
        real_execution_hard_block=hard_block,
        kill_switch_enabled=False,
        can_submit_real_orders=False,
        reasons=["paper-first"],
    )


def test_agent_preflight_reports_ready_when_safety_and_gateway_are_healthy() -> None:
    preflight = build_agent_preflight(
        Settings(
            data_mode="live",
            admin_api_token="local-admin",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
            api_tennis_key="api-tennis",
            odds_api_io_key="odds-api-io",
            the_odds_api_key="the-odds-api",
        ),
        provider_health=[],
        execution_status=_execution_status(),
        persistence_last_error=None,
        gateway_probe=lambda: True,
    )

    assert preflight.status == "ready"
    assert {check.name: check.status for check in preflight.checks}["openclaw_gateway"] == "pass"
    assert {check.name: check.status for check in preflight.checks}["real_execution_hard_block"] == "pass"


def test_agent_preflight_blocks_live_mode_when_database_url_is_missing() -> None:
    preflight = build_agent_preflight(
        Settings(
            data_mode="live",
            admin_api_token="local-admin",
            persistence_enabled=True,
            database_url=None,
            api_tennis_key="api-tennis",
            odds_api_io_key="odds-api-io",
            the_odds_api_key="the-odds-api",
        ),
        provider_health=[],
        execution_status=_execution_status(),
        persistence_last_error=None,
        gateway_probe=lambda: True,
    )

    statuses = {check.name: check.status for check in preflight.checks}

    assert preflight.status == "blocked"
    assert statuses["persistence"] == "fail"


def test_agent_preflight_degrades_for_missing_keys_gateway_and_persistence() -> None:
    preflight = build_agent_preflight(
        Settings(data_mode="live", persistence_enabled=True, admin_api_token=None),
        provider_health=[
            ProviderHealth(
                provider=Provider.API_TENNIS,
                configured=False,
                healthy=False,
                latency_ms=None,
                last_message_at=None,
                status="missing key",
                cost_tier="budget",
                coverage_scope="live score",
            )
        ],
        execution_status=_execution_status(hard_block=False),
        persistence_last_error="relation agent_runs does not exist",
        gateway_probe=lambda: False,
    )

    statuses = {check.name: check.status for check in preflight.checks}

    assert preflight.status == "blocked"
    assert statuses["admin_api_token"] == "warn"
    assert statuses["openclaw_gateway"] == "fail"
    assert statuses["persistence"] == "fail"
    assert statuses["real_execution_hard_block"] == "fail"
    assert statuses["provider_keys"] == "warn"
