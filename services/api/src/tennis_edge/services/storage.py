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
    AgentRun,
    CalibrationBucket,
    CalibrationReport,
    Confidence,
    CursorStatus,
    CanonicalEntityConflict,
    DataQualitySnapshot,
    ExecutionOrder,
    ExecutionVenue,
    FeatureVector,
    IngestionRunRecord,
    KillSwitchRequest,
    Match,
    MatchAnalysis,
    MatchFreshness,
    MatchState,
    ModelRegistryEntry,
    ModelPromotionDecision,
    OddsQuote,
    OrderStatus,
    PaperPerformance,
    PaperPerformanceSegment,
    PaperSettlement,
    PaperSettleRequest,
    Player,
    Prediction,
    Provider,
    ProviderCursor,
    ProviderHealth,
    RawProviderPayload,
    ScoreTick,
    Signal,
    SignalStatus,
    TrainingExample,
)
from tennis_edge.services.model_lab import (
    calibration_from_training_examples,
    walk_forward_from_training_examples,
)
from tennis_edge.services.execution_engine import (
    CANCELABLE_ORDER_STATUSES,
    OPEN_ORDER_STATUSES,
)
from tennis_edge.services.cost_profile import (
    cost_profile,
    provider_health_for,
)
from tennis_edge.services.normalizer import normalize_name
from tennis_edge.services.provider_cursor import default_provider_cursors
from tennis_edge.services.provider_lineage import (
    odds_provider_for_match,
    provider_lineage_for_ids,
    provider_lineage_for_match,
    primary_provider_for_match,
)


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


def _provider_warnings_from_summary(summary: Any) -> list[str]:
    if not isinstance(summary, dict):
        return []
    warnings = summary.get("provider_warnings")
    if not isinstance(warnings, list):
        return []
    return [str(warning) for warning in warnings if warning]


def _feed_age_ms(row: dict[str, Any]) -> int | None:
    latest_ingested_at = row.get("latest_ingested_at")
    if not isinstance(latest_ingested_at, datetime):
        return None
    return max(0, int((_now() - latest_ingested_at).total_seconds() * 1000))


def _feed_stale(row: dict[str, Any], settings: Settings) -> bool:
    age_ms = _feed_age_ms(row)
    if age_ms is None:
        return False
    return age_ms > settings.max_odds_staleness_ms


PERSISTED_OPEN_ORDER_STATUSES = tuple(status.value for status in OPEN_ORDER_STATUSES)
PERSISTED_CANCELABLE_ORDER_STATUSES = tuple(status.value for status in CANCELABLE_ORDER_STATUSES)


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

        try:
            conn = psycopg.connect(
                self.settings.database_url,
                autocommit=True,
                row_factory=dict_row,
            )
        except Exception as exc:  # pragma: no cover - exercised with real DB failures.
            self.last_error = str(exc)
            yield None
            return

        try:
            yield conn
        finally:
            try:
                conn.close()
            except Exception:
                pass

    @contextmanager
    def _write_transaction(self, conn: Any):
        transaction = getattr(conn, "transaction", None)
        if transaction is None:
            yield
            return
        with transaction():
            yield

    def _record_read_error(self, operation: str, exc: Exception) -> None:
        self.last_error = f"{operation} failed: {exc}"

    def _record_write_error(self, operation: str, exc: Exception) -> None:
        self.last_error = f"{operation} failed: {exc}"

    def kill_switch_state(self) -> dict[str, object] | None:
        if not self.enabled:
            return None
        with self._connect() as conn:
            if conn is None:
                return None
            try:
                with conn.cursor() as cur:
                    self._ensure_execution_controls_table(cur)
                    row = cur.execute(
                        """
                        SELECT enabled, reason
                        FROM execution_controls
                        WHERE key = %s
                        """,
                        ("kill_switch",),
                    ).fetchone()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("kill_switch_state", exc)
                return {
                    "enabled": True,
                    "reason": f"kill switch state unavailable: {exc}",
                }
        if not row:
            return None
        return {
            "enabled": bool(row["enabled"]),
            "reason": row["reason"] or "not set",
        }

    def save_kill_switch(self, request: KillSwitchRequest) -> bool:
        if not self.enabled:
            return False
        with self._connect() as conn:
            if conn is None:
                return False
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        self._ensure_execution_controls_table(cur)
                        cur.execute(
                            """
                            INSERT INTO execution_controls (key, enabled, reason, updated_at)
                            VALUES (%s, %s, %s, %s)
                            ON CONFLICT (key) DO UPDATE SET
                              enabled = EXCLUDED.enabled,
                              reason = EXCLUDED.reason,
                              updated_at = EXCLUDED.updated_at
                            """,
                            ("kill_switch", request.enabled, request.reason, _now()),
                        )
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_kill_switch", exc)
                return False
        return True

    def save_analyses(self, analyses: Iterable[MatchAnalysis]) -> bool:
        analyses = list(analyses)
        if not self.enabled:
            return False
        if not analyses:
            return False
        with self._connect() as conn:
            if conn is None:
                return False
            existing_cursors = self.provider_cursors()
            try:
                with self._write_transaction(conn):
                    for analysis in analyses:
                        with conn.cursor() as cur:
                            self._upsert_player(cur, analysis.match.player1)
                            self._upsert_player(cur, analysis.match.player2)
                            self._upsert_match(cur, analysis.match)
                            self._insert_score_tick(cur, analysis.match, analysis.freshness)
                            self._insert_odds_ticks(cur, analysis.match)
                            feature_id = self._insert_feature_snapshot(cur, analysis.features)
                            prediction_id = self._insert_prediction_snapshot(
                                cur, analysis.prediction, feature_id
                            )
                            self._insert_signals(
                                cur,
                                analysis.signals,
                                prediction_id,
                                analysis.match,
                            )
                            self._record_latency(
                                cur,
                                primary_provider_for_match(analysis.match),
                                "score/live",
                                analysis.match,
                            )
                            odds_provider = odds_provider_for_match(analysis.match)
                            if odds_provider is not None:
                                self._record_latency(
                                    cur,
                                    odds_provider,
                                    "odds/moneyline",
                                    analysis.match,
                                )
                            self._upsert_provider_cursors(cur, existing_cursors=existing_cursors)
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_analyses", exc)
                return False
        return True

    def save_raw_payloads(self, payloads: list[RawProviderPayload]) -> int:
        if not self.enabled or not payloads:
            return 0
        inserted = 0
        with self._connect() as conn:
            if conn is None:
                return 0
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        for payload in payloads:
                            cur.execute(
                                """
                                INSERT INTO raw_provider_payloads (
                                  id, provider, payload_type, source_event_id, source_ts,
                                  ingested_at, checksum, payload
                                )
                                SELECT %s, %s, %s, %s, %s, %s, %s, %s
                                WHERE NOT EXISTS (
                                  SELECT 1 FROM raw_provider_payloads WHERE checksum = %s
                                )
                                """,
                                (
                                    payload.id,
                                    payload.provider.value,
                                    payload.payload_type,
                                    payload.source_event_id,
                                    payload.source_ts,
                                    payload.ingested_at,
                                    payload.checksum,
                                    _json(payload.payload),
                                    payload.checksum,
                                ),
                            )
                            inserted += max(0, cur.rowcount)
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_raw_payloads", exc)
                return 0
        return inserted

    def provider_usage_counts(self, target_date: date) -> dict[Provider, int]:
        if not self.enabled:
            return {}
        with self._connect() as conn:
            if conn is None:
                return {}
            try:
                with conn.cursor() as cur:
                    rows = cur.execute(
                        """
                        SELECT provider, count(*)::int AS count
                        FROM raw_provider_payloads
                        WHERE ingested_at::date = %s
                        GROUP BY provider
                        """,
                        (target_date,),
                    ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("provider_usage_counts", exc)
                return {}
        return {Provider(row["provider"]): int(row["count"] or 0) for row in rows}

    def odds_stream_usage(self, target_date: date) -> dict[str, Any]:
        if not self.enabled:
            return {}
        with self._connect() as conn:
            if conn is None:
                return {}
            try:
                with conn.cursor() as cur:
                    self._ensure_ingestion_runs_table(cur)
                    rows = cur.execute(
                        """
                        SELECT summary, started_at, completed_at
                        FROM ingestion_runs
                        WHERE run_type = 'odds_stream'
                          AND completed_at::date = %s
                        """,
                        (target_date,),
                    ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("odds_stream_usage", exc)
                return {}
        if not rows:
            return {}
        connected_runs = 0
        websocket_minutes = 0
        for row in rows:
            summary = row["summary"] or {}
            if not summary.get("connected"):
                continue
            connected_runs += 1
            started_at = row["started_at"]
            completed_at = row["completed_at"]
            duration_seconds = max(0, int((completed_at - started_at).total_seconds()))
            websocket_minutes += max(1, round(duration_seconds / 60))
        return {
            "websocket_uptime_pct": round(connected_runs / len(rows), 4),
            "provider_websocket_minutes": {
                Provider.ODDS_API_IO: websocket_minutes,
            },
        }

    def save_provider_cursor(self, cursor: ProviderCursor) -> bool:
        if not self.enabled:
            return False
        with self._connect() as conn:
            if conn is None:
                return False
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        self._upsert_one_provider_cursor(cur, cursor)
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_provider_cursor", exc)
                return False
        return True

    def record_provider_latency(
        self,
        provider: Provider,
        feed: str,
        *,
        latest_source_ts: datetime,
        latest_ingested_at: datetime,
    ) -> bool:
        if not self.enabled:
            return False
        with self._connect() as conn:
            if conn is None:
                return False
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        self._insert_provider_latency(
                            cur,
                            provider,
                            feed,
                            latest_source_ts=latest_source_ts,
                            latest_ingested_at=latest_ingested_at,
                        )
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("record_provider_latency", exc)
                return False
        return True

    def save_score_ticks(self, ticks: list[ScoreTick]) -> int:
        if not self.enabled or not ticks:
            return 0
        inserted = 0
        with self._connect() as conn:
            if conn is None:
                return 0
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        for tick in ticks:
                            cur.execute(
                                """
                                INSERT INTO score_ticks (
                                  match_id, provider, raw_state, source_ts, ingested_at
                                )
                                SELECT %s, %s, %s, %s, %s
                                WHERE NOT EXISTS (
                                  SELECT 1
                                  FROM score_ticks
                                  WHERE match_id = %s
                                    AND provider = %s
                                    AND raw_state = %s
                                    AND source_ts = %s
                                )
                                """,
                                (
                                    tick.match_id,
                                    tick.provider.value,
                                    _json(tick.state.model_dump(mode="json")),
                                    tick.source_ts,
                                    tick.ingested_at,
                                    tick.match_id,
                                    tick.provider.value,
                                    _json(tick.state.model_dump(mode="json")),
                                    tick.source_ts,
                                ),
                            )
                            inserted += max(0, cur.rowcount)
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_score_ticks", exc)
                return 0
        return inserted

    def save_odds_quotes_for_event(
        self,
        provider: Provider,
        source_event_id: str,
        quotes: list[OddsQuote],
    ) -> int:
        if not self.enabled or not quotes:
            return 0
        with self._connect() as conn:
            if conn is None:
                return 0
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        match_row = self._match_row_for_provider_event(cur, source_event_id)
                        if not match_row:
                            return 0
                        player_lookup = self._player_lookup_from_match_row(match_row)
                        inserted = 0
                        for quote in quotes:
                            player_id = player_lookup.get(str(quote.player_id)) or player_lookup.get(
                                normalize_name(str(quote.player_id))
                            )
                            if player_id is None:
                                continue
                            inserted += self._insert_odds_quote(
                                cur,
                                match_id=match_row["match_id"],
                                provider=provider,
                                quote=quote.model_copy(update={"player_id": player_id}),
                            )
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_odds_quotes_for_event", exc)
                return 0
        return inserted

    def raw_payloads_for_match(self, match_id: str) -> list[RawProviderPayload]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            try:
                with conn.cursor() as cur:
                    rows = cur.execute(
                        """
                        SELECT id, provider, payload_type, source_event_id, source_ts,
                               ingested_at, checksum, payload
                        FROM raw_provider_payloads
                        WHERE source_event_id = %s
                        ORDER BY source_ts ASC, ingested_at ASC
                        """,
                        (match_id,),
                    ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("raw_payloads_for_match", exc)
                return []
        return [
            RawProviderPayload(
                id=row["id"],
                provider=Provider(row["provider"]),
                payload_type=row["payload_type"],
                source_event_id=row["source_event_id"],
                source_ts=row["source_ts"],
                ingested_at=row["ingested_at"],
                checksum=row["checksum"],
                payload=row["payload"],
            )
            for row in rows
        ]

    def latest_analyses(self, target_date: date) -> list[MatchAnalysis]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            try:
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
                          st.raw_state AS latest_state,
                          st.source_ts AS latest_score_source_ts,
                          st.ingested_at AS latest_score_ingested_at
                        FROM matches m
                        JOIN players p1 ON p1.id = m.player1_id
                        JOIN players p2 ON p2.id = m.player2_id
                        LEFT JOIN LATERAL (
                          SELECT raw_state, source_ts, ingested_at
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
                    match_ids = [row["id"] for row in rows]
                    odds_rows = cur.execute(
                        """
                        SELECT DISTINCT ON (match_id, bookmaker, market, outcome_player_id)
                          match_id, bookmaker, market, outcome_player_id, decimal_odds, source_ts, ingested_at
                        FROM odds_ticks
                        WHERE match_id = ANY(%s)
                        ORDER BY match_id, bookmaker, market, outcome_player_id, source_ts DESC, ingested_at DESC
                        """,
                        (match_ids,),
                    ).fetchall()
                    prediction_rows = cur.execute(
                        """
                        SELECT DISTINCT ON (ps.match_id)
                          ps.id, ps.match_id, ps.model_version_id, ps.mode,
                          ps.p1_win_prob, ps.p2_win_prob, ps.raw_p1_win_prob,
                          ps.raw_p2_win_prob, ps.confidence_interval, ps.confidence,
                          ps.explanations, fs.values AS feature_values
                        FROM prediction_snapshots ps
                        LEFT JOIN feature_snapshots fs ON fs.id = ps.feature_snapshot_id
                        WHERE ps.match_id = ANY(%s)
                        ORDER BY ps.match_id, ps.created_at DESC
                        """,
                        (match_ids,),
                    ).fetchall()
                    prediction_ids = [row["id"] for row in prediction_rows]
                    signal_rows = []
                    if prediction_ids:
                        signal_rows = cur.execute(
                            """
                            SELECT
                              match_id, prediction_snapshot_id, outcome_player_id, status,
                              p.name AS player_name,
                              model_prob, market_prob, best_odds, edge, stake_fraction,
                              risk, reason
                            FROM signals
                            LEFT JOIN players p ON p.id = outcome_player_id
                            WHERE prediction_snapshot_id = ANY(%s)
                            ORDER BY created_at DESC
                            """,
                            (prediction_ids,),
                        ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("latest_analyses", exc)
                return []
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
        predictions_by_match = {row["match_id"]: row for row in prediction_rows}
        signals_by_prediction: dict[str, list[Signal]] = {}
        for row in signal_rows:
            risk = row["risk"] or {}
            signal_id = risk.get("external_signal_id") or f"{row['match_id']}:{row['outcome_player_id']}"
            signals_by_prediction.setdefault(row["prediction_snapshot_id"], []).append(
                Signal(
                    id=signal_id,
                    match_id=row["match_id"],
                    player_id=row["outcome_player_id"],
                    player_name=row["player_name"] or row["outcome_player_id"],
                    status=SignalStatus(row["status"]),
                    model_prob=float(row["model_prob"]),
                    market_prob=float(row["market_prob"]),
                    best_odds=float(row["best_odds"]),
                    edge=float(row["edge"]),
                    stake_fraction=float(row["stake_fraction"]),
                    threshold=float(risk.get("threshold", 0)),
                    confidence=Confidence(risk.get("confidence", Confidence.LOW.value)),
                    reason=row["reason"],
                )
            )

        analyses: list[MatchAnalysis] = []
        skipped_incomplete = 0
        for row in rows:
            prediction_row = predictions_by_match.get(row["id"])
            if not prediction_row or not prediction_row["feature_values"]:
                skipped_incomplete += 1
                continue
            match = self._match_from_row(row, odds_by_match.get(row["id"], []))
            features = FeatureVector(**prediction_row["feature_values"])
            prediction = Prediction(
                match_id=match.id,
                p1_win_prob=float(prediction_row["p1_win_prob"]),
                p2_win_prob=float(prediction_row["p2_win_prob"]),
                raw_p1_win_prob=float(prediction_row["raw_p1_win_prob"])
                if prediction_row["raw_p1_win_prob"] is not None
                else None,
                raw_p2_win_prob=float(prediction_row["raw_p2_win_prob"])
                if prediction_row["raw_p2_win_prob"] is not None
                else None,
                confidence=Confidence(prediction_row["confidence"]),
                mode=prediction_row["mode"],
                model_version=prediction_row["model_version_id"],
                confidence_interval=tuple(prediction_row["confidence_interval"])
                if prediction_row["confidence_interval"]
                else None,
                explanations=prediction_row["explanations"] or [],
            )
            signals = signals_by_prediction.get(prediction_row["id"], [])
            analyses.append(
                MatchAnalysis(
                    match=match,
                    features=features,
                    prediction=prediction,
                    signals=signals,
                    freshness=self._freshness_from_row(
                        row,
                        odds_by_match.get(row["id"], []),
                    ),
                )
            )
        if skipped_incomplete:
            self._record_read_error(
                "latest_analyses",
                RuntimeError(
                    f"{skipped_incomplete} persisted matches missing prediction snapshots"
                ),
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
            try:
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
                    self._ensure_ingestion_runs_table(cur)
                    score_run = cur.execute(
                        """
                        SELECT summary
                        FROM ingestion_runs
                        WHERE run_type = 'score_snapshot'
                        ORDER BY completed_at DESC
                        LIMIT 1
                        """
                    ).fetchone()
                    score_warnings = _provider_warnings_from_summary(
                        score_run["summary"] if score_run else {}
                    )
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("provider_health", exc)
                return [
                    item.model_copy(
                        update={
                            "healthy": False
                            if item.provider
                            in {Provider.API_TENNIS, Provider.ODDS_API_IO, Provider.THE_ODDS_API}
                            else item.healthy,
                            "status": f"{item.status}; persistence unavailable: {self.last_error}",
                        }
                    )
                    for item in base
                ]
        by_provider: dict[str, list[dict[str, Any]]] = {}
        for row in latencies:
            by_provider.setdefault(row["provider"], []).append(row)
        updated: list[ProviderHealth] = []
        for item in base:
            rows = by_provider.get(item.provider.value, [])
            score_degraded = item.provider == Provider.API_TENNIS and bool(score_warnings)
            if rows:
                feeds = ", ".join(str(row["feed"]) for row in rows[:3])
                stale_feeds = [
                    str(row["feed"]) for row in rows if _feed_stale(row, self.settings)
                ]
                status = f"{item.status}; persisted {feeds}"
                if stale_feeds:
                    status = f"{status}; stale persisted feed: {', '.join(stale_feeds[:3])}"
                if score_degraded:
                    status = f"{status}; degraded: {'; '.join(score_warnings[:2])}"
                latest_ingested_at = max(
                    row["latest_ingested_at"] for row in rows if row["latest_ingested_at"]
                )
                max_latency_ms = max(
                    row["latency_ms"] for row in rows if row["latency_ms"] is not None
                )
                updated.append(
                    item.model_copy(
                        update={
                            "healthy": (
                                item.healthy
                                and all(bool(row["healthy"]) for row in rows)
                                and not stale_feeds
                                and not score_degraded
                            ),
                            "latency_ms": max_latency_ms,
                            "last_message_at": latest_ingested_at,
                            "status": status,
                            "quota_used": call_counts.get(item.provider.value, item.quota_used),
                            "last_billable_call_at": latest_ingested_at,
                        }
                    )
                )
            else:
                if score_degraded:
                    updated.append(
                        item.model_copy(
                            update={
                                "healthy": False,
                                "status": f"{item.status}; degraded: {'; '.join(score_warnings[:2])}",
                            }
                        )
                    )
                else:
                    updated.append(item)
        return updated

    def has_replay_activity(self) -> bool:
        if not self.enabled:
            return False
        with self._connect() as conn:
            if conn is None:
                return False
            try:
                with conn.cursor() as cur:
                    row = cur.execute(
                        """
                        SELECT 1
                        FROM provider_latency
                        WHERE feed LIKE %s
                        LIMIT 1
                        """,
                        ("%/replay%",),
                    ).fetchone()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("has_replay_activity", exc)
                return False
        return row is not None

    def provider_cursors(self) -> list[ProviderCursor]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            try:
                with conn.cursor() as cur:
                    rows = cur.execute(
                        """
                        SELECT provider, stream, last_seq, expected_next_seq, status, gap_count,
                               resync_required, last_message_at, last_resync_at, note
                        FROM provider_cursors
                        ORDER BY provider, stream
                        """
                    ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("provider_cursors", exc)
                return []
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
            try:
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
                    latency_rows = cur.execute(
                        """
                        SELECT DISTINCT ON (provider, feed)
                          provider, feed, latest_ingested_at, latency_ms, healthy
                        FROM provider_latency
                        ORDER BY provider, feed, ingested_at DESC
                        """
                    ).fetchall()
                    self._ensure_ingestion_runs_table(cur)
                    score_run = cur.execute(
                        """
                        SELECT summary
                        FROM ingestion_runs
                        WHERE run_type = 'score_snapshot'
                        ORDER BY completed_at DESC
                        LIMIT 1
                        """
                    ).fetchone()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("data_quality", exc)
                return []
        matches = max(1, counts.get("matches", 0))
        score_completeness = min(1.0, counts.get("scores", 0) / matches)
        odds_completeness = min(1.0, counts.get("odds", 0) / max(1, matches * 2))
        gaps = int(cursor_rows["gaps"] if cursor_rows else 0)
        score_warnings = _provider_warnings_from_summary(
            score_run["summary"] if score_run else {}
        )
        stale_latency_rows = [
            row for row in latency_rows if _feed_stale(row, self.settings)
        ]
        max_latency_ms = max((row["latency_ms"] for row in latency_rows), default=None)
        sequence_health = 0.35 if gaps else 1.0
        if score_warnings:
            sequence_health = min(sequence_health, 0.7)
        if stale_latency_rows:
            sequence_health = min(sequence_health, 0.5)
        notes = [
            "Computed from persisted matches, score ticks, odds ticks and cursor state.",
            "Signals should abstain when odds are incomplete, stale or resync_required.",
        ]
        if score_warnings:
            notes.append(f"Latest score ingestion warnings: {'; '.join(score_warnings[:2])}.")
        if stale_latency_rows:
            stale_feeds = ", ".join(
                f"{row['provider']}:{row['feed']}" for row in stale_latency_rows[:3]
            )
            notes.append(f"Latest provider latency rows are stale: {stale_feeds}.")
        return [
            DataQualitySnapshot(
                id="dq_persisted_live_budget",
                provider=Provider.API_TENNIS,
                feed="persisted/live-budget",
                score_completeness=round(score_completeness, 4),
                odds_completeness=round(odds_completeness, 4),
                entity_resolution_rate=1.0 if counts.get("matches", 0) else 0.0,
                sequence_health=sequence_health,
                latency_ms=max_latency_ms,
                stale_ticks=len(stale_latency_rows),
                blocked_signals=gaps + len(score_warnings) + len(stale_latency_rows),
                notes=notes,
            )
        ]

    def entity_conflicts(self) -> list[CanonicalEntityConflict]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            try:
                with conn.cursor() as cur:
                    rows = cur.execute(
                        """
                        SELECT id, entity_type, provider, canonical_id, candidate_id,
                               confidence, similarity, reason, source_payload_ids, created_at
                        FROM canonical_entity_conflicts
                        WHERE resolved_at IS NULL
                        ORDER BY created_at DESC, id ASC
                        """
                    ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("entity_conflicts", exc)
                return []
        return [
            CanonicalEntityConflict(
                id=row["id"],
                entity_type=row["entity_type"],
                provider=Provider(row["provider"]),
                canonical_id=row["canonical_id"],
                candidate_id=row["candidate_id"],
                confidence=Confidence(row["confidence"]),
                similarity=float(row["similarity"]),
                reason=row["reason"],
                source_payload_ids=row["source_payload_ids"] or [],
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def save_model_promotion_decision(self, decision: ModelPromotionDecision) -> None:
        if not self.enabled:
            return
        with self._connect() as conn:
            if conn is None:
                return
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            INSERT INTO learning_runs (
                              id, model_version_id, run_type, training_window,
                              metrics, promoted, created_at
                            )
                            VALUES (%s, NULL, %s, %s, %s, %s, %s)
                            ON CONFLICT (id) DO UPDATE SET
                              metrics = EXCLUDED.metrics,
                              promoted = EXCLUDED.promoted
                            """,
                            (
                                decision.run_id,
                                "promotion_review",
                                _json({"source": "promote_from_learning"}),
                                _json(decision.metrics.model_dump(mode="json")),
                                decision.promoted,
                                decision.created_at,
                            ),
                        )
                        cur.execute(
                            """
                            INSERT INTO model_promotion_decisions (
                              learning_run_id, candidate_model_version,
                              promoted, reasons, metrics, created_at
                            )
                            VALUES (%s, %s, %s, %s, %s, %s)
                            """,
                            (
                                decision.run_id,
                                decision.candidate_model_version,
                                decision.promoted,
                                _json(decision.reasons),
                                _json(decision.metrics.model_dump(mode="json")),
                                decision.created_at,
                            ),
                        )
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_model_promotion_decision", exc)

    def save_order(self, order: ExecutionOrder) -> None:
        if not self.enabled:
            return
        with self._connect() as conn:
            if conn is None:
                return
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        signal_row = cur.execute(
                            """
                            SELECT id
                            FROM signals
                            WHERE risk->>'external_signal_id' = %s
                               OR (match_id = %s AND outcome_player_id = %s)
                            ORDER BY
                              CASE WHEN risk->>'external_signal_id' = %s THEN 0 ELSE 1 END,
                              created_at DESC
                            LIMIT 1
                            """,
                            (
                                order.signal_id,
                                order.match_id,
                                order.player_id,
                                order.signal_id,
                            ),
                        ).fetchone()
                        if not signal_row:
                            return
                        order_row = cur.execute(
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
                            RETURNING id
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
                        ).fetchone()
                        if order_row and order.matched_stake > 0 and order.average_price:
                            self._insert_paper_fill(cur, int(order_row["id"]), order)
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_order", exc)

    def save_agent_run(self, run: AgentRun) -> None:
        if not self.enabled:
            return
        with self._connect() as conn:
            if conn is None:
                return
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            INSERT INTO agent_runs (
                              id, run_type, source, model_routes, actions, summary, created_at
                            )
                            VALUES (%s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (id) DO UPDATE SET
                              run_type = EXCLUDED.run_type,
                              source = EXCLUDED.source,
                              model_routes = EXCLUDED.model_routes,
                              actions = EXCLUDED.actions,
                              summary = EXCLUDED.summary,
                              created_at = EXCLUDED.created_at
                            """,
                            (
                                run.id,
                                run.run_type.value,
                                run.source,
                                _json([route.model_dump(mode="json") for route in run.model_routes]),
                                _json([action.model_dump(mode="json") for action in run.actions]),
                                run.summary,
                                run.created_at,
                            ),
                        )
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_agent_run", exc)

    def save_ingestion_run(self, run: IngestionRunRecord) -> bool:
        if not self.enabled:
            return False
        with self._connect() as conn:
            if conn is None:
                return False
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        self._ensure_ingestion_runs_table(cur)
                        cur.execute(
                            """
                            INSERT INTO ingestion_runs (
                              id, run_type, source, status, summary, started_at, completed_at
                            )
                            VALUES (%s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (id) DO UPDATE SET
                              run_type = EXCLUDED.run_type,
                              source = EXCLUDED.source,
                              status = EXCLUDED.status,
                              summary = EXCLUDED.summary,
                              started_at = EXCLUDED.started_at,
                              completed_at = EXCLUDED.completed_at
                            """,
                            (
                                run.id,
                                run.run_type,
                                run.source,
                                run.status,
                                _json(run.summary),
                                run.started_at,
                                run.completed_at,
                            ),
                        )
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_ingestion_run", exc)
                return False
        return True

    def ingestion_runs(self, limit: int = 50) -> list[IngestionRunRecord]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            try:
                with conn.cursor() as cur:
                    self._ensure_ingestion_runs_table(cur)
                    rows = cur.execute(
                        """
                        SELECT id, run_type, source, status, summary, started_at, completed_at
                        FROM ingestion_runs
                        ORDER BY completed_at DESC
                        LIMIT %s
                        """,
                        (limit,),
                    ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("ingestion_runs", exc)
                return []
        return [
            IngestionRunRecord(
                id=row["id"],
                run_type=row["run_type"],
                source=row["source"],
                status=row["status"],
                summary=row["summary"] or {},
                started_at=row["started_at"],
                completed_at=row["completed_at"],
            )
            for row in rows
        ]

    def agent_runs(self, limit: int = 50) -> list[AgentRun]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            try:
                with conn.cursor() as cur:
                    rows = cur.execute(
                        """
                        SELECT id, run_type, source, model_routes, actions, summary, created_at
                        FROM agent_runs
                        ORDER BY created_at DESC
                        LIMIT %s
                        """,
                        (limit,),
                    ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("agent_runs", exc)
                return []
        return [
            AgentRun(
                id=row["id"],
                run_type=row["run_type"],
                source=row["source"],
                model_routes=row["model_routes"] or [],
                actions=row["actions"] or [],
                summary=row["summary"],
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def orders(self) -> list[ExecutionOrder]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            try:
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
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("orders", exc)
                return []
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
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        row = cur.execute(
                            """
                            UPDATE paper_orders
                            SET status = %s,
                                audit = audit || %s::jsonb
                            WHERE external_order_ref = %s
                              AND status = ANY(%s)
                            RETURNING status
                            """,
                            (
                                OrderStatus.CANCELLED.value,
                                _json(["Persisted paper order cancelled by admin request."]),
                                order_id,
                                list(PERSISTED_CANCELABLE_ORDER_STATUSES),
                            ),
                        ).fetchone()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("cancel_order", exc)
                return None
        if not row:
            return None
        return OrderStatus(row["status"])

    def settle_paper_order(self, request: PaperSettleRequest) -> PaperSettlement | None:
        if not self.enabled:
            return None
        with self._connect() as conn:
            if conn is None:
                return None
            try:
                with conn.cursor() as cur:
                    row = cur.execute(
                        """
                        SELECT
                          po.external_order_ref, po.match_id, po.player_id,
                          po.requested_odds, po.average_price, po.matched_stake,
                          po.stake_amount, po.status,
                          ps.result_win, ps.gross_pnl, ps.commission, ps.net_pnl,
                          ps.closing_odds, ps.clv, ps.settled_at
                        FROM paper_orders po
                        LEFT JOIN LATERAL (
                          SELECT result_win, gross_pnl, commission, net_pnl,
                                 closing_odds, clv, settled_at
                          FROM paper_settlements
                          WHERE paper_order_id = po.id
                          ORDER BY settled_at DESC, id DESC
                          LIMIT 1
                        ) ps ON TRUE
                        WHERE po.external_order_ref = %s
                        ORDER BY po.created_at DESC
                        LIMIT 1
                        """,
                        (request.order_id,),
                    ).fetchone()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("settle_paper_order", exc)
                return None
        if not row:
            return None
        if row["status"] == OrderStatus.SETTLED.value and row["closing_odds"] is not None:
            return PaperSettlement(
                order_id=request.order_id,
                status=OrderStatus.SETTLED,
                result_win=row["result_win"],
                requested_odds=float(row["requested_odds"]),
                average_price=float(row["average_price"] or row["requested_odds"]),
                matched_stake=float(row["matched_stake"] or row["stake_amount"] or 0),
                gross_pnl=float(row["gross_pnl"]),
                commission=float(row["commission"]),
                net_pnl=float(row["net_pnl"]),
                closing_odds=float(row["closing_odds"]),
                clv=float(row["clv"]),
                settled_at=row["settled_at"],
            )
        if row["status"] not in PERSISTED_OPEN_ORDER_STATUSES:
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
        if not self.save_settlement(settlement):
            return None
        return settlement

    def save_settlement(self, settlement: PaperSettlement) -> bool:
        if not self.enabled:
            return False
        with self._connect() as conn:
            if conn is None:
                return False
            try:
                with self._write_transaction(conn):
                    with conn.cursor() as cur:
                        row = cur.execute(
                            """
                            SELECT id, status
                            FROM paper_orders
                            WHERE external_order_ref = %s
                            ORDER BY created_at DESC
                            LIMIT 1
                            """,
                            (settlement.order_id,),
                        ).fetchone()
                        if not row:
                            return False
                        if row["status"] == OrderStatus.SETTLED.value:
                            return True
                        if row["status"] not in PERSISTED_OPEN_ORDER_STATUSES:
                            return False
                        paper_order_id = row["id"]
                        self._insert_closing_line_snapshot(cur, paper_order_id, settlement)
                        cur.execute(
                            """
                            INSERT INTO paper_settlements (
                              paper_order_id, result_win, requested_odds, average_price,
                              matched_stake, gross_pnl, commission, net_pnl, closing_odds,
                              clv, settled_at
                            )
                            SELECT %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                            WHERE NOT EXISTS (
                              SELECT 1 FROM paper_settlements WHERE paper_order_id = %s
                            )
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
                                paper_order_id,
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
                                average_price = %s,
                                audit = audit || %s::jsonb
                            WHERE id = %s
                              AND status = ANY(%s)
                            """,
                            (
                                OrderStatus.SETTLED.value,
                                "settled",
                                settlement.net_pnl,
                                settlement.clv,
                                settlement.matched_stake,
                                settlement.average_price,
                                _json(["Paper order settled with closing-line CLV."]),
                                paper_order_id,
                                list(PERSISTED_OPEN_ORDER_STATUSES),
                            ),
                        )
                        self._insert_training_example(cur, paper_order_id, settlement)
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_settlement", exc)
                return False
        return True

    def paper_performance(self) -> PaperPerformance | None:
        if not self.enabled:
            return None
        with self._connect() as conn:
            if conn is None:
                return None
            try:
                with conn.cursor() as cur:
                    row = cur.execute(
                        """
                        SELECT
                          count(*)::int AS orders,
                          count(*) FILTER (WHERE status = 'settled')::int AS settled_orders,
                          count(*) FILTER (WHERE status = 'settled' AND coalesce(clv, 0) > 0)::int AS positive_clv_signals,
                          count(*) FILTER (WHERE status = 'settled' AND coalesce(pnl, 0) > 0)::int AS wins,
                          count(*) FILTER (WHERE status = 'settled' AND coalesce(pnl, 0) <= 0)::int AS losses,
                          count(*) FILTER (WHERE status = ANY(%s))::int AS open_orders,
                          coalesce(sum(CASE WHEN status = 'settled' THEN pnl ELSE 0 END), 0)::float AS pnl,
                          coalesce(sum(CASE WHEN status = 'settled' THEN coalesce(matched_stake, stake_amount) ELSE 0 END), 0)::float AS staked,
                          avg(CASE WHEN status = 'settled' THEN clv ELSE NULL END)::float AS clv
                        FROM paper_orders
                        """,
                        (list(PERSISTED_OPEN_ORDER_STATUSES),),
                    ).fetchone()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("paper_performance", exc)
                return None
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
            positive_clv_signals=int(row["positive_clv_signals"] or 0),
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
            segments=self._paper_performance_segments(),
        )

    def training_examples(
        self, request: BacktestRunRequest | None = None
    ) -> list[TrainingExample]:
        if not self.enabled:
            return []
        request = request or BacktestRunRequest()
        with self._connect() as conn:
            if conn is None:
                return []
            try:
                with conn.cursor() as cur:
                    rows = cur.execute(
                        """
                        SELECT
                          te.id, te.match_id, te.player_id, te.model_version, te.feature_snapshot_id,
                          coalesce(fs.feature_set, 'unknown') AS feature_set,
                          te.decision_ts, te.model_probability, te.market_probability,
                          te.closing_probability, te.result_win, te.pnl, te.clv, te.stake_amount,
                          te.calibration_bucket
                        FROM training_examples te
                        LEFT JOIN feature_snapshots fs ON fs.id = te.feature_snapshot_id
                        WHERE te.model_version = %s
                          AND te.result_win IS NOT NULL
                          AND te.pnl IS NOT NULL
                          AND (%s::text IS NULL OR fs.feature_set = %s::text)
                          AND (%s::date IS NULL OR te.decision_ts::date >= %s::date)
                          AND (%s::date IS NULL OR te.decision_ts::date <= %s::date)
                        ORDER BY te.decision_ts ASC
                        """,
                        (
                            request.model_version,
                            request.feature_set,
                            request.feature_set,
                            request.start_date,
                            request.start_date,
                            request.end_date,
                            request.end_date,
                        ),
                    ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("training_examples", exc)
                return []
        examples: list[TrainingExample] = []
        for row in rows:
            examples.append(
                TrainingExample(
                    id=row["id"],
                    match_id=row["match_id"],
                    player_id=row["player_id"],
                    model_version=row["model_version"],
                    feature_snapshot_id=str(row["feature_snapshot_id"] or ""),
                    feature_set=str(row["feature_set"] or "unknown"),
                    decision_ts=row["decision_ts"],
                    model_probability=float(row["model_probability"]),
                    market_probability=float(row["market_probability"]),
                    closing_probability=float(row["closing_probability"])
                    if row["closing_probability"] is not None
                    else None,
                    result_win=row["result_win"],
                    pnl=float(row["pnl"]) if row["pnl"] is not None else None,
                    clv=float(row["clv"]) if row["clv"] is not None else None,
                    stake_amount=float(row["stake_amount"] or 1),
                    calibration_bucket=row["calibration_bucket"],
                )
            )
        return examples

    def training_example_count(self, request: BacktestRunRequest | None = None) -> int:
        if not self.enabled:
            return 0
        model_version = request.model_version if request else None
        feature_set = request.feature_set if request else None
        start_date = request.start_date if request else None
        end_date = request.end_date if request else None
        with self._connect() as conn:
            if conn is None:
                return 0
            try:
                with conn.cursor() as cur:
                    row = cur.execute(
                        """
                        SELECT count(*)::int AS examples
                        FROM training_examples te
                        LEFT JOIN feature_snapshots fs ON fs.id = te.feature_snapshot_id
                        WHERE te.result_win IS NOT NULL
                          AND te.pnl IS NOT NULL
                          AND (%s::text IS NULL OR te.model_version = %s::text)
                          AND (%s::text IS NULL OR fs.feature_set = %s::text)
                          AND (%s::date IS NULL OR te.decision_ts::date >= %s::date)
                          AND (%s::date IS NULL OR te.decision_ts::date <= %s::date)
                        """,
                        (
                            model_version,
                            model_version,
                            feature_set,
                            feature_set,
                            start_date,
                            start_date,
                            end_date,
                            end_date,
                        ),
                    ).fetchone()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("training_example_count", exc)
                return 0
        return int(row["examples"] or 0) if row else 0

    def backtest_metrics(self, request: BacktestRunRequest | None = None) -> BacktestMetrics | None:
        request = request or BacktestRunRequest()
        examples = self.training_examples(request)
        if not examples:
            return None
        return walk_forward_from_training_examples(request, examples)

    def save_backtest(self, metrics: BacktestMetrics, request: BacktestRunRequest | None = None) -> None:
        if not self.enabled:
            return
        request = request or BacktestRunRequest(model_version=metrics.model_version)
        with self._connect() as conn:
            if conn is None:
                return
            try:
                with self._write_transaction(conn):
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
                        examples = self.training_examples(request)
                        if examples:
                            report = calibration_from_training_examples(
                                metrics.run_id,
                                metrics.model_version,
                                examples,
                            )
                            self._save_calibration_report(cur, report)
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_write_error("save_backtest", exc)

    def get_backtest(self, run_id: str) -> BacktestMetrics | None:
        if not self.enabled:
            return None
        with self._connect() as conn:
            if conn is None:
                return None
            try:
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
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("get_backtest", exc)
                return None
        if not row:
            return None
        return BacktestMetrics(**row["metrics"])

    def calibration_report(self, run_id: str) -> CalibrationReport | None:
        if not self.enabled:
            return None
        with self._connect() as conn:
            if conn is None:
                return None
            try:
                with conn.cursor() as cur:
                    row = cur.execute(
                        """
                        SELECT run_id, model_version, buckets, brier_score, log_loss,
                               calibration_error, generated_at
                        FROM calibration_reports
                        WHERE run_id = %s
                        """,
                        (run_id,),
                    ).fetchone()
                    if row:
                        return CalibrationReport(
                            run_id=row["run_id"],
                            model_version=row["model_version"],
                            buckets=[CalibrationBucket(**bucket) for bucket in row["buckets"]],
                            brier_score=float(row["brier_score"]),
                            log_loss=float(row["log_loss"]),
                            calibration_error=float(row["calibration_error"]),
                            generated_at=row["generated_at"],
                        )
                    backtest_row = cur.execute(
                        "SELECT model_version_id, run_config FROM backtests WHERE id = %s",
                        (run_id,),
                    ).fetchone()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("calibration_report", exc)
                return None
        if not backtest_row:
            return None
        run_config = backtest_row.get("run_config") if isinstance(backtest_row, dict) else None
        if isinstance(run_config, dict):
            run_config = {
                **run_config,
                "model_version": run_config.get("model_version")
                or backtest_row["model_version_id"],
            }
            request = BacktestRunRequest(**run_config)
        else:
            request = BacktestRunRequest(model_version=backtest_row["model_version_id"])
        examples = self.training_examples(request)
        if not examples:
            return None
        return calibration_from_training_examples(run_id, request.model_version, examples)

    def model_registry(self) -> list[ModelRegistryEntry] | None:
        if not self.enabled:
            return None
        with self._connect() as conn:
            if conn is None:
                return None
            try:
                with conn.cursor() as cur:
                    rows = cur.execute(
                        """
                        SELECT id, model_type, training_window, metrics, promoted, created_at
                        FROM model_versions
                        ORDER BY promoted DESC, created_at DESC, id ASC
                        """
                    ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("model_registry", exc)
                return None
        if not rows:
            return None
        entries: list[ModelRegistryEntry] = []
        for row in rows:
            metrics = row["metrics"] or {}
            if "run_id" not in metrics:
                continue
            training_window = row["training_window"] or {}
            promoted = bool(row["promoted"])
            model_version = row["id"]
            if promoted or model_version == self.settings.model_champion_version:
                role = "champion"
            elif model_version == "baseline_v0":
                role = "baseline"
            else:
                role = "challenger"
            entries.append(
                ModelRegistryEntry(
                    model_version=model_version,
                    role=role,
                    model_type=row["model_type"],
                    feature_set=str(training_window.get("feature_set") or training_window.get("source") or "persisted"),
                    training_window=training_window,
                    metrics=BacktestMetrics(**metrics),
                    promoted=promoted,
                    promoted_at=row["created_at"] if promoted else None,
                    notes=["Loaded from persisted model_versions/backtests."],
                )
            )
        return entries or None

    def champion_model(self) -> ModelRegistryEntry | None:
        entries = self.model_registry()
        if not entries:
            return None
        return next(
            (entry for entry in entries if entry.role == "champion"),
            entries[0],
        )

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
              po.stake_amount, po.matched_stake, po.created_at AS order_created_at,
              s.model_prob, s.market_prob,
              ps.model_version_id,
              ps.feature_snapshot_id,
              ps.created_at AS prediction_created_at
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
              result_win, pnl, clv, stake_amount, calibration_bucket, created_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
              closing_probability = EXCLUDED.closing_probability,
              result_win = EXCLUDED.result_win,
              pnl = EXCLUDED.pnl,
              clv = EXCLUDED.clv,
              stake_amount = EXCLUDED.stake_amount
            """,
            (
                f"train_{row['external_order_ref']}",
                row["match_id"],
                row["player_id"],
                row["model_version_id"] or self.settings.model_champion_version,
                row["feature_snapshot_id"],
                row["prediction_created_at"] or row["order_created_at"],
                row["model_prob"],
                row["market_prob"],
                closing_probability,
                settlement.result_win,
                settlement.net_pnl,
                settlement.clv,
                row["matched_stake"] or row["stake_amount"] or 1,
                calibration_bucket,
                _now(),
            ),
        )

    def _save_calibration_report(self, cur: Any, report: CalibrationReport) -> None:
        cur.execute(
            """
            INSERT INTO calibration_reports (
              run_id, model_version, buckets, brier_score, log_loss,
              calibration_error, generated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (run_id) DO UPDATE SET
              model_version = EXCLUDED.model_version,
              buckets = EXCLUDED.buckets,
              brier_score = EXCLUDED.brier_score,
              log_loss = EXCLUDED.log_loss,
              calibration_error = EXCLUDED.calibration_error,
              generated_at = EXCLUDED.generated_at
            """,
            (
                report.run_id,
                report.model_version,
                _json([bucket.model_dump(mode="json") for bucket in report.buckets]),
                report.brier_score,
                report.log_loss,
                report.calibration_error,
                report.generated_at,
            ),
        )

    def _insert_paper_fill(self, cur: Any, paper_order_id: int, order: ExecutionOrder) -> None:
        available_odds = order.average_price or order.accepted_odds or order.requested_odds
        unmatched = round(max(0, order.stake_amount - order.matched_stake), 2)
        slippage = round(order.requested_odds - available_odds, 4)
        cur.execute(
            """
            INSERT INTO paper_fills (
              paper_order_id, status, requested_odds, available_odds,
              matched_stake, average_price, unmatched_stake, slippage,
              commission_rate, event_ts
            )
            SELECT %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            WHERE NOT EXISTS (
              SELECT 1 FROM paper_fills WHERE paper_order_id = %s
            )
            """,
            (
                paper_order_id,
                order.status.value,
                order.requested_odds,
                available_odds,
                order.matched_stake,
                available_odds,
                unmatched,
                slippage,
                0.02,
                order.created_at,
                paper_order_id,
            ),
        )

    def _insert_closing_line_snapshot(
        self, cur: Any, paper_order_id: int, settlement: PaperSettlement
    ) -> None:
        row = cur.execute(
            """
            SELECT match_id, player_id
            FROM paper_orders
            WHERE id = %s
            """,
            (paper_order_id,),
        ).fetchone()
        if not row or not row["match_id"] or not row["player_id"]:
            return
        cur.execute(
            """
            INSERT INTO closing_line_snapshots (
              match_id, player_id, bookmaker, closing_decimal_odds,
              no_vig_probability, source_ts, created_at
            )
            SELECT %s, %s, %s, %s, %s, %s, %s
            WHERE NOT EXISTS (
              SELECT 1
              FROM closing_line_snapshots
              WHERE match_id = %s
                AND player_id = %s
                AND bookmaker = %s
                AND source_ts = %s
            )
            """,
            (
                row["match_id"],
                row["player_id"],
                "closing_proxy",
                settlement.closing_odds,
                round(1 / settlement.closing_odds, 6),
                settlement.settled_at,
                _now(),
                row["match_id"],
                row["player_id"],
                "closing_proxy",
                settlement.settled_at,
            ),
        )

    def _paper_performance_segments(self) -> list[PaperPerformanceSegment]:
        if not self.enabled:
            return []
        with self._connect() as conn:
            if conn is None:
                return []
            try:
                with conn.cursor() as cur:
                    rows = cur.execute(
                        """
                        WITH settled AS (
                          SELECT
                            po.id,
                            po.pnl::float AS pnl,
                            po.clv::float AS clv,
                            coalesce(po.matched_stake, po.stake_amount)::float AS staked,
                            coalesce(po.average_price, po.accepted_odds, po.requested_odds)::float AS odds,
                            coalesce(
                              s.risk->>'odds_provider',
                              po.risk_snapshot->>'odds_provider',
                              po.risk_snapshot->>'provider',
                              po.venue,
                              'unknown'
                            ) AS provider,
                            m.surface,
                            m.tour,
                            ps.model_version_id AS model_version
                          FROM paper_orders po
                          JOIN signals s ON s.id = po.signal_id
                          LEFT JOIN prediction_snapshots ps ON ps.id = s.prediction_snapshot_id
                          LEFT JOIN matches m ON m.id = po.match_id
                          WHERE po.status = 'settled'
                        ),
                        segmented AS (
                          SELECT 'model' AS segment_type, coalesce(model_version, 'unknown') AS segment, * FROM settled
                          UNION ALL
                          SELECT 'odds_bucket', concat(floor(odds * 2) / 2, '-', floor(odds * 2) / 2 + 0.5), * FROM settled
                          UNION ALL
                          SELECT 'surface', coalesce(surface, 'unknown'), * FROM settled
                          UNION ALL
                          SELECT 'tour', coalesce(tour, 'unknown'), * FROM settled
                          UNION ALL
                          SELECT 'provider', coalesce(provider, 'unknown'), * FROM settled
                        )
                        SELECT
                          segment_type,
                          segment,
                          count(*)::int AS settled_orders,
                          coalesce(sum(pnl), 0)::float AS realized_pnl,
                          coalesce(sum(staked), 0)::float AS staked,
                          avg(clv)::float AS clv
                        FROM segmented
                        GROUP BY segment_type, segment
                        ORDER BY segment_type, segment
                        """
                    ).fetchall()
            except Exception as exc:  # pragma: no cover - exercised with DB drift tests.
                self._record_read_error("paper_performance_segments", exc)
                return []
        segments: list[PaperPerformanceSegment] = []
        for row in rows:
            staked = float(row["staked"] or 0)
            pnl = float(row["realized_pnl"] or 0)
            segments.append(
                PaperPerformanceSegment(
                    segment_type=row["segment_type"],
                    segment=str(row["segment"]),
                    settled_orders=int(row["settled_orders"] or 0),
                    roi=round(pnl / staked, 4) if staked else None,
                    clv=round(float(row["clv"]), 6) if row["clv"] is not None else None,
                    realized_pnl=round(pnl, 2),
                )
            )
        return segments

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

    def _insert_score_tick(
        self,
        cur: Any,
        match: Match,
        freshness: MatchFreshness | None = None,
    ) -> None:
        source_ts = self._score_tick_source_ts(match, freshness)
        provider = self._score_tick_provider(match, freshness)
        cur.execute(
            """
            INSERT INTO score_ticks (match_id, provider, raw_state, source_ts, ingested_at)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                match.id,
                provider.value,
                _json(match.state.model_dump(mode="json")),
                source_ts,
                _now(),
            ),
        )

    def _score_tick_source_ts(
        self,
        match: Match,
        freshness: MatchFreshness | None,
    ) -> datetime:
        if freshness and freshness.score_source_ts:
            return freshness.score_source_ts
        if match.state.status == "prematch":
            return match.scheduled_at
        return _now()

    def _score_tick_provider(
        self,
        match: Match,
        freshness: MatchFreshness | None,
    ) -> Provider:
        if freshness and freshness.provider_lineage:
            return freshness.provider_lineage[0]
        return primary_provider_for_match(match)

    def _insert_odds_ticks(self, cur: Any, match: Match) -> None:
        provider = odds_provider_for_match(match) or Provider.ODDS_API_IO
        for quote in match.odds:
            if quote.player_id not in {match.player1.id, match.player2.id}:
                continue
            self._insert_odds_quote(
                cur,
                match_id=match.id,
                provider=provider,
                quote=quote,
            )

    def _insert_odds_quote(
        self,
        cur: Any,
        *,
        match_id: str,
        provider: Provider,
        quote: OddsQuote,
    ) -> int:
        cur.execute(
            """
            INSERT INTO odds_ticks (
              match_id, provider, bookmaker, market, outcome_player_id,
              decimal_odds, source_ts, ingested_at
            )
            SELECT %s, %s, %s, %s, %s, %s, %s, %s
            WHERE NOT EXISTS (
              SELECT 1 FROM odds_ticks
              WHERE match_id = %s
                AND provider = %s
                AND bookmaker = %s
                AND market = %s
                AND outcome_player_id = %s
                AND decimal_odds = %s
                AND source_ts = %s
            )
            """,
            (
                match_id,
                provider.value,
                quote.bookmaker,
                quote.market,
                quote.player_id,
                quote.decimal_odds,
                quote.source_ts,
                quote.ingested_at,
                match_id,
                provider.value,
                quote.bookmaker,
                quote.market,
                quote.player_id,
                quote.decimal_odds,
                quote.source_ts,
            ),
        )
        return max(0, cur.rowcount)

    def _ensure_ingestion_runs_table(self, cur: Any) -> None:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS ingestion_runs (
              id TEXT PRIMARY KEY,
              run_type TEXT NOT NULL,
              source TEXT NOT NULL,
              status TEXT NOT NULL,
              summary JSONB NOT NULL DEFAULT '{}',
              started_at TIMESTAMPTZ NOT NULL,
              completed_at TIMESTAMPTZ NOT NULL
            )
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS ingestion_runs_completed_idx
              ON ingestion_runs (completed_at DESC)
            """
        )

    def _ensure_execution_controls_table(self, cur: Any) -> None:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS execution_controls (
              key TEXT PRIMARY KEY,
              enabled BOOLEAN NOT NULL DEFAULT false,
              reason TEXT NOT NULL DEFAULT 'not set',
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )

    def _match_row_for_provider_event(self, cur: Any, source_event_id: str) -> dict[str, Any] | None:
        return cur.execute(
            """
            SELECT
              m.id AS match_id,
              m.player1_id,
              m.player2_id,
              p1.name AS p1_name,
              p1.provider_ids AS p1_provider_ids,
              p2.name AS p2_name,
              p2.provider_ids AS p2_provider_ids
            FROM matches m
            JOIN players p1 ON p1.id = m.player1_id
            JOIN players p2 ON p2.id = m.player2_id
            WHERE m.id = %s
               OR EXISTS (
                 SELECT 1
                 FROM jsonb_each_text(m.provider_ids) provider_id(key, value)
                 WHERE provider_id.value = %s
               )
            ORDER BY m.updated_at DESC
            LIMIT 1
            """,
            (source_event_id, source_event_id),
        ).fetchone()

    def _player_lookup_from_match_row(self, row: dict[str, Any]) -> dict[str, str]:
        lookup: dict[str, str] = {}
        self._add_player_lookup_entries(
            lookup,
            row["player1_id"],
            row.get("p1_name"),
            row.get("p1_provider_ids") or {},
        )
        self._add_player_lookup_entries(
            lookup,
            row["player2_id"],
            row.get("p2_name"),
            row.get("p2_provider_ids") or {},
        )
        return lookup

    def _add_player_lookup_entries(
        self,
        lookup: dict[str, str],
        player_id: str,
        player_name: str | None,
        provider_ids: dict[str, Any],
    ) -> None:
        for candidate in [player_id, player_name, *provider_ids.values()]:
            if candidate is None:
                continue
            value = str(candidate)
            lookup[value] = player_id
            normalized = normalize_name(value)
            if normalized:
                lookup[normalized] = player_id

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

    def _insert_signals(
        self,
        cur: Any,
        signals: Iterable[Signal],
        prediction_id: str,
        match: Match,
    ) -> None:
        odds_provider = odds_provider_for_match(match)
        risk_context = {
            "score_provider": primary_provider_for_match(match).value,
            "odds_provider": odds_provider.value if odds_provider is not None else None,
            "provider_lineage": [
                provider.value for provider in provider_lineage_for_match(match)
            ],
        }
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
                    _json(
                        {
                            "threshold": signal.threshold,
                            "confidence": signal.confidence.value,
                            "external_signal_id": signal.id,
                            **risk_context,
                        }
                    ),
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
        self._insert_provider_latency(
            cur,
            provider,
            feed,
            latest_source_ts=latest_source,
            latest_ingested_at=latest_ingested,
        )

    def _insert_provider_latency(
        self,
        cur: Any,
        provider: Provider,
        feed: str,
        *,
        latest_source_ts: datetime,
        latest_ingested_at: datetime,
    ) -> None:
        latency_ms = max(0, int((latest_ingested_at - latest_source_ts).total_seconds() * 1000))
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
                latest_source_ts,
                latest_ingested_at,
                latency_ms,
                latency_ms <= self.settings.max_odds_staleness_ms,
                _now(),
            ),
        )

    def _upsert_one_provider_cursor(self, cur: Any, cursor: ProviderCursor) -> None:
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

    def _upsert_provider_cursors(
        self,
        cur: Any,
        existing_cursors: list[ProviderCursor] | None = None,
    ) -> None:
        merged = {
            (cursor.provider, cursor.stream): cursor
            for cursor in default_provider_cursors(
                self.settings,
                use_process_cache=False,
            )
        }
        for cursor in existing_cursors or []:
            merged[(cursor.provider, cursor.stream)] = cursor
        for cursor in sorted(merged.values(), key=lambda item: (item.provider, item.stream)):
            self._upsert_one_provider_cursor(cur, cursor)

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

    def _freshness_from_row(
        self,
        row: dict[str, Any],
        odds: list[OddsQuote],
    ) -> MatchFreshness:
        now = _now()
        score_source_ts = row.get("latest_score_source_ts")
        odds_source_ts = max((quote.source_ts for quote in odds), default=None)
        provider_ids = row["provider_ids"] or {}
        provider_lineage = provider_lineage_for_ids(provider_ids, has_odds=bool(odds))
        return MatchFreshness(
            source="persisted_fallback",
            persisted=True,
            score_source_ts=score_source_ts,
            odds_source_ts=odds_source_ts,
            score_age_ms=max(0, int((now - score_source_ts).total_seconds() * 1000))
            if score_source_ts
            else None,
            odds_age_ms=max(0, int((now - odds_source_ts).total_seconds() * 1000))
            if odds_source_ts
            else None,
            provider_lineage=provider_lineage,
            note="Loaded from persisted canonical match, latest score tick, odds tick and decision snapshot.",
        )
