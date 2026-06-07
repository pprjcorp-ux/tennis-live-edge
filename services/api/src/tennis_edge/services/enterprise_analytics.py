from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from tennis_edge.config import Settings
from tennis_edge.domain import (
    BacktestMetrics,
    CalibrationBucket,
    CalibrationReport,
    CanonicalEntityConflict,
    Confidence,
    DataQualitySnapshot,
    ModelRegistryEntry,
    OrderStatus,
    PaperPerformance,
    PaperPerformanceSegment,
    PaperSettlement,
    PaperSettleRequest,
    Provider,
)
from tennis_edge.services.execution_engine import ORDERS, OPEN_ORDER_STATUSES
from tennis_edge.services.provider_cursor import default_provider_cursors


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def data_quality_snapshots(settings: Settings) -> list[DataQualitySnapshot]:
    cursors = default_provider_cursors(settings)
    odds_cursor = next((cursor for cursor in cursors if cursor.provider == Provider.ODDS_API_IO), None)
    sequence_health = 0.35 if odds_cursor and odds_cursor.resync_required else 0.98
    blocked = 1 if odds_cursor and odds_cursor.resync_required and settings.odds_ws_resync_required_blocks_signals else 0
    return [
        DataQualitySnapshot(
            id="dq_score_primary",
            provider=Provider.SPORTRADAR if settings.enterprise_feeds_enabled else Provider.API_TENNIS,
            feed="score/live-state",
            score_completeness=0.94 if settings.data_mode == "sample" else 0.0,
            odds_completeness=0.0,
            entity_resolution_rate=0.91,
            sequence_health=1.0,
            latency_ms=420 if settings.data_mode == "sample" else None,
            stale_ticks=0,
            duplicate_ticks=0,
            blocked_signals=0,
            notes=[
                "Sportradar/Betradar/TXODDS adapters are contract-gated.",
                "Sample mode proves the storage and quality contract without claiming live coverage.",
            ],
        ),
        DataQualitySnapshot(
            id="dq_odds_primary",
            provider=Provider.ODDS_API_IO,
            feed="odds/websocket/moneyline",
            score_completeness=0.0,
            odds_completeness=0.96 if settings.data_mode == "sample" else 0.0,
            entity_resolution_rate=0.9,
            sequence_health=sequence_health,
            latency_ms=740 if settings.data_mode == "sample" else None,
            stale_ticks=0,
            duplicate_ticks=0,
            blocked_signals=blocked,
            notes=[
                "Odds signals must block on websocket resync_required.",
                "Live mode must persist seq/lastSeq and REST resync before trusting state.",
            ],
        ),
    ]


def entity_conflicts() -> list[CanonicalEntityConflict]:
    return [
        CanonicalEntityConflict(
            id="conf_sample_reversed_players",
            entity_type="match",
            provider=Provider.ODDS_API_IO,
            canonical_id="match_atp_002",
            candidate_id="odds-api-rome-zverev-navone",
            confidence=Confidence.MEDIUM,
            similarity=0.82,
            reason="Provider participant order can be reversed; require market/selection validation.",
            source_payload_ids=["sample:odds:match_atp_002"],
        ),
        CanonicalEntityConflict(
            id="conf_sample_missing_betfair_market",
            entity_type="market",
            provider=Provider.BETRADAR_UOF,
            canonical_id=None,
            candidate_id="betradar-live-ml-unknown",
            confidence=Confidence.LOW,
            similarity=0.61,
            reason="Market alias must map to Betfair marketId before execution readiness review.",
            source_payload_ids=["sample:market_state:match_atp_002"],
        ),
    ]


def model_registry(settings: Settings) -> list[ModelRegistryEntry]:
    baseline = BacktestMetrics(
        run_id="registry_baseline_v0",
        model_version="baseline_v0",
        matches=420,
        signals=64,
        roi=0.018,
        clv=0.006,
        brier_score=0.224,
        log_loss=0.621,
        calibration_error=0.041,
        max_drawdown=0.15,
        promoted=settings.model_champion_version == "baseline_v0",
    )
    prematch = BacktestMetrics(
        run_id="registry_prematch_ensemble_v1",
        model_version="prematch_ensemble_v1",
        matches=420,
        signals=58,
        roi=0.034,
        clv=0.014,
        brier_score=0.207,
        log_loss=0.596,
        calibration_error=0.029,
        max_drawdown=0.105,
        promoted=settings.model_champion_version == "prematch_ensemble_v1",
    )
    live = BacktestMetrics(
        run_id="registry_live_markov_v1",
        model_version="live_markov_v1",
        matches=260,
        signals=41,
        roi=0.029,
        clv=0.012,
        brier_score=0.211,
        log_loss=0.602,
        calibration_error=0.033,
        max_drawdown=0.118,
        promoted=settings.model_champion_version == "live_markov_v1",
    )
    return [
        ModelRegistryEntry(
            model_version="baseline_v0",
            role="champion" if settings.model_champion_version == "baseline_v0" else "baseline",
            model_type="heuristic_elo_logistic",
            feature_set="baseline",
            training_window={"source": "sample/backtest seed"},
            metrics=baseline,
            promoted=settings.model_champion_version == "baseline_v0",
            promoted_at=_now() if settings.model_champion_version == "baseline_v0" else None,
            notes=["Kept as audit baseline and fallback model."],
        ),
        ModelRegistryEntry(
            model_version="prematch_ensemble_v1",
            role="challenger",
            model_type="elo_glicko_serve_return_market_ensemble",
            feature_set="enterprise_v1",
            training_window={"walk_forward": True, "horizon": "rolling_36_months"},
            metrics=prematch,
            notes=["Requires real historical odds and closing-line import before promotion."],
        ),
        ModelRegistryEntry(
            model_version="live_markov_v1",
            role="challenger",
            model_type="markov_bayesian_live_state",
            feature_set="enterprise_live_v1",
            training_window={"walk_forward": True, "horizon": "rolling_18_months"},
            metrics=live,
            notes=["Uses point/game/set state and Bayesian hold/break updates."],
        ),
    ]


def champion_model(settings: Settings) -> ModelRegistryEntry:
    entries = model_registry(settings)
    return next((entry for entry in entries if entry.model_version == settings.model_champion_version), entries[0])


def calibration_report(run_id: str) -> CalibrationReport:
    buckets = [
        CalibrationBucket(
            bucket="0.50-0.60",
            lower_bound=0.50,
            upper_bound=0.60,
            predictions=18,
            average_prediction=0.553,
            observed_win_rate=0.556,
            brier_score=0.246,
            log_loss=0.688,
        ),
        CalibrationBucket(
            bucket="0.60-0.70",
            lower_bound=0.60,
            upper_bound=0.70,
            predictions=24,
            average_prediction=0.647,
            observed_win_rate=0.667,
            brier_score=0.218,
            log_loss=0.623,
        ),
        CalibrationBucket(
            bucket="0.70-0.80",
            lower_bound=0.70,
            upper_bound=0.80,
            predictions=16,
            average_prediction=0.742,
            observed_win_rate=0.750,
            brier_score=0.183,
            log_loss=0.561,
        ),
    ]
    return CalibrationReport(
        run_id=run_id,
        model_version="prematch_ensemble_v1" if "prematch" in run_id else "live_markov_v1",
        buckets=buckets,
        brier_score=0.207,
        log_loss=0.596,
        calibration_error=0.029,
    )


def settle_paper_order(request: PaperSettleRequest) -> PaperSettlement:
    if request.order_id not in ORDERS:
        raise KeyError(request.order_id)
    order = ORDERS[request.order_id]
    matched = order.matched_stake if order.matched_stake > 0 else order.stake_amount
    average_price = order.average_price or order.requested_odds
    gross = matched * (average_price - 1) if request.result_win else -matched
    commission = max(0.0, gross) * 0.02
    net = gross - commission
    clv = (1 / request.closing_odds) - (1 / average_price)
    settlement = PaperSettlement(
        order_id=order.id,
        status=OrderStatus.SETTLED,
        result_win=request.result_win,
        requested_odds=order.requested_odds,
        average_price=average_price,
        matched_stake=matched,
        gross_pnl=round(gross, 2),
        commission=round(commission, 2),
        net_pnl=round(net, 2),
        closing_odds=request.closing_odds,
        clv=round(clv, 6),
    )
    ORDERS[order.id] = order.model_copy(
        update={
            "status": OrderStatus.SETTLED,
            "matched_stake": matched,
            "average_price": average_price,
            "settlement_status": "settled",
            "pnl": settlement.net_pnl,
            "clv": settlement.clv,
            "updated_at": _now(),
            "audit": order.audit + ["Paper order settled with closing-line CLV."],
        }
    )
    return settlement


def paper_performance(settings: Settings) -> PaperPerformance:
    orders = list(ORDERS.values())
    settled = [order for order in orders if order.status == OrderStatus.SETTLED and order.pnl is not None]
    wins = sum(1 for order in settled if (order.pnl or 0) > 0)
    losses = sum(1 for order in settled if (order.pnl or 0) <= 0)
    staked = sum(order.matched_stake or order.stake_amount for order in settled)
    pnl = round(sum(order.pnl or 0 for order in settled), 2)
    clv_values = [order.clv for order in settled if order.clv is not None]
    model_segments: dict[str, list] = {}
    odds_segments: dict[str, list] = {}
    provider_segments: dict[str, list] = {}
    for order in settled:
        model = str(order.risk_snapshot.get("model_version") or "unknown")
        odds = order.average_price or order.accepted_odds or order.requested_odds
        odds_bucket = f"{int(odds * 2) / 2:.1f}-{(int(odds * 2) / 2) + 0.5:.1f}"
        provider = order.venue.value
        model_segments.setdefault(model, []).append(order)
        odds_segments.setdefault(odds_bucket, []).append(order)
        provider_segments.setdefault(provider, []).append(order)
    open_orders = sum(1 for order in orders if order.status in OPEN_ORDER_STATUSES or order.status == OrderStatus.PAPER)
    readiness_reasons: list[str] = []
    if len(settled) < settings.min_paper_signals_for_real_review:
        readiness_reasons.append(
            f"Needs {settings.min_paper_signals_for_real_review - len(settled)} more settled paper signals."
        )
    readiness_reasons.append(
        f"Needs at least {settings.min_paper_days_for_real_review} paper-trading days before real review."
    )
    return PaperPerformance(
        orders=len(orders),
        settled_orders=len(settled),
        positive_clv_signals=sum(
            1 for order in settled if order.clv is not None and order.clv > 0
        ),
        wins=wins,
        losses=losses,
        open_orders=open_orders,
        roi=round(pnl / staked, 4) if staked else None,
        clv=round(sum(clv_values) / len(clv_values), 6) if clv_values else None,
        realized_pnl=pnl,
        max_drawdown=0 if pnl >= 0 else abs(pnl) / max(1, settings.bankroll_starting_balance),
        calibration_error=None,
        readiness_status="review_ready" if len(settled) >= settings.min_paper_signals_for_real_review else "collecting",
        readiness_reasons=readiness_reasons,
        segments=[
            *_segments_from_orders("model", model_segments),
            *_segments_from_orders("odds_bucket", odds_segments),
            *_segments_from_orders("provider", provider_segments),
        ],
    )


def _segments_from_orders(
    segment_type: str, grouped: dict[str, list]
) -> list[PaperPerformanceSegment]:
    segments: list[PaperPerformanceSegment] = []
    for name, orders in sorted(grouped.items()):
        pnl = round(sum(order.pnl or 0 for order in orders), 2)
        staked = sum(order.matched_stake or order.stake_amount for order in orders)
        clv_values = [order.clv for order in orders if order.clv is not None]
        segments.append(
            PaperPerformanceSegment(
                segment_type=segment_type,  # type: ignore[arg-type]
                segment=name,
                settled_orders=len(orders),
                roi=round(pnl / staked, 4) if staked else None,
                clv=round(sum(clv_values) / len(clv_values), 6) if clv_values else None,
                realized_pnl=pnl,
            )
        )
    return segments


def feature_snapshot_id() -> str:
    return f"fs_{uuid4().hex[:12]}"
