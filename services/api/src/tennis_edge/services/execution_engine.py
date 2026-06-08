from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from uuid import uuid4

from tennis_edge.config import Settings
from tennis_edge.domain import (
    BacktestMetrics,
    BankrollSnapshot,
    BetfairOrderMapping,
    CancelOrderResult,
    ExecutionOrder,
    ExecutionStage,
    ExecutionStatus,
    ExecutionVenue,
    KillSwitchRequest,
    LearningPromotionRequest,
    MatchAnalysis,
    ModelPromotionDecision,
    OrderRequest,
    OrderStatus,
    Signal,
    SignalStatus,
)
from tennis_edge.providers.betfair import BetfairClient
from tennis_edge.services.backtest import evaluate_promotion
from tennis_edge.services.provider_lineage import (
    odds_provider_for_match,
    primary_provider_for_match,
    provider_lineage_for_match,
)


ORDERS: dict[str, ExecutionOrder] = {}
KILL_SWITCH = {"enabled": False, "reason": "not set"}

OPEN_ORDER_STATUSES = {
    OrderStatus.PAPER,
    OrderStatus.PENDING,
    OrderStatus.SUBMITTED,
    OrderStatus.PARTIALLY_MATCHED,
    OrderStatus.MATCHED,
}

CANCELABLE_ORDER_STATUSES = {
    OrderStatus.PAPER,
    OrderStatus.PENDING,
    OrderStatus.SUBMITTED,
    OrderStatus.PARTIALLY_MATCHED,
}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _execution_stage(settings: Settings) -> ExecutionStage:
    try:
        return ExecutionStage(settings.execution_stage)
    except ValueError:
        return ExecutionStage.PAPER


def _execution_venue(settings: Settings) -> ExecutionVenue:
    try:
        return ExecutionVenue(settings.execution_venue)
    except ValueError:
        return ExecutionVenue.BETFAIR


def betfair_configured(settings: Settings) -> bool:
    return all(
        [
            settings.betfair_app_key,
            settings.betfair_username,
            settings.betfair_cert_path,
            settings.betfair_key_path,
            settings.betfair_password_secret_ref,
        ]
    )


def execution_status(
    settings: Settings,
    kill_switch: Mapping[str, object] | None = None,
) -> ExecutionStatus:
    stage = _execution_stage(settings)
    venue = _execution_venue(settings)
    configured = betfair_configured(settings)
    kill_switch = kill_switch or KILL_SWITCH
    kill_switch_enabled = bool(kill_switch.get("enabled", False))
    kill_switch_reason = str(kill_switch.get("reason") or "not set")
    reasons: list[str] = []

    if not settings.execution_enabled:
        reasons.append("EXECUTION_ENABLED=false.")
    if settings.real_execution_hard_block:
        reasons.append("REAL_EXECUTION_HARD_BLOCK=true; paper-first phase blocks all real orders.")
    if venue != ExecutionVenue.BETFAIR:
        reasons.append("Only Betfair execution is enabled in v1.")
    if stage == ExecutionStage.PAPER:
        reasons.append("Execution stage is paper; real orders are disabled.")
    if not configured:
        reasons.append("Betfair credentials/certificate settings are incomplete.")
    if not settings.betfair_live_key_approved:
        reasons.append("Betfair live app key approval is not confirmed.")
    if kill_switch_enabled:
        reasons.append(f"Kill switch enabled: {kill_switch_reason}.")

    return ExecutionStatus(
        execution_enabled=settings.execution_enabled,
        venue=venue,
        stage=stage,
        betfair_configured=configured,
        betfair_live_key_approved=settings.betfair_live_key_approved,
        real_execution_hard_block=settings.real_execution_hard_block,
        kill_switch_enabled=kill_switch_enabled,
        can_submit_real_orders=not reasons,
        reasons=reasons,
    )


def _order_snapshot(orders: Iterable[ExecutionOrder] | None = None) -> list[ExecutionOrder]:
    return list(orders) if orders is not None else list(ORDERS.values())


def bankroll_snapshot(
    settings: Settings,
    orders: Iterable[ExecutionOrder] | None = None,
) -> BankrollSnapshot:
    order_snapshot = _order_snapshot(orders)
    bankroll = settings.bankroll_starting_balance
    open_exposure = sum(
        order.stake_amount for order in order_snapshot if order.status in OPEN_ORDER_STATUSES
    )
    realized = sum(order.pnl or 0 for order in order_snapshot if order.pnl is not None)
    return BankrollSnapshot(
        base_currency=settings.bankroll_base_currency,
        bankroll_amount=round(bankroll + realized, 2),
        available_amount=round(max(0, bankroll + realized - open_exposure), 2),
        open_exposure=round(open_exposure, 2),
        realized_pnl=round(realized, 2),
        daily_pnl=round(realized, 2),
        weekly_drawdown=0 if realized >= 0 else abs(realized) / bankroll,
        clv=_average_clv(order_snapshot),
        execution_stage=_execution_stage(settings),
        max_order_stake_fraction=stage_stake_cap(settings),
        daily_loss_limit_fraction=settings.daily_loss_limit_fraction,
        weekly_drawdown_limit_fraction=settings.weekly_drawdown_limit_fraction,
    )


def stage_stake_cap(settings: Settings) -> float:
    stage = _execution_stage(settings)
    if stage == ExecutionStage.TINY_REAL:
        return min(settings.max_order_stake_fraction, 0.001)
    if stage == ExecutionStage.SCALED:
        return min(settings.max_order_stake_fraction, 0.015)
    return min(settings.max_order_stake_fraction, 0.015)


def _average_clv(orders: Iterable[ExecutionOrder] | None = None) -> float | None:
    values = [order.clv for order in _order_snapshot(orders) if order.clv is not None]
    if not values:
        return None
    return round(sum(values) / len(values), 4)


def set_kill_switch_for(settings: Settings, request: KillSwitchRequest) -> ExecutionStatus:
    KILL_SWITCH["enabled"] = request.enabled
    KILL_SWITCH["reason"] = request.reason
    return execution_status(settings, KILL_SWITCH)


def find_signal(analyses: list[MatchAnalysis], signal_id: str) -> tuple[MatchAnalysis, Signal]:
    for analysis in analyses:
        for signal in analysis.signals:
            if signal.id == signal_id:
                return analysis, signal
    raise KeyError(signal_id)


def build_betfair_mapping(
    analysis: MatchAnalysis,
    signal: Signal,
    stake_amount: float,
    requested_odds: float,
    order_id: str,
) -> BetfairOrderMapping:
    market_id = analysis.match.provider_ids.get("betfair_market_id")
    player = (
        analysis.match.player1
        if signal.player_id == analysis.match.player1.id
        else analysis.match.player2
    )
    selection_id = player.provider_ids.get("betfair_selection_id")

    if not market_id or not selection_id:
        raise ValueError("Betfair marketId/selectionId mapping is missing.")

    return BetfairOrderMapping(
        market_id=market_id,
        selection_id=int(selection_id),
        limit_price=round(requested_odds, 2),
        stake_amount=round(stake_amount, 2),
        customer_order_ref=f"te-{order_id[-12:]}",
    )


def order_risk_reasons(
    settings: Settings,
    analysis: MatchAnalysis,
    signal: Signal,
    stake_amount: float,
    orders: Iterable[ExecutionOrder] | None = None,
) -> list[str]:
    reasons: list[str] = []
    if signal.status != SignalStatus.ENTRY:
        reasons.append(f"Signal status is {signal.status}; only Entrada can execute.")
    if analysis.features.odds_latency_ms is not None and analysis.features.odds_latency_ms > 2500:
        reasons.append("Odds are stale for execution.")
    if analysis.match.state.status == "live" and not analysis.match.state.point_score:
        reasons.append("Live score state is incomplete.")

    bankroll = bankroll_snapshot(settings, orders)
    if stake_amount > bankroll.bankroll_amount * stage_stake_cap(settings):
        reasons.append("Stake exceeds stage cap.")
    if stake_amount <= 0:
        reasons.append("Stake amount must be positive.")
    if bankroll.open_exposure + stake_amount > bankroll.bankroll_amount * settings.max_open_exposure_fraction:
        reasons.append("Open exposure cap would be exceeded.")
    if bankroll.daily_pnl <= -(bankroll.bankroll_amount * settings.daily_loss_limit_fraction):
        reasons.append("Daily loss limit reached.")
    if bankroll.weekly_drawdown >= settings.weekly_drawdown_limit_fraction:
        reasons.append("Weekly drawdown limit reached.")
    return reasons


def create_order(
    settings: Settings,
    analyses: list[MatchAnalysis],
    request: OrderRequest,
    *,
    real: bool,
    orders: Iterable[ExecutionOrder] | None = None,
    kill_switch: Mapping[str, object] | None = None,
    remember_in_process: bool = True,
) -> ExecutionOrder:
    analysis, signal = find_signal(analyses, request.signal_id)
    if not real and signal.status != SignalStatus.ENTRY:
        raise ValueError(f"Signal status is {signal.status}; paper orders require Entrada.")
    order_id = f"ord_{uuid4().hex[:12]}"
    requested_odds = request.requested_odds or signal.best_odds
    bankroll_amount = request.bankroll_amount or settings.bankroll_starting_balance
    stake_fraction = min(signal.stake_fraction, stage_stake_cap(settings))
    stake_amount = round(bankroll_amount * stake_fraction, 2)
    risk_reasons = order_risk_reasons(settings, analysis, signal, stake_amount, orders)
    status = OrderStatus.PAPER if not real else OrderStatus.SUBMITTED
    odds_provider = odds_provider_for_match(analysis.match)
    audit = [
        "Order created from deterministic signal gate.",
        "No browser automation or sportsbook scraping used.",
    ]
    external_order_id: str | None = None
    accepted_odds: float | None = None
    matched_stake = 0.0
    average_price: float | None = None
    rejection_reason: str | None = None
    mapping: BetfairOrderMapping | None = None

    if stake_amount > 0:
        try:
            mapping = build_betfair_mapping(analysis, signal, stake_amount, requested_odds, order_id)
        except ValueError as exc:
            risk_reasons.append(str(exc))

    if real:
        status_snapshot = execution_status(settings, kill_switch)
        risk_reasons.extend(status_snapshot.reasons)
        if risk_reasons:
            status = OrderStatus.EXECUTION_BLOCKED
            rejection_reason = " ".join(dict.fromkeys(risk_reasons))
            audit.append("Real submission blocked by execution/risk gates.")
        elif settings.data_mode == "sample":
            external_order_id = f"BF-SIM-{order_id[-8:]}"
            accepted_odds = requested_odds
            matched_stake = round(stake_amount * 0.5, 2)
            average_price = requested_odds
            status = OrderStatus.PARTIALLY_MATCHED
            audit.append("Sample-mode Betfair order simulated; no external API call made.")
        else:
            try:
                result = BetfairClient(settings).place_limit_order(mapping)  # type: ignore[arg-type]
                report = (result.get("instructionReports") or [{}])[0]
                external_order_id = report.get("betId")
                accepted_odds = requested_odds
                average_price = requested_odds
                status = OrderStatus.SUBMITTED
                audit.append(f"Betfair placeOrders returned {result.get('status', 'UNKNOWN')}.")
            except Exception as exc:
                status = OrderStatus.REJECTED
                rejection_reason = str(exc)
                audit.append("Betfair API call failed; order rejected without retry.")
    elif not real:
        available_odds = round(max(1.01, requested_odds - 0.01), 2)
        matched_stake = round(stake_amount * 0.72, 2) if stake_amount > 0 else 0
        average_price = available_odds if matched_stake else None
        accepted_odds = available_odds if matched_stake else None
        audit.append("Paper order simulated with queue, slippage and partial-fill assumptions.")
        if risk_reasons:
            audit.append("Paper order records risk warnings but does not submit real money.")

    order = ExecutionOrder(
        id=order_id,
        signal_id=signal.id,
        match_id=signal.match_id,
        player_id=signal.player_id,
        player_name=signal.player_name,
        venue=ExecutionVenue.BETFAIR,
        status=status,
        requested_odds=round(requested_odds, 2),
        accepted_odds=accepted_odds,
        stake_fraction=round(stake_fraction, 6),
        stake_amount=stake_amount,
        matched_stake=matched_stake,
        average_price=average_price,
        external_order_id=external_order_id,
        customer_order_ref=mapping.customer_order_ref if mapping else None,
        rejection_reason=rejection_reason,
        risk_snapshot={
            "stage": _execution_stage(settings),
            "model_version": analysis.prediction.model_version,
            "surface": analysis.match.surface.value,
            "tour": analysis.match.tour.value,
            "competition_level": analysis.match.competition_level.value,
            "score_provider": primary_provider_for_match(analysis.match).value,
            "odds_provider": odds_provider.value if odds_provider is not None else None,
            "provider_lineage": [
                provider.value for provider in provider_lineage_for_match(analysis.match)
            ],
            "risk_reasons": risk_reasons,
            "bankroll_amount": bankroll_amount,
            "stake_cap": stage_stake_cap(settings),
            "betfair_mapping": mapping.model_dump() if mapping else None,
            "paper_fill": {
                "available_odds": average_price,
                "matched_stake": matched_stake,
                "unmatched_stake": round(max(0, stake_amount - matched_stake), 2),
                "commission_rate": 0.02,
                "slippage": round(requested_odds - average_price, 4) if average_price else None,
            }
            if not real
            else None,
        },
        audit=audit,
        updated_at=_now(),
    )
    if remember_in_process:
        ORDERS[order.id] = order
    return order


def cancel_order(order_id: str) -> CancelOrderResult:
    if order_id not in ORDERS:
        raise KeyError(order_id)
    order = ORDERS[order_id]
    if order.status not in CANCELABLE_ORDER_STATUSES:
        return CancelOrderResult(
            order_id=order_id,
            status=order.status,
            reason="Order is not open; no cancellation sent.",
        )
    order.status = OrderStatus.CANCELLED
    order.updated_at = _now()
    order.audit.append("Order cancelled by admin request.")
    return CancelOrderResult(order_id=order_id, status=order.status, reason="Order cancelled.")


def promote_from_learning(request: LearningPromotionRequest) -> ModelPromotionDecision:
    metrics = evaluate_promotion(
        BacktestMetrics(
            run_id=f"learn_{uuid4().hex[:12]}",
            model_version=request.candidate_model_version,
            matches=420,
            signals=64,
            roi=request.roi,
            clv=request.clv,
            brier_score=request.brier_score,
            log_loss=request.log_loss,
            calibration_error=request.calibration_error,
            max_drawdown=request.max_drawdown,
        )
    )
    reasons = (
        ["Candidate improves controlled learning gates; promotion allowed."]
        if metrics.promoted
        else [metrics.rejection_reason or "Candidate failed promotion gates."]
    )
    decision = ModelPromotionDecision(
        run_id=metrics.run_id,
        candidate_model_version=request.candidate_model_version,
        promoted=metrics.promoted,
        reasons=reasons,
        metrics=metrics,
    )
    return decision
