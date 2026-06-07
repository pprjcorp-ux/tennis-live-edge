import asyncio
from datetime import date

import pytest

from tennis_edge.config import Settings
from tennis_edge.domain import (
    ExecutionOrder,
    ExecutionStage,
    ExecutionVenue,
    KillSwitchRequest,
    LearningPromotionRequest,
    OrderRequest,
    OrderStatus,
    SignalStatus,
)
from tennis_edge.services.execution_engine import (
    ORDERS,
    KILL_SWITCH,
    bankroll_snapshot,
    build_betfair_mapping,
    cancel_order,
    create_order,
    execution_status,
    promote_from_learning,
    set_kill_switch_for,
    stage_stake_cap,
)
from tennis_edge.providers.betfair import BetfairClient
from tennis_edge.services.repository import AnalysisRepository


def _settings(**overrides: object) -> Settings:
    defaults = {
        "data_mode": "sample",
        "execution_enabled": False,
        "execution_stage": "paper",
        "execution_venue": "betfair",
        "bankroll_starting_balance": 10000,
        "betfair_live_key_approved": False,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def _entry_signal_context(settings: Settings):
    repo = AnalysisRepository(settings)
    analyses = asyncio.run(repo.analyses_for_date(date.today()))
    for analysis in analyses:
        for signal in analysis.signals:
            if signal.status == SignalStatus.ENTRY:
                return analyses, analysis, signal
    raise AssertionError("sample data must include at least one executable entry signal")


def test_execution_status_blocks_real_orders_by_default() -> None:
    KILL_SWITCH["enabled"] = False
    status = execution_status(_settings())

    assert status.stage == ExecutionStage.PAPER
    assert status.can_submit_real_orders is False
    assert any("EXECUTION_ENABLED=false" in reason for reason in status.reasons)
    assert any("paper" in reason for reason in status.reasons)


def test_betfair_mapping_uses_market_and_selection_ids() -> None:
    settings = _settings()
    _, analysis, signal = _entry_signal_context(settings)
    mapping = build_betfair_mapping(analysis, signal, 10, signal.best_odds, "ord_123456789abc")

    assert mapping.market_id.startswith("1.")
    assert mapping.selection_id > 0
    assert mapping.side == "BACK"
    assert mapping.customer_order_ref == "te-123456789abc"

    payload = BetfairClient.place_orders_payload(mapping)
    instruction = payload["params"]["instructions"][0]
    assert payload["method"] == "SportsAPING/v1.0/placeOrders"
    assert payload["params"]["marketId"] == mapping.market_id
    assert instruction["orderType"] == "LIMIT"
    assert instruction["limitOrder"]["persistenceType"] == "LAPSE"


def test_paper_order_records_audit_without_real_submission() -> None:
    settings = _settings()
    analyses, _, signal = _entry_signal_context(settings)

    order = create_order(settings, analyses, request=OrderRequest(signal_id=signal.id), real=False)

    assert order.status == OrderStatus.PAPER
    assert order.external_order_id is None
    assert order.customer_order_ref is not None
    assert "No browser automation" in " ".join(order.audit)
    assert order.risk_snapshot["model_version"] in {"prematch_ensemble_v1", "live_markov_v1"}
    assert order.risk_snapshot["paper_fill"]["matched_stake"] == order.matched_stake


def test_order_risk_uses_persisted_open_exposure_snapshot() -> None:
    settings = _settings(bankroll_starting_balance=10000)
    analyses, _, signal = _entry_signal_context(settings)
    persisted_order = ExecutionOrder(
        id="ord_persisted_exposure",
        signal_id="sig_previous",
        match_id=signal.match_id,
        player_id=signal.player_id,
        player_name=signal.player_name,
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.PAPER,
        requested_odds=signal.best_odds,
        accepted_odds=signal.best_odds,
        stake_fraction=0.0295,
        stake_amount=295,
        matched_stake=200,
        average_price=signal.best_odds,
    )

    order = create_order(
        settings,
        analyses,
        request=OrderRequest(signal_id=signal.id),
        real=False,
        orders=[persisted_order],
    )

    assert "Open exposure cap would be exceeded." in order.risk_snapshot["risk_reasons"]


def test_paper_order_rejects_non_entry_signal() -> None:
    settings = _settings()
    repo = AnalysisRepository(settings)
    analyses = asyncio.run(repo.analyses_for_date(date.today()))
    non_entry = next(
        signal
        for analysis in analyses
        for signal in analysis.signals
        if signal.status != SignalStatus.ENTRY
    )

    with pytest.raises(ValueError, match="paper orders require Entrada"):
        create_order(settings, analyses, request=OrderRequest(signal_id=non_entry.id), real=False)


def test_real_order_is_blocked_until_all_execution_gates_pass() -> None:
    settings = _settings()
    analyses, _, signal = _entry_signal_context(settings)

    order = create_order(settings, analyses, request=OrderRequest(signal_id=signal.id), real=True)

    assert order.status == OrderStatus.EXECUTION_BLOCKED
    assert order.external_order_id is None
    assert "EXECUTION_ENABLED=false" in (order.rejection_reason or "")


def test_tiny_real_stage_caps_stake_to_tenth_percent() -> None:
    settings = _settings(
        execution_enabled=True,
        execution_stage="tiny_real",
        betfair_app_key="app",
        betfair_username="user",
        betfair_cert_path="/tmp/cert",
        betfair_key_path="/tmp/key",
        betfair_password_secret_ref="secret://betfair",
        betfair_live_key_approved=True,
    )

    assert stage_stake_cap(settings) == 0.001


def test_kill_switch_blocks_even_configured_real_execution() -> None:
    settings = _settings(
        execution_enabled=True,
        execution_stage="tiny_real",
        betfair_app_key="app",
        betfair_username="user",
        betfair_cert_path="/tmp/cert",
        betfair_key_path="/tmp/key",
        betfair_password_secret_ref="secret://betfair",
        betfair_live_key_approved=True,
    )

    status = set_kill_switch_for(settings, KillSwitchRequest(enabled=True, reason="manual test"))

    assert status.can_submit_real_orders is False
    assert any("Kill switch" in reason for reason in status.reasons)
    set_kill_switch_for(settings, KillSwitchRequest(enabled=False, reason="reset"))


def test_matched_order_counts_as_exposure_but_is_not_cancelable() -> None:
    ORDERS.clear()
    settings = _settings(bankroll_starting_balance=10000)
    order = ExecutionOrder(
        id="ord_matched",
        signal_id="sig_matched",
        match_id="match",
        player_id="player",
        player_name="Player",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.MATCHED,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=100,
        average_price=2.0,
    )
    ORDERS[order.id] = order

    snapshot = bankroll_snapshot(settings)
    cancel = cancel_order(order.id)

    assert snapshot.open_exposure == 100
    assert cancel.status == OrderStatus.MATCHED
    assert ORDERS[order.id].status == OrderStatus.MATCHED
    ORDERS.clear()


def test_learning_promotion_rejects_worse_clv_or_drawdown() -> None:
    decision = promote_from_learning(
        LearningPromotionRequest(
            candidate_model_version="bad_clv_candidate",
            roi=0.04,
            clv=-0.01,
            brier_score=0.21,
            log_loss=0.6,
            calibration_error=0.03,
            max_drawdown=0.22,
        )
    )

    assert decision.promoted is False
    assert "CLV" in " ".join(decision.reasons)
    assert "Drawdown" in " ".join(decision.reasons)
