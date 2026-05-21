from __future__ import annotations

from collections.abc import Iterable
from contextlib import contextmanager
from datetime import date, datetime, timezone
import json
from typing import Any
from uuid import uuid4

from tennis_edge.config import Settings
from tennis_edge.domain import (
    BacktestMetrics,
    BacktestRunRequest,
    Confidence,
    CursorStatus,
    DataQualitySnapshot,
    ExecutionOrder,
    ExecutionVenue,
    FeatureVector,
    Match,
    MatchAnalysis,
    MatchState,
    OddsQuote,
    OrderStatus,
    PaperPerformance,
    PaperSettlement,
    PaperSettleRequest,
    Player,
    Prediction,
    Provider,
    ProviderCursor,
    ProviderHealth,
    Signal,
)
from tennis_edge.services.backtest import evaluate_promotion
from tennis_edge.services.cost_profile import (
    cost_profile,
    provider_health_for,
)
from tennis_edge.services.feature_engine import build_features
from tennis_edge.services.model_service import predict_match
from tennis_edge.services.provider_cursor import default_provider_cursors
from tennis_edge.services.signal_engine import build_signals


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _enum_value(value: Any) -> Any:
    return getattr(value, "value", value)


def _json(value: Any) -> Any:
    try:
        from psycopg.types.json import Jsonb
    except ImportError:  # pragma: no cover - only used when optional dependency is absent.
        return json.dumps(value)
    return Jsonb(value)


class PersistentStore:
    """Postgres/Timescale persistence with a no-crash fallback.

    The app remains usable in sample mode and during missing-provider setup. In live
    mode this store records the current operational snapshot and can serve the last
    persisted matches when an upstream provider is unavailable.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.last_error: str | None = None

    @property
    def enabled(self) -> bool:
        if not self.settings.persistence_enabled or not self.settings.database_url:
            return False
        return self.settings.data_mode != "sample"

    @contextmanager
    def _connect(self):
        if not self.enabled:
            yield None
            return
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError:
            self.last_error = "psycopg is not installed; persistence disabled."
            yield None
            return

        conn = None
        try:
            conn = psycopg.connect(
                self.settings.database_url,
                autocommit=True,
                row_factory=dict_row,
            )
            self.last_error = None
            yield conn
        except Exception as exc:  # pragma: no cover - exercised with real DB failures.
            self.last_error = str(exc)
            yield None
        finally:
            if conn is not None:
                conn.close()

    def save_analyses(self, analyses: Iterable[MatchAnalysis]) -> None:
        if not self.enabled:
            return
        with self._connect() as conn:
            if conn is None:
                return
            for analysis in analyses:
                with conn.cursor() as cur:
                    self._upsert_player(cur, analysis.match.player1)
                    self._upsert_player(cur, analysis.match.player2)
                    self._upsert_match(cur, analysis.match)
                    self._insert_score_tick(cur, analysis.match)
                    self._insert_odds_ticks(cur, analysis.match)
                    feature_id = self._insert_feature_snapshot(cur, analysis.features)
                    prediction_id = self._insert_prediction_snapshot(
                        cur, analysis.prediction, feature_id
                    )
                    self._insert_signals(cur, analysis.signals, prediction_id)
                    self._record_latency(cur, Provider.API_TENNIS, "score/live", analysis.match)
                    if analysis.match.odds:
                        self._record_latency(cur, Provider.ODDS_API_IO, "odds/moneyline", analysis.match)
                    self._upsert_provider_cursors(cur)

    def latest_analyses(self, target_date: date) -> list[MatchAnalysis]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            with conn.cursor() as cur:
                rows = cur.execute(
                    """
                    SELECT
                      m.*,
                      p1.name AS p1_name, p1.provider_ids AS p1_provider_ids,
                      p1.country AS p1_country, p1.ranking AS p1_ranking,
                      p1.handedness AS p1_handedness, p1.elo_overall AS p1_elo_overall,
                      p1.elo_clay AS p1_elo_clay, p1.elo_hard AS p1_elo_hard,
                      p1.hold_rate AS p1_hold_rate, p1.break_rate AS p1_break_rate,
                      p2.name AS p2_name, p2.provider_ids AS p2_provider_ids,
                      p2.country AS p2_country, p2.ranking AS p2_ranking,
                      p2.handedness AS p2_handedness, p2.elo_overall AS p2_elo_overall,
                      p2.elo_clay AS p2_elo_clay, p2.elo_hard AS p2_elo_hard,
                      p2.hold_rate AS p2_hold_rate, p2.break_rate AS p2_break_rate,
                      st.raw_state AS latest_state
                    FROM matches m
                    JOIN players p1 ON p1.id = m.player1_id
                    JOIN players p2 ON p2.id = m.player2_id
                    LEFT JOIN LATERAL (
                      SELECT raw_state
                      FROM score_ticks
                      WHERE match_id = m.id
                      ORDER BY source_ts DESC, ingested_at DESC
                      LIMIT 1
                    ) st ON TRUE
                    WHERE m.scheduled_at::date = %s
                    ORDER BY m.scheduled_at ASC
                    """,
                    (target_date,),
                ).fetchall()
                if not rows:
                    return []
                odds_rows = cur.execute(
                    """
                    SELECT DISTINCT ON (match_id, bookmaker, market, outcome_player_id)
                      match_id, bookmaker, market, outcome_player_id, decimal_odds, source_ts, ingested_at
                    FROM odds_ticks
                    WHERE match_id = ANY(%s)
                    ORDER BY match_id, bookmaker, market, outcome_player_id, source_ts DESC, ingested_at DESC
                    """,
                    ([row["id"] for row in rows],),
                ).fetchall()
        odds_by_match: dict[str, list[OddsQuote]] = {}
        for row in odds_rows:
            odds_by_match.setdefault(row["match_id"], []).append(
                OddsQuote(
                    bookmaker=row["bookmaker"],
                    market="ML",
                    player_id=row["outcome_player_id"],
                    decimal_odds=float(row["decimal_odds"]),
                    source_ts=row["source_ts"],
                    ingested_at=row["ingested_at"],
                )
            )

        analyses: list[MatchAnalysis] = []
        for row in rows:
            match = self._match_from_row(row, odds_by_match.get(row["id"], []))
            features = build_features(match)
            prediction = predict_match(match, features)
            analyses.append(
                MatchAnalysis(
                    match=match,
                    features=features,
                    prediction=prediction,
                    signals=build_signals(match, prediction, features),
                )
            )
        return analyses

    def provider_health(self) -> list[ProviderHealth]:
        base = provider_health_for(self.settings)
        if not self.enabled:
            return base
        with self._connect() as conn:
            if conn is None:
                return [
                    item.model_copy(
                        update={
                            "healthy": False if item.provider in {Provider.API_TENNIS, Provider.ODDS_API_IO, Provider.THE_ODDS_API} else item.healthy,
                            "status": f"{item.status}; persistence unavailable: {self.last_error}",
                        }
                    )
                    for item in base
                ]
            with conn.cursor() as cur:
                latencies = cur.execute(
                    """
                    SELECT DISTINCT ON (provider, feed)
                      provider, feed, latest_ingested_at, latency_ms, healthy
                    FROM provider_latency
                    ORDER BY provider, feed, ingested_at DESC
                    """
                ).fetchall()
                call_rows = cur.execute(
                    """
                    SELECT provider, count(*)::int AS count
                    FROM raw_provider_payloads
                    WHERE ingested_at >= now() - interval '1 day'
                    GROUP BY provider
                    """
                ).fetchall()
                call_counts = {row["provider"]: row["count"] for row in call_rows}
        by_provider = {row["provider"]: row for row in latencies}
        updated: list[ProviderHealth] = []
        for item in base:
            row = by_provider.get(item.provider.value)
            if row:
                updated.append(
                    item.model_copy(
                        update={
                            "healthy": bool(row["healthy"]),
                            "latency_ms": row["latency_ms"],
                            "last_message_at": row["latest_ingested_at"],
                            "status": f"{item.status}; persisted {row['feed']}",
                            "quota_used": call_counts.get(item.provider.value, item.quota_used),
                            "last_billable_call_at": row["latest_ingested_at"],
                        }
                    )
                )
            else:
                updated.append(item)
        return updated

    def provider_cursors(self) -> list[ProviderCursor]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            with conn.cursor() as cur:
                rows = cur.execute(
                    """
                    SELECT provider, stream, last_seq, expected_next_seq, status, gap_count,
                           resync_required, last_message_at, last_resync_at, note
                    FROM provider_cursors
                    ORDER BY provider, stream
                    """
                ).fetchall()
        cursors: list[ProviderCursor] = []
        for row in rows:
            cursors.append(
                ProviderCursor(
                    provider=Provider(row["provider"]),
                    stream=row["stream"],
                    last_seq=row["last_seq"],
                    expected_next_seq=row["expected_next_seq"],
                    status=CursorStatus(row["status"]),
                    gap_count=row["gap_count"],
                    resync_required=row["resync_required"],
                    last_message_at=row["last_message_at"],
                    last_resync_at=row["last_resync_at"],
                    note=row["note"],
                )
            )
        return cursors

    def data_quality(self) -> list[DataQualitySnapshot]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            with conn.cursor() as cur:
                count_rows = cur.execute(
                    """
                    SELECT kind, count(*)::int AS count
                    FROM (
                      SELECT 'matches' AS kind FROM matches WHERE updated_at >= now() - interval '1 day'
                      UNION ALL
                      SELECT 'scores' AS kind FROM score_ticks WHERE ingested_at >= now() - interval '1 day'
                      UNION ALL
                      SELECT 'odds' AS kind FROM odds_ticks WHERE ingested_at >= now() - interval '1 day'
                    ) x
                    GROUP BY kind
                    """
                ).fetchall()
                counts = {row["kind"]: row["count"] for row in count_rows}
                cursor_rows = cur.execute(
                    "SELECT count(*)::int AS gaps FROM provider_cursors WHERE resync_required = true"
                ).fetchone()
        matches = max(1, counts.get("matches", 0))
        score_completeness = min(1.0, counts.get("scores", 0) / matches)
        odds_completeness = min(1.0, counts.get("odds", 0) / max(1, matches * 2))
        gaps = int(cursor_rows["gaps"] if cursor_rows else 0)
        return [
            DataQualitySnapshot(
                id="dq_persisted_live_budget",
                provider=Provider.API_TENNIS,
                feed="persisted/live-budget",
                score_completeness=round(score_completeness, 4),
                odds_completeness=round(odds_completeness, 4),
                entity_resolution_rate=1.0 if counts.get("matches", 0) else 0.0,
                sequence_health=0.35 if gaps else 1.0,
                blocked_signals=gaps,
                notes=[
                    "Computed from persisted matches, score ticks, odds ticks and cursor state.",
                    "Signals should abstain when odds are incomplete, stale or resync_required.",
                ],
            )
        ]

    def save_order(self, order: ExecutionOrder) -> None:
        if not self.enabled:
            return
        with self._connect() as conn:
            if conn is None:
                return
            with conn.cursor() as cur:
                signal_row = cur.execute(
                    """
                    SELECT id
                    FROM signals
                    WHERE match_id = %s AND outcome_player_id = %s
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    (order.match_id, order.player_id),
                ).fetchone()
                if not signal_row:
                    return
                cur.execute(
                    """
                    INSERT INTO paper_orders (
                      signal_id, external_order_ref, external_signal_id, match_id, player_id,
                      venue, customer_order_ref, requested_odds, accepted_odds, stake_fraction,
                      stake_amount, matched_stake, average_price, risk_snapshot,
                      rejection_reason, settlement_status, pnl, clv, status, audit, created_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (external_order_ref) DO UPDATE SET
                      accepted_odds = EXCLUDED.accepted_odds,
                      matched_stake = EXCLUDED.matched_stake,
                      average_price = EXCLUDED.average_price,
                      risk_snapshot = EXCLUDED.risk_snapshot,
                      rejection_reason = EXCLUDED.rejection_reason,
                      settlement_status = EXCLUDED.settlement_status,
                      pnl = EXCLUDED.pnl,
                      clv = EXCLUDED.clv,
                      status = EXCLUDED.status,
                      audit = EXCLUDED.audit
                    """,
                    (
                        signal_row["id"],
                        order.id,
                        order.signal_id,
                        order.match_id,
                        order.player_id,
                        order.venue.value,
                        order.customer_order_ref,
                        order.requested_odds,
                        order.accepted_odds,
                        order.stake_fraction,
                        order.stake_amount,
                        order.matched_stake,
                        order.average_price,
                        _json(order.risk_snapshot),
                        order.rejection_reason,
                        order.settlement_status,
                        order.pnl,
                        order.clv,
                        order.status.value,
                        _json(order.audit),
                        order.created_at,
                    ),
                )

    def orders(self) -> list[ExecutionOrder]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            with conn.cursor() as cur:
                rows = cur.execute(
                    """
                    SELECT
                      po.external_order_ref, po.external_signal_id, po.match_id, po.player_id,
                      p.name AS player_name, po.venue, po.customer_order_ref,
                      po.requested_odds, po.accepted_odds, po.stake_fraction,
                      po.stake_amount, po.matched_stake, po.average_price,
                      po.risk_snapshot, po.rejection_reason, po.settlement_status,
                      po.pnl, po.clv, po.status, po.audit, po.created_at
                    FROM paper_orders po
                    LEFT JOIN players p ON p.id = po.player_id
                    ORDER BY po.created_at DESC
                    LIMIT 500
                    """
                ).fetchall()
        orders: list[ExecutionOrder] = []
        for row in rows:
            external_ref = row["external_order_ref"] or f"paper_{row['match_id']}_{row['player_id']}"
            orders.append(
                ExecutionOrder(
                    id=external_ref,
                    signal_id=row["external_signal_id"] or "",
                    match_id=row["match_id"] or "",
                    player_id=row["player_id"] or "",
                    player_name=row["player_name"] or row["player_id"] or "unknown",
                    venue=ExecutionVenue(row["venue"] or ExecutionVenue.BETFAIR.value),
                    status=OrderStatus(row["status"]),
                    requested_odds=float(row["requested_odds"]),
                    accepted_odds=float(row["accepted_odds"]) if row["accepted_odds"] is not None else None,
                    stake_fraction=float(row["stake_fraction"]),
                    stake_amount=float(row["stake_amount"]),
                    matched_stake=float(row["matched_stake"] or 0),
                    average_price=float(row["average_price"]) if row["average_price"] is not None else None,
                    customer_order_ref=row["customer_order_ref"],
                    rejection_reason=row["rejection_reason"],
                    settlement_status=row["settlement_status"],
                    pnl=float(row["pnl"]) if row["pnl"] is not None else None,
                    clv=float(row["clv"]) if row["clv"] is not None else None,
                    risk_snapshot=row["risk_snapshot"] or {},
                    audit=row["audit"] or [],
                    created_at=row["created_at"],
                    updated_at=row["created_at"],
                )
            )
        return orders

    def cancel_order(self, order_id: str) -> OrderStatus | None:
        if not self.enabled:
            return None
        with self._connect() as conn:
            if conn is None:
                return None
            with conn.cursor() as cur:
                row = cur.execute(
                    """
                    UPDATE paper_orders
                    SET status = %s,
                        audit = audit || %s::jsonb
                    WHERE external_order_ref = %s
                      AND status IN ('paper', 'pending', 'submitted', 'partially_matched')
                    RETURNING status
                    """,
                    (
                        OrderStatus.CANCELLED.value,
                        _json(["Persisted paper order cancelled by admin request."]),
                        order_id,
                    ),
                ).fetchone()
        if not row:
            return None
        return OrderStatus(row["status"])

    def settle_paper_order(self, request: PaperSettleRequest) -> PaperSettlement | None:
        if not self.enabled:
            return None
        with self._connect() as conn:
            if conn is None:
                return None
            with conn.cursor() as cur:
                row = cur.execute(
                    """
                    SELECT external_order_ref, requested_odds, average_price, matched_stake, stake_amount
                    FROM paper_orders
                    WHERE external_order_ref = %s
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    (request.order_id,),
                ).fetchone()
        if not row:
            return None
        matched = float(row["matched_stake"] or row["stake_amount"] or 0)
        average_price = float(row["average_price"] or row["requested_odds"])
        gross = matched * (average_price - 1) if request.result_win else -matched
        commission = max(0.0, gross) * 0.02
        net = gross - commission
        clv = (1 / request.closing_odds) - (1 / average_price)
        settlement = PaperSettlement(
            order_id=request.order_id,
            status=OrderStatus.SETTLED,
            result_win=request.result_win,
            requested_odds=float(row["requested_odds"]),
            average_price=average_price,
            matched_stake=matched,
            gross_pnl=round(gross, 2),
            commission=round(commission, 2),
            net_pnl=round(net, 2),
            closing_odds=request.closing_odds,
            clv=round(clv, 6),
        )
        self.save_settlement(settlement)
        return settlement

    def save_settlement(self, settlement: PaperSettlement) -> None:
        if not self.enabled:
            return
        with self._connect() as conn:
            if conn is None:
                return
            with conn.cursor() as cur:
                row = cur.execute(
                    """
                    SELECT id
                    FROM paper_orders
                    WHERE external_order_ref = %s
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    (settlement.order_id,),
                ).fetchone()
                if not row:
                    return
                paper_order_id = row["id"]
                cur.execute(
                    """
                    INSERT INTO paper_settlements (
                      paper_order_id, result_win, requested_odds, average_price,
                      matched_stake, gross_pnl, commission, net_pnl, closing_odds,
                      clv, settled_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        paper_order_id,
                        settlement.result_win,
                        settlement.requested_odds,
                        settlement.average_price,
                        settlement.matched_stake,
                        settlement.gross_pnl,
                        settlement.commission,
                        settlement.net_pnl,
                        settlement.closing_odds,
                        settlement.clv,
                        settlement.settled_at,
                    ),
                )
                cur.execute(
                    """
                    UPDATE paper_orders
                    SET status = %s,
                        settlement_status = %s,
                        pnl = %s,
                        clv = %s,
                        matched_stake = %s,
                        average_price = %s
                    WHERE id = %s
                    """,
                    (
                        OrderStatus.SETTLED.value,
                        "settled",
                        settlement.net_pnl,
                        settlement.clv,
                        settlement.matched_stake,
                        settlement.average_price,
                        paper_order_id,
                    ),
                )
                self._insert_training_example(cur, paper_order_id, settlement)

    def paper_performance(self) -> PaperPerformance | None:
        if not self.enabled:
            return None
        with self._connect() as conn:
            if conn is None:
                return None
            with conn.cursor() as cur:
                row = cur.execute(
                    """
                    SELECT
                      count(*)::int AS orders,
                      count(*) FILTER (WHERE status = 'settled')::int AS settled_orders,
                      count(*) FILTER (WHERE status = 'settled' AND coalesce(pnl, 0) > 0)::int AS wins,
                      count(*) FILTER (WHERE status = 'settled' AND coalesce(pnl, 0) <= 0)::int AS losses,
                      count(*) FILTER (WHERE status IN ('paper', 'pending', 'submitted', 'partially_matched'))::int AS open_orders,
                      coalesce(sum(CASE WHEN status = 'settled' THEN pnl ELSE 0 END), 0)::float AS pnl,
                      coalesce(sum(CASE WHEN status = 'settled' THEN coalesce(matched_stake, stake_amount) ELSE 0 END), 0)::float AS staked,
                      avg(CASE WHEN status = 'settled' THEN clv ELSE NULL END)::float AS clv
                    FROM paper_orders
                    """
                ).fetchone()
        if not row:
            return None
        pnl = round(float(row["pnl"] or 0), 2)
        staked = float(row["staked"] or 0)
        settled = int(row["settled_orders"] or 0)
        readiness_reasons: list[str] = []
        if settled < self.settings.min_paper_signals_for_real_review:
            readiness_reasons.append(
                f"Needs {self.settings.min_paper_signals_for_real_review - settled} more settled paper signals."
            )
        readiness_reasons.append(
            f"Needs at least {self.settings.min_paper_days_for_real_review} paper-trading days before real review."
        )
        return PaperPerformance(
            orders=int(row["orders"] or 0),
            settled_orders=settled,
            wins=int(row["wins"] or 0),
            losses=int(row["losses"] or 0),
            open_orders=int(row["open_orders"] or 0),
            roi=round(pnl / staked, 4) if staked else None,
            clv=round(float(row["clv"]), 6) if row["clv"] is not None else None,
            realized_pnl=pnl,
            max_drawdown=0 if pnl >= 0 else abs(pnl) / max(1, self.settings.bankroll_starting_balance),
            calibration_error=None,
            readiness_status="review_ready"
            if settled >= self.settings.min_paper_signals_for_real_review
            else "collecting",
            readiness_reasons=readiness_reasons,
        )

    def backtest_metrics(self, request: BacktestRunRequest | None = None) -> BacktestMetrics | None:
        if not self.enabled:
            return None
        request = request or BacktestRunRequest()
        with self._connect() as conn:
            if conn is None:
                return None
            with conn.cursor() as cur:
                row = cur.execute(
                    """
                    SELECT
                      count(DISTINCT s.match_id)::int AS matches,
                      count(*)::int AS signals,
                      coalesce(sum(po.pnl), 0)::float AS pnl,
                      coalesce(sum(coalesce(po.matched_stake, po.stake_amount)), 0)::float AS staked,
                      avg(po.clv)::float AS clv,
                      avg(power(s.model_prob - CASE WHEN po.pnl > 0 THEN 1 ELSE 0 END, 2))::float AS brier
                    FROM paper_orders po
                    JOIN signals s ON s.id = po.signal_id
                    WHERE po.status = 'settled'
                    """
                ).fetchone()
        if not row or int(row["signals"] or 0) == 0:
            return None
        staked = float(row["staked"] or 0)
        roi = float(row["pnl"] or 0) / staked if staked else 0
        metrics = BacktestMetrics(
            run_id=f"bt_live_{uuid4().hex[:12]}",
            model_version=request.model_version,
            matches=int(row["matches"] or 0),
            signals=int(row["signals"] or 0),
            roi=round(roi, 4),
            clv=round(float(row["clv"] or 0), 6),
            brier_score=round(float(row["brier"] or 0.25), 6),
            log_loss=0.693,
            calibration_error=0.05,
            max_drawdown=max(0, round(-roi, 4)),
        )
        return evaluate_promotion(metrics)

    def save_backtest(self, metrics: BacktestMetrics, request: BacktestRunRequest | None = None) -> None:
        if not self.enabled:
            return
        request = request or BacktestRunRequest(model_version=metrics.model_version)
        with self._connect() as conn:
            if conn is None:
                return
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO model_versions (id, model_type, training_window, metrics, promoted, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                      metrics = EXCLUDED.metrics,
                      promoted = EXCLUDED.promoted
                    """,
                    (
                        metrics.model_version,
                        "paper_walk_forward",
                        _json(
                            {
                                "start_date": request.start_date,
                                "end_date": request.end_date,
                                "walk_forward": request.walk_forward,
                            }
                        ),
                        _json(metrics.model_dump(mode="json")),
                        metrics.promoted,
                        _now(),
                    ),
                )
                cur.execute(
                    """
                    INSERT INTO backtests (id, model_version_id, run_config, metrics, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET metrics = EXCLUDED.metrics
                    """,
                    (
                        metrics.run_id,
                        metrics.model_version,
                        _json(request.model_dump(mode="json")),
                        _json(metrics.model_dump(mode="json")),
                        _now(),
                    ),
                )

    def get_backtest(self, run_id: str) -> BacktestMetrics | None:
        if not self.enabled:
            return None
        with self._connect() as conn:
            if conn is None:
                return None
            with conn.cursor() as cur:
                if run_id == "latest":
                    row = cur.execute(
                        """
                        SELECT metrics
                        FROM backtests
                        ORDER BY created_at DESC
                        LIMIT 1
                        """
                    ).fetchone()
                else:
                    row = cur.execute(
                        "SELECT metrics FROM backtests WHERE id = %s",
                        (run_id,),
                    ).fetchone()
        if not row:
            return None
        return BacktestMetrics(**row["metrics"])

    def _upsert_player(self, cur: Any, player: Player) -> None:
        cur.execute(
            """
            INSERT INTO players (
              id, provider_ids, name, tour, country, ranking, handedness, elo_overall,
              elo_clay, elo_hard, hold_rate, break_rate, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
              provider_ids = EXCLUDED.provider_ids, name = EXCLUDED.name,
              tour = EXCLUDED.tour, country = EXCLUDED.country, ranking = EXCLUDED.ranking,
              handedness = EXCLUDED.handedness, elo_overall = EXCLUDED.elo_overall,
              elo_clay = EXCLUDED.elo_clay, elo_hard = EXCLUDED.elo_hard,
              hold_rate = EXCLUDED.hold_rate, break_rate = EXCLUDED.break_rate,
              updated_at = EXCLUDED.updated_at
            """,
            (
                player.id,
                _json(player.provider_ids),
                player.name,
                player.tour.value,
                player.country,
                player.ranking,
                player.handedness,
                player.elo_overall,
                player.elo_clay,
                player.elo_hard,
                player.hold_rate,
                player.break_rate,
                _now(),
            ),
        )

    def _insert_training_example(
        self, cur: Any, paper_order_id: int, settlement: PaperSettlement
    ) -> None:
        row = cur.execute(
            """
            SELECT
              po.external_order_ref, po.match_id, po.player_id,
              s.model_prob, s.market_prob,
              ps.model_version_id,
              ps.feature_snapshot_id
            FROM paper_orders po
            JOIN signals s ON s.id = po.signal_id
            LEFT JOIN prediction_snapshots ps ON ps.id = s.prediction_snapshot_id
            WHERE po.id = %s
            """,
            (paper_order_id,),
        ).fetchone()
        if not row or not row["match_id"] or not row["player_id"]:
            return
        probability = float(row["model_prob"] or 0)
        bucket_lower = int(probability * 10) / 10
        calibration_bucket = f"{bucket_lower:.1f}-{bucket_lower + 0.1:.1f}"
        closing_probability = 1 / settlement.closing_odds
        cur.execute(
            """
            INSERT INTO training_examples (
              id, match_id, player_id, model_version, feature_snapshot_id,
              decision_ts, model_probability, market_probability, closing_probability,
              result_win, pnl, clv, calibration_bucket, created_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
              result_win = EXCLUDED.result_win,
              pnl = EXCLUDED.pnl,
              clv = EXCLUDED.clv
            """,
            (
                f"train_{row['external_order_ref']}",
                row["match_id"],
                row["player_id"],
                row["model_version_id"] or self.settings.model_champion_version,
                row["feature_snapshot_id"],
                settlement.settled_at,
                row["model_prob"],
                row["market_prob"],
                closing_probability,
                settlement.result_win,
                settlement.net_pnl,
                settlement.clv,
                calibration_bucket,
                _now(),
            ),
        )

    def _upsert_match(self, cur: Any, match: Match) -> None:
        cur.execute(
            """
            INSERT INTO matches (
              id, provider_ids, tournament, round, tour, competition_level, surface,
              indoor, best_of, scheduled_at, player1_id, player2_id, status,
              data_quality, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
              provider_ids = EXCLUDED.provider_ids, tournament = EXCLUDED.tournament,
              round = EXCLUDED.round, tour = EXCLUDED.tour,
              competition_level = EXCLUDED.competition_level, surface = EXCLUDED.surface,
              indoor = EXCLUDED.indoor, best_of = EXCLUDED.best_of,
              scheduled_at = EXCLUDED.scheduled_at, player1_id = EXCLUDED.player1_id,
              player2_id = EXCLUDED.player2_id, status = EXCLUDED.status,
              data_quality = EXCLUDED.data_quality, updated_at = EXCLUDED.updated_at
            """,
            (
                match.id,
                _json(match.provider_ids),
                match.tournament,
                match.round,
                match.tour.value,
                match.competition_level.value,
                match.surface.value,
                match.indoor,
                match.best_of,
                match.scheduled_at,
                match.player1.id,
                match.player2.id,
                match.state.status,
                1,
                _now(),
            ),
        )

    def _insert_score_tick(self, cur: Any, match: Match) -> None:
        cur.execute(
            """
            INSERT INTO score_ticks (match_id, provider, raw_state, source_ts, ingested_at)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                match.id,
                Provider.API_TENNIS.value,
                _json(match.state.model_dump(mode="json")),
                match.scheduled_at if match.state.status == "prematch" else _now(),
                _now(),
            ),
        )

    def _insert_odds_ticks(self, cur: Any, match: Match) -> None:
        for quote in match.odds:
            if quote.player_id not in {match.player1.id, match.player2.id}:
                continue
            cur.execute(
                """
                INSERT INTO odds_ticks (
                  match_id, provider, bookmaker, market, outcome_player_id,
                  decimal_odds, source_ts, ingested_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    match.id,
                    Provider.ODDS_API_IO.value,
                    quote.bookmaker,
                    quote.market,
                    quote.player_id,
                    quote.decimal_odds,
                    quote.source_ts,
                    quote.ingested_at,
                ),
            )

    def _insert_feature_snapshot(self, cur: Any, features: FeatureVector) -> int:
        row = cur.execute(
            """
            INSERT INTO feature_snapshots (match_id, feature_set, values, created_at)
            VALUES (%s, %s, %s, %s)
            RETURNING id
            """,
            (
                features.match_id,
                "live_budget_v1",
                _json(features.model_dump(mode="json")),
                _now(),
            ),
        ).fetchone()
        return int(row["id"])

    def _insert_prediction_snapshot(
        self, cur: Any, prediction: Prediction, feature_snapshot_id: int
    ) -> str:
        cur.execute(
            """
            INSERT INTO model_versions (id, model_type, training_window, metrics, promoted, created_at)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO NOTHING
            """,
            (
                prediction.model_version,
                "heuristic_elo_logistic",
                _json({"source": "live_budget_v1"}),
                _json({}),
                prediction.model_version == self.settings.model_champion_version,
                _now(),
            ),
        )
        prediction_id = f"pred_{uuid4().hex[:16]}"
        cur.execute(
            """
            INSERT INTO prediction_snapshots (
              id, match_id, model_version_id, mode, p1_win_prob, p2_win_prob,
              raw_p1_win_prob, raw_p2_win_prob, confidence_interval, confidence,
              feature_snapshot_id, explanations, created_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                prediction_id,
                prediction.match_id,
                prediction.model_version,
                prediction.mode,
                prediction.p1_win_prob,
                prediction.p2_win_prob,
                prediction.raw_p1_win_prob,
                prediction.raw_p2_win_prob,
                _json(prediction.confidence_interval),
                prediction.confidence.value,
                feature_snapshot_id,
                _json(prediction.explanations),
                prediction.generated_at,
            ),
        )
        return prediction_id

    def _insert_signals(self, cur: Any, signals: Iterable[Signal], prediction_id: str) -> None:
        for signal in signals:
            cur.execute(
                """
                INSERT INTO signals (
                  match_id, prediction_snapshot_id, outcome_player_id, status,
                  model_prob, market_prob, best_odds, edge, stake_fraction, risk, reason, created_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    signal.match_id,
                    prediction_id,
                    signal.player_id,
                    signal.status.value,
                    signal.model_prob,
                    signal.market_prob,
                    signal.best_odds,
                    signal.edge,
                    signal.stake_fraction,
                    _json({"threshold": signal.threshold, "confidence": signal.confidence.value, "external_signal_id": signal.id}),
                    signal.reason,
                    _now(),
                ),
            )

    def _record_latency(self, cur: Any, provider: Provider, feed: str, match: Match) -> None:
        if provider == Provider.ODDS_API_IO and match.odds:
            latest_source = max(quote.source_ts for quote in match.odds)
            latest_ingested = max(quote.ingested_at for quote in match.odds)
        else:
            latest_source = _now()
            latest_ingested = _now()
        latency_ms = max(0, int((latest_ingested - latest_source).total_seconds() * 1000))
        cur.execute(
            """
            INSERT INTO provider_latency (
              provider, feed, latest_source_ts, latest_ingested_at, latency_ms, healthy, ingested_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                provider.value,
                feed,
                latest_source,
                latest_ingested,
                latency_ms,
                latency_ms <= self.settings.max_odds_staleness_ms,
                _now(),
            ),
        )

    def _upsert_provider_cursors(self, cur: Any) -> None:
        for cursor in default_provider_cursors(self.settings):
            cur.execute(
                """
                INSERT INTO provider_cursors (
                  provider, stream, last_seq, expected_next_seq, status, gap_count,
                  resync_required, last_message_at, last_resync_at, note, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (provider, stream) DO UPDATE SET
                  last_seq = EXCLUDED.last_seq,
                  expected_next_seq = EXCLUDED.expected_next_seq,
                  status = EXCLUDED.status,
                  gap_count = EXCLUDED.gap_count,
                  resync_required = EXCLUDED.resync_required,
                  last_message_at = EXCLUDED.last_message_at,
                  last_resync_at = EXCLUDED.last_resync_at,
                  note = EXCLUDED.note,
                  updated_at = EXCLUDED.updated_at
                """,
                (
                    cursor.provider.value,
                    cursor.stream,
                    cursor.last_seq,
                    cursor.expected_next_seq,
                    cursor.status.value,
                    cursor.gap_count,
                    cursor.resync_required,
                    cursor.last_message_at,
                    cursor.last_resync_at,
                    cursor.note,
                    _now(),
                ),
            )

    def _match_from_row(self, row: dict[str, Any], odds: list[OddsQuote]) -> Match:
        p1 = Player(
            id=row["player1_id"],
            provider_ids=row["p1_provider_ids"] or {},
            name=row["p1_name"],
            tour=row["tour"],
            country=row["p1_country"] or "",
            ranking=row["p1_ranking"],
            handedness=row["p1_handedness"] or "R",
            elo_overall=float(row["p1_elo_overall"]),
            elo_clay=float(row["p1_elo_clay"]),
            elo_hard=float(row["p1_elo_hard"]),
            hold_rate=float(row["p1_hold_rate"]),
            break_rate=float(row["p1_break_rate"]),
        )
        p2 = Player(
            id=row["player2_id"],
            provider_ids=row["p2_provider_ids"] or {},
            name=row["p2_name"],
            tour=row["tour"],
            country=row["p2_country"] or "",
            ranking=row["p2_ranking"],
            handedness=row["p2_handedness"] or "R",
            elo_overall=float(row["p2_elo_overall"]),
            elo_clay=float(row["p2_elo_clay"]),
            elo_hard=float(row["p2_elo_hard"]),
            hold_rate=float(row["p2_hold_rate"]),
            break_rate=float(row["p2_break_rate"]),
        )
        raw_state = row["latest_state"] or {"status": row["status"]}
        return Match(
            id=row["id"],
            provider_ids=row["provider_ids"] or {},
            provider_match_id=(row["provider_ids"] or {}).get("api_tennis", row["id"]),
            tournament=row["tournament"],
            round=row["round"] or "TBD",
            tour=row["tour"],
            competition_level=row["competition_level"],
            surface=row["surface"],
            indoor=row["indoor"],
            best_of=row["best_of"],
            scheduled_at=row["scheduled_at"],
            player1=p1,
            player2=p2,
            state=MatchState(**raw_state),
            odds=odds,
        )
