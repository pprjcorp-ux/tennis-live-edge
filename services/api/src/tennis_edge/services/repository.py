from datetime import date, datetime, timezone
from typing import Literal
from uuid import uuid4

from tennis_edge.config import Settings
from tennis_edge.domain import (
    AgentAnomaly,
    AgentAutopilotRequest,
    AgentAutopilotResult,
    AgentBriefing,
    AgentPreflight,
    AgentRun,
    BacktestMetrics,
    BacktestRunRequest,
    BankrollSnapshot,
    CancelOrderResult,
    CalibrationReport,
    CanonicalEntityConflict,
    CostProfile,
    DailyCostReport,
    DailyMetrics,
    DataQualitySnapshot,
    ExecutionOrder,
    ExecutionStatus,
    IngestionRunRequest,
    IngestionRunRecord,
    IngestionRunResult,
    KillSwitchRequest,
    LearningPromotionRequest,
    LiveDashboardSnapshot,
    MatchAnalysis,
    ModelRegistryEntry,
    ModelPromotionDecision,
    OddsMessageIngestionRequest,
    OddsMessageIngestionResult,
    OrderRequest,
    OperationalStateSnapshot,
    PaperPerformance,
    PaperSettlement,
    PaperSettleRequest,
    ProviderCursor,
    ProviderCursorResyncRequest,
    ProviderCursorResyncResult,
    ProviderHealth,
    RawProviderPayload,
    ReplayRunRequest,
    ReplayRunResult,
    Signal,
    SignalStatus,
    CursorStatus,
    Provider,
)
from tennis_edge.services.agent_ops import (
    agent_runs,
    build_agent_briefing,
    build_agent_preflight,
    detect_anomalies,
    run_agent_autopilot,
)
from tennis_edge.providers.api_tennis import ApiTennisClient
from tennis_edge.providers.odds_api_io import OddsApiIoClient
from tennis_edge.providers.the_odds_api import TheOddsApiClient
from tennis_edge.sample_data import sample_raw_payloads
from tennis_edge.services.backtest import run_walk_forward_backtest
from tennis_edge.services.cost_profile import (
    apply_coverage_gate,
    coverage_decision,
)
from tennis_edge.services.enterprise_analytics import (
    calibration_report,
    champion_model,
    entity_conflicts,
    model_registry,
    paper_performance,
    settle_paper_order,
)
from tennis_edge.services.execution_engine import (
    CANCELABLE_ORDER_STATUSES,
    ORDERS,
    bankroll_snapshot,
    cancel_order,
    create_order,
    promote_from_learning,
    set_kill_switch_for,
)
from tennis_edge.services.normalizer import normalize_name
from tennis_edge.services.live_dashboard import LiveDashboardReadModel
from tennis_edge.services.operational_state import OperationalStateService
from tennis_edge.services.provider_cursor import mark_resynced
from tennis_edge.services.ingestion import LiveIngestionPipeline
from tennis_edge.services.replay_engine import ReplayEngine
from tennis_edge.services.storage import PersistentStore


BACKTESTS: dict[str, BacktestMetrics] = {}


class AnalysisRepository:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.api_tennis = ApiTennisClient(settings.api_tennis_key, settings.data_mode)
        self.odds_api_io = OddsApiIoClient(settings.odds_api_io_key, settings.data_mode)
        self.the_odds_api = TheOddsApiClient(settings.the_odds_api_key, settings.data_mode)
        self.replay_engine = ReplayEngine()
        self.store = PersistentStore(settings)
        self.operational_state = OperationalStateService(settings, self.store)
        self.dashboard_read_model = LiveDashboardReadModel(self.operational_state)
        self.ingestion = LiveIngestionPipeline(
            self.api_tennis,
            self.the_odds_api,
            self.store,
            signal_gate=self._gate_signals_for_match,
            archive_augmenter=self._augment_with_archive_odds,
        )

    async def analyses_for_date(self, target_date: date) -> list[MatchAnalysis]:
        snapshot = await self.ingestion.snapshot_for_date(target_date)
        if snapshot.source == "persisted_fallback":
            return [
                analysis.model_copy(
                    update={
                        "signals": self._gate_signals_for_match(
                            analysis.match,
                            analysis.signals,
                        )
                    }
                )
                for analysis in snapshot.analyses
            ]
        return snapshot.analyses

    async def _augment_with_archive_odds(self, matches, archive_source=None):
        if self.settings.data_mode == "sample" or not self.settings.the_odds_api_key:
            return matches
        try:
            source = archive_source or self.the_odds_api
            events = await source.get_tennis_h2h_events()
        except Exception:
            return matches

        by_names = {event.name_key: event for event in events}
        updated = []
        raw_payloads = []
        for match in matches:
            key = frozenset({normalize_name(match.player1.name), normalize_name(match.player2.name)})
            event = by_names.get(key)
            if not event or not event.quotes:
                updated.append(match)
                continue
            if event.raw_payload is not None:
                raw_payloads.append(event.raw_payload)
            player_map = {
                normalize_name(match.player1.name): match.player1.id,
                normalize_name(match.player2.name): match.player2.id,
            }
            translated = [
                quote.model_copy(update={"player_id": player_map[quote.player_id]})
                for quote in event.quotes
                if quote.player_id in player_map
            ]
            provider_ids = dict(match.provider_ids)
            provider_ids.setdefault("theoddsapi", event.id)
            updated.append(
                match.model_copy(
                    update={
                        "provider_ids": provider_ids,
                        "odds": translated or match.odds,
                    }
                )
            )
        self.store.save_raw_payloads(raw_payloads)
        return updated

    def _apply_provider_gates(self, signals: list[Signal]) -> list[Signal]:
        if self.settings.data_mode == "sample" or not self.settings.odds_ws_resync_required_blocks_signals:
            return signals
        cursors = self.store.provider_cursors() or self.operational_state.fallback_provider_cursors()
        odds_cursor = next(
            (
                cursor
                for cursor in cursors
                if cursor.provider == Provider.ODDS_API_IO
                and cursor.status in {CursorStatus.GAP_DETECTED, CursorStatus.RESYNC_REQUIRED}
            ),
            None,
        )
        if not odds_cursor:
            return signals
        gated: list[Signal] = []
        for signal in signals:
            status = SignalStatus.BLOCKED if signal.status == SignalStatus.ENTRY else signal.status
            gated.append(
                signal.model_copy(
                    update={
                        "status": status,
                        "stake_fraction": 0,
                        "reason": f"Odds websocket cursor requires resync; blocking entries. {signal.reason}",
                    }
                )
            )
        return gated

    def _gate_signals_for_match(self, match, signals: list[Signal]) -> list[Signal]:
        signals = apply_coverage_gate(signals, coverage_decision(match, self.settings))
        return self._apply_provider_gates(signals)

    async def live_signals(self, target_date: date) -> list[Signal]:
        analyses = await self.analyses_for_date(target_date)
        return self.dashboard_read_model.sorted_signals(analyses)

    async def run_ingestion(
        self,
        request: IngestionRunRequest | None = None,
        *,
        source: Literal["api", "cli", "openclaw", "cron", "system"] = "system",
    ) -> IngestionRunResult:
        started_at = self._now()
        target_date = request.target_date if request and request.target_date else date.today()
        snapshot = await self.ingestion.snapshot_for_date(target_date)
        signals = [signal for analysis in snapshot.analyses for signal in analysis.signals]
        result = IngestionRunResult(
            target_date=target_date,
            source=snapshot.source,
            persisted=snapshot.persisted,
            matches=len(snapshot.analyses),
            raw_payloads_saved=snapshot.raw_payloads_saved,
            signals_generated=len(signals),
            entry_signals=sum(1 for signal in signals if signal.status == SignalStatus.ENTRY),
            generated_at=snapshot.generated_at,
        )
        self.record_ingestion_run(
            "score_snapshot",
            result.model_dump(mode="json"),
            source=source,
            started_at=started_at,
        )
        return result

    def record_ingestion_run(
        self,
        run_type: Literal["score_snapshot", "odds_message", "odds_stream", "live_budget_cycle"],
        summary: dict,
        *,
        source: Literal["api", "cli", "openclaw", "cron", "system"] = "system",
        started_at: datetime | None = None,
    ) -> IngestionRunRecord:
        completed_at = self._now()
        run = IngestionRunRecord(
            id=f"ingest_{uuid4().hex[:16]}",
            run_type=run_type,
            source=source,
            status=self._ingestion_status(summary),
            summary=summary,
            started_at=started_at or completed_at,
            completed_at=completed_at,
        )
        self.store.save_ingestion_run(run)
        return run

    async def ingestion_runs(self) -> list[IngestionRunRecord]:
        return self.operational_state.ingestion_runs()

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc).replace(microsecond=0)

    @staticmethod
    def _ingestion_status(summary: dict) -> Literal["completed", "degraded", "skipped", "failed"]:
        if summary.get("error"):
            return "failed"
        if summary.get("real_execution_hard_block") is False or summary.get("can_submit_real_orders") is True:
            return "degraded"
        if summary.get("source") == "provider_live" or summary.get("connected") is True:
            return "completed"
        if summary.get("source") == "persisted_fallback" or summary.get("timed_out") is True:
            return "degraded"
        if summary.get("resync_required") is True:
            return "degraded"
        score = summary.get("score_ingestion")
        odds = summary.get("odds_ingestion")
        if isinstance(score, dict) and isinstance(odds, dict):
            if score.get("source") == "provider_live" or odds.get("connected") is True:
                return "completed"
            if score.get("source") == "persisted_fallback" or odds.get("resync_required") is True:
                return "degraded"
        return "skipped"

    async def ingest_odds_api_message(
        self,
        request: OddsMessageIngestionRequest,
    ) -> OddsMessageIngestionResult:
        persisted_cursor = self._persisted_cursor_for(Provider.ODDS_API_IO, request.stream)
        raw_payload = self.odds_api_io.raw_payload_from_message(request.payload, stream=request.stream)
        quotes, cursor = self.odds_api_io.ingest_message(
            request.payload,
            current_cursor=persisted_cursor,
            stream=request.stream,
        )
        raw_payloads_saved = self.store.save_raw_payloads([raw_payload])
        normalized_odds_saved = self.store.save_odds_quotes_for_event(
            Provider.ODDS_API_IO,
            raw_payload.source_event_id,
            quotes,
        )
        cursor_saved = self.store.save_provider_cursor(cursor)
        latency_saved = self.store.record_provider_latency(
            Provider.ODDS_API_IO,
            f"odds/{request.stream}",
            latest_source_ts=raw_payload.source_ts,
            latest_ingested_at=raw_payload.ingested_at,
        )
        return OddsMessageIngestionResult(
            stream=request.stream,
            cursor=cursor,
            quotes=len(quotes),
            raw_payloads_saved=raw_payloads_saved,
            normalized_odds_saved=normalized_odds_saved,
            persisted=(
                bool(raw_payloads_saved)
                or bool(normalized_odds_saved)
                or cursor_saved
                or latency_saved
            ),
            resync_required=cursor.resync_required,
            source_event_id=raw_payload.source_event_id,
            source_ts=raw_payload.source_ts,
        )

    def _persisted_cursor_for(self, provider: Provider, stream: str) -> ProviderCursor | None:
        return next(
            (
                cursor
                for cursor in self.store.provider_cursors()
                if cursor.provider == provider and cursor.stream == stream
            ),
            None,
        )

    async def mark_provider_cursor_resynced(
        self,
        request: ProviderCursorResyncRequest,
    ) -> ProviderCursorResyncResult:
        cursor = mark_resynced(request.provider, request.stream, request.last_seq)
        persisted = self.store.save_provider_cursor(cursor)
        return ProviderCursorResyncResult(cursor=cursor, persisted=persisted)

    async def match_detail(self, match_id: str, target_date: date) -> MatchAnalysis | None:
        analyses = await self.analyses_for_date(target_date)
        for analysis in analyses:
            if analysis.match.id == match_id:
                return analysis
        return None

    async def provider_health(self) -> list[ProviderHealth]:
        return self.operational_state.provider_health()

    async def cost_profile(self) -> CostProfile:
        return self.operational_state.cost_profile()

    async def daily_cost_report(self, target_date: date) -> DailyCostReport:
        return self.operational_state.daily_cost_report(
            target_date,
            await self.analyses_for_date(target_date),
            await self.paper_performance(),
        )

    async def data_quality(self) -> list[DataQualitySnapshot]:
        return self.operational_state.data_quality()

    async def provider_cursors(self) -> list[ProviderCursor]:
        return self.operational_state.provider_cursors()

    async def model_registry(self) -> list[ModelRegistryEntry]:
        persisted = self.store.model_registry()
        return persisted or model_registry(self.settings)

    async def champion_model(self) -> ModelRegistryEntry:
        persisted = self.store.champion_model()
        return persisted or champion_model(self.settings)

    async def calibration_report(self, run_id: str) -> CalibrationReport:
        persisted = self.store.calibration_report(run_id)
        return persisted or calibration_report(run_id)

    async def entity_conflicts(self) -> list[CanonicalEntityConflict]:
        persisted = self.store.entity_conflicts()
        return persisted or entity_conflicts()

    async def paper_performance(self) -> PaperPerformance:
        persisted = self.store.paper_performance()
        return persisted or paper_performance(self.settings, await self.orders())

    async def agent_briefing(self) -> AgentBriefing:
        analyses = await self.analyses_for_date(date.today())
        order_snapshot = await self.orders()
        bankroll = await self.bankroll(order_snapshot)
        persisted_runs = self.store.agent_runs()
        latest_run = persisted_runs[0] if persisted_runs else self._sample_latest_agent_run()
        return build_agent_briefing(
            self.settings,
            analyses=analyses,
            provider_health=await self.provider_health(),
            provider_cursors=await self.provider_cursors(),
            data_quality=await self.data_quality(),
            execution_status=await self.execution_status(),
            paper_performance=await self.paper_performance(),
            bankroll=bankroll,
            cost_report=await self.daily_cost_report(date.today()),
            orders=order_snapshot,
            latest_run=latest_run,
        )

    async def agent_anomalies(self) -> list[AgentAnomaly]:
        analyses = await self.analyses_for_date(date.today())
        return detect_anomalies(
            self.settings,
            analyses=analyses,
            provider_health=await self.provider_health(),
            provider_cursors=await self.provider_cursors(),
            data_quality=await self.data_quality(),
            execution_status=await self.execution_status(),
            paper_performance=await self.paper_performance(),
            bankroll=await self.bankroll(),
            cost_report=await self.daily_cost_report(date.today()),
        )

    async def agent_preflight(self) -> AgentPreflight:
        return build_agent_preflight(
            self.settings,
            provider_health=await self.provider_health(),
            execution_status=await self.execution_status(),
            persistence_last_error=self.store.last_error,
        )

    async def agent_autopilot(
        self, request: AgentAutopilotRequest
    ) -> AgentAutopilotResult:
        analyses = await self.analyses_for_date(date.today())
        order_snapshot = await self.orders()
        bankroll = await self.bankroll(order_snapshot)
        anomalies = detect_anomalies(
            self.settings,
            analyses=analyses,
            provider_health=await self.provider_health(),
            provider_cursors=await self.provider_cursors(),
            data_quality=await self.data_quality(),
            execution_status=await self.execution_status(),
            paper_performance=await self.paper_performance(),
            bankroll=bankroll,
            cost_report=await self.daily_cost_report(date.today()),
        )
        result = run_agent_autopilot(
            self.settings,
            analyses,
            request,
            anomalies,
            orders=order_snapshot,
        )
        for order in result.created_orders:
            self.store.save_order(order)
        self.store.save_agent_run(result.run)
        return result

    async def agent_runs(self) -> list[AgentRun]:
        merged = {run.id: run for run in self.store.agent_runs()}
        if self.settings.data_mode == "sample":
            for run in agent_runs():
                merged.setdefault(run.id, run)
        return sorted(
            merged.values(),
            key=lambda run: (
                any(route.model == self.settings.openclaw_critical_model for route in run.model_routes),
                run.created_at,
            ),
            reverse=True,
        )

    def _sample_latest_agent_run(self) -> AgentRun | None:
        if self.settings.data_mode != "sample":
            return None
        return next(iter(agent_runs()), None)

    async def settle_paper(self, request: PaperSettleRequest) -> PaperSettlement:
        persisted = self.store.settle_paper_order(request)
        if persisted is not None:
            return persisted
        if self.settings.data_mode != "sample":
            raise KeyError(request.order_id)
        try:
            settlement = settle_paper_order(request)
        except KeyError:
            raise
        self.store.save_settlement(settlement)
        return settlement

    async def execution_status(self) -> ExecutionStatus:
        return self.operational_state.execution_status()

    async def operational_state_snapshot(self, target_date: date) -> OperationalStateSnapshot:
        analyses = await self.analyses_for_date(target_date)
        performance = await self.paper_performance()
        return self.dashboard_read_model.operational_state_snapshot(
            target_date,
            analyses,
            performance,
        )

    async def live_dashboard_snapshot(self, target_date: date) -> LiveDashboardSnapshot:
        analyses = await self.analyses_for_date(target_date)
        performance = await self.paper_performance()
        return self.dashboard_read_model.snapshot(target_date, analyses, performance)

    async def bankroll(self, orders: list[ExecutionOrder] | None = None) -> BankrollSnapshot:
        return bankroll_snapshot(self.settings, orders if orders is not None else await self.orders())

    async def orders(self) -> list[ExecutionOrder]:
        merged = {order.id: order for order in self.store.orders()}
        if self.settings.data_mode == "sample":
            for order in ORDERS.values():
                merged.setdefault(order.id, order)
        return sorted(merged.values(), key=lambda order: order.created_at, reverse=True)

    async def create_paper_order(self, request: OrderRequest) -> ExecutionOrder:
        order_snapshot = await self.orders()
        order = create_order(
            self.settings,
            await self.analyses_for_date(date.today()),
            request,
            real=False,
            orders=order_snapshot,
        )
        self.store.save_order(order)
        return order

    async def submit_order(self, request: OrderRequest) -> ExecutionOrder:
        order_snapshot = await self.orders()
        order = create_order(
            self.settings,
            await self.analyses_for_date(date.today()),
            request,
            real=True,
            orders=order_snapshot,
        )
        self.store.save_order(order)
        return order

    async def cancel_order(self, order_id: str) -> CancelOrderResult:
        persisted_order = next(
            (order for order in self.store.orders() if order.id == order_id),
            None,
        )
        if persisted_order is not None and persisted_order.status not in CANCELABLE_ORDER_STATUSES:
            return CancelOrderResult(
                order_id=order_id,
                status=persisted_order.status,
                reason="Order is not open; no cancellation sent.",
            )
        if persisted_order is not None:
            status = self.store.cancel_order(order_id)
            if status is not None:
                return CancelOrderResult(
                    order_id=order_id,
                    status=status,
                    reason="Persisted paper order cancelled.",
                )
            return CancelOrderResult(
                order_id=order_id,
                status=persisted_order.status,
                reason="Persisted paper order could not be cancelled.",
            )
        return cancel_order(order_id)

    async def set_kill_switch(self, request: KillSwitchRequest) -> ExecutionStatus:
        return set_kill_switch_for(self.settings, request)

    async def promote_from_learning(
        self, request: LearningPromotionRequest
    ) -> ModelPromotionDecision:
        decision = promote_from_learning(request)
        self.store.save_model_promotion_decision(decision)
        return decision

    async def run_replay(self, request: ReplayRunRequest) -> ReplayRunResult:
        analyses = await self.analyses_for_date(date.today())
        signal_count = sum(
            1
            for analysis in analyses
            if analysis.match.id == request.match_id
            for signal in analysis.signals
            if signal.status == SignalStatus.ENTRY
        )
        payloads = self._raw_payloads_for_replay(request.match_id, analyses)
        return self.replay_engine.summarize(request.match_id, payloads, signals=signal_count)

    def _raw_payloads_for_replay(
        self,
        match_id: str,
        analyses: list[MatchAnalysis],
    ) -> list[RawProviderPayload]:
        for candidate in self._raw_payload_id_candidates(match_id, analyses):
            payloads = self.store.raw_payloads_for_match(candidate)
            if payloads:
                return payloads
        if self.settings.data_mode == "sample":
            return sample_raw_payloads(match_id)
        return []

    @staticmethod
    def _raw_payload_id_candidates(match_id: str, analyses: list[MatchAnalysis]) -> list[str]:
        candidates = [match_id]
        match = next((analysis.match for analysis in analyses if analysis.match.id == match_id), None)
        if match is not None:
            candidates.extend([match.provider_match_id, *match.provider_ids.values()])
        return list(dict.fromkeys(candidate for candidate in candidates if candidate))

    async def run_backtest(self, request: BacktestRunRequest | None = None) -> BacktestMetrics:
        metrics = self.store.backtest_metrics(request) or run_walk_forward_backtest(request)
        self.store.save_backtest(metrics, request)
        if self.settings.data_mode == "sample":
            BACKTESTS[metrics.run_id] = metrics
        return metrics

    async def get_backtest(self, run_id: str) -> BacktestMetrics:
        persisted = self.store.get_backtest(run_id)
        if persisted is not None:
            return persisted
        if self.settings.data_mode == "sample":
            if run_id == "latest" and BACKTESTS:
                return list(BACKTESTS.values())[-1]
            if run_id in BACKTESTS:
                return BACKTESTS[run_id]
        raise KeyError(run_id)

    async def daily_metrics(self, target_date: date) -> DailyMetrics:
        analyses = await self.analyses_for_date(target_date)
        paper = await self.paper_performance()
        return self.dashboard_read_model.daily_metrics(analyses, paper)
