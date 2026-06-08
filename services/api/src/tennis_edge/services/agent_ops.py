from collections.abc import Callable, Iterable
from datetime import datetime, timezone
import socket
from uuid import uuid4

from tennis_edge.config import Settings
from tennis_edge.domain import (
    AgentAction,
    AgentActionStatus,
    AgentAnomaly,
    AgentAutopilotRequest,
    AgentAutopilotResult,
    AgentBriefing,
    AgentModelRoute,
    AgentPreflight,
    AgentPreflightCheck,
    AgentRun,
    AgentRunType,
    BankrollSnapshot,
    DailyCostReport,
    DataQualitySnapshot,
    ExecutionStatus,
    ExecutionOrder,
    MatchAnalysis,
    OrderRequest,
    OrderStatus,
    PaperPerformance,
    ProviderCursor,
    ProviderHealth,
    Signal,
    SignalStatus,
)
from tennis_edge.services.execution_engine import ORDERS, create_order


AGENT_RUNS: list[AgentRun] = []


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _run_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def _entry_signals(analyses: list[MatchAnalysis]) -> list[Signal]:
    return sorted(
        [
            signal
            for analysis in analyses
            for signal in analysis.signals
            if signal.status == SignalStatus.ENTRY
        ],
        key=lambda signal: signal.edge,
        reverse=True,
    )


def _order_snapshot(orders: Iterable[ExecutionOrder] | None = None) -> list[ExecutionOrder]:
    return list(orders) if orders is not None else list(ORDERS.values())


def _open_order_count(orders: Iterable[ExecutionOrder] | None = None) -> int:
    return sum(
        1
        for order in _order_snapshot(orders)
        if order.status
        in {
            OrderStatus.PAPER,
            OrderStatus.PENDING,
            OrderStatus.SUBMITTED,
            OrderStatus.PARTIALLY_MATCHED,
            OrderStatus.MATCHED,
        }
    )


def _model_routes(settings: Settings, *, critical: bool = False) -> list[AgentModelRoute]:
    routes = [
        AgentModelRoute(
            task="triage, briefing, routine paper-autopilot summaries",
            model=settings.openclaw_triage_model,
            reason="Cheap route for routine monitoring; deterministic Python still computes edge, risk and orders.",
            estimated_cost_usd=0.02,
        )
    ]
    if critical:
        routes.append(
            AgentModelRoute(
                task="critical anomaly, readiness review, model-promotion report",
                model=settings.openclaw_critical_model,
                reason="Strong route reserved for high-impact reviews; default is GPT-5.5 Pro lane.",
                estimated_cost_usd=0.4,
            )
        )
    return routes


def _critical_anomalies(anomalies: Iterable[AgentAnomaly]) -> list[AgentAnomaly]:
    return [anomaly for anomaly in anomalies if anomaly.severity == "critical"]


def _summarize_anomalies(anomalies: list[AgentAnomaly]) -> str:
    summaries = [anomaly.summary for anomaly in anomalies[:3]]
    if len(anomalies) > 3:
        summaries.append(f"+{len(anomalies) - 3} more")
    return "; ".join(summaries)


def probe_openclaw_gateway(host: str = "127.0.0.1", port: int = 18789) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def build_agent_preflight(
    settings: Settings,
    *,
    provider_health: list[ProviderHealth],
    execution_status: ExecutionStatus,
    persistence_last_error: str | None,
    gateway_probe: Callable[[], bool] = probe_openclaw_gateway,
) -> AgentPreflight:
    checks = [
        AgentPreflightCheck(
            name="api",
            status="pass",
            summary="FastAPI Agent Ops endpoint is responding.",
        )
    ]
    checks.append(
        AgentPreflightCheck(
            name="admin_api_token",
            status="pass" if settings.admin_api_token else "warn",
            summary=(
                "Admin token configured for protected OpenClaw actions."
                if settings.admin_api_token
                else "Admin token missing; OpenClaw can read but cannot run autopilot/backtests."
            ),
        )
    )
    try:
        gateway_ok = gateway_probe()
    except Exception as exc:
        gateway_ok = False
        gateway_detail = str(exc)
    else:
        gateway_detail = None
    checks.append(
        AgentPreflightCheck(
            name="openclaw_gateway",
            status="pass" if gateway_ok else "fail",
            summary=(
                "OpenClaw loopback gateway is reachable."
                if gateway_ok
                else "OpenClaw loopback gateway is not reachable."
            ),
            detail=gateway_detail,
        )
    )
    checks.append(_persistence_preflight_check(settings, persistence_last_error))
    missing_provider_keys = _missing_provider_keys(settings, provider_health)
    checks.append(
        AgentPreflightCheck(
            name="provider_keys",
            status="warn" if missing_provider_keys else "pass",
            summary=(
                "Budget live provider keys appear configured."
                if not missing_provider_keys
                else "One or more budget live provider keys are missing."
            ),
            detail=", ".join(missing_provider_keys) if missing_provider_keys else None,
        )
    )
    checks.append(
        AgentPreflightCheck(
            name="real_execution_hard_block",
            status="pass"
            if execution_status.real_execution_hard_block and not execution_status.can_submit_real_orders
            else "fail",
            summary=(
                "Real execution hard block is active."
                if execution_status.real_execution_hard_block and not execution_status.can_submit_real_orders
                else "Real execution is not hard-blocked; OpenClaw must not operate autonomously."
            ),
        )
    )
    statuses = {check.status for check in checks}
    return AgentPreflight(
        status="blocked" if "fail" in statuses else "degraded" if "warn" in statuses else "ready",
        checks=checks,
    )


def _persistence_preflight_check(
    settings: Settings,
    persistence_last_error: str | None,
) -> AgentPreflightCheck:
    if not settings.persistence_enabled:
        return AgentPreflightCheck(
            name="persistence",
            status="warn",
            summary="Persistence disabled; Agent Ops audit is process-local only.",
        )
    if settings.data_mode != "sample" and not settings.database_url:
        return AgentPreflightCheck(
            name="persistence",
            status="fail",
            summary="Persistence enabled but DATABASE_URL is missing for live mode.",
            detail="Live Agent Ops requires durable Postgres storage before protected autopilot actions.",
        )
    if persistence_last_error:
        return AgentPreflightCheck(
            name="persistence",
            status="fail",
            summary="Persistence enabled but store reports an error.",
            detail=persistence_last_error,
        )
    return AgentPreflightCheck(
        name="persistence",
        status="pass",
        summary="Persistence enabled and no current store error reported.",
    )


def _missing_provider_keys(
    settings: Settings,
    provider_health: list[ProviderHealth],
) -> list[str]:
    if settings.data_mode == "sample":
        return []
    missing = []
    if not settings.api_tennis_key:
        missing.append("API_TENNIS_KEY")
    if not settings.odds_api_io_key:
        missing.append("ODDS_API_IO_KEY")
    if not settings.the_odds_api_key:
        missing.append("THE_ODDS_API_KEY")
    for health in provider_health:
        if not health.configured and health.provider.value in {
            "api_tennis",
            "odds_api_io",
            "theoddsapi",
        }:
            missing.append(f"{health.provider.value}:{health.status}")
    return sorted(set(missing))


def _remember_run(run: AgentRun) -> AgentRun:
    AGENT_RUNS.insert(0, run)
    del AGENT_RUNS[50:]
    return run


def agent_runs() -> list[AgentRun]:
    return list(AGENT_RUNS)


def detect_anomalies(
    settings: Settings,
    *,
    analyses: list[MatchAnalysis],
    provider_health: list[ProviderHealth],
    provider_cursors: list[ProviderCursor],
    data_quality: list[DataQualitySnapshot],
    execution_status: ExecutionStatus,
    paper_performance: PaperPerformance,
    bankroll: BankrollSnapshot,
    cost_report: DailyCostReport,
) -> list[AgentAnomaly]:
    anomalies: list[AgentAnomaly] = []
    blocked_signals = sum(snapshot.blocked_signals for snapshot in data_quality)

    for cursor in provider_cursors:
        if cursor.resync_required or cursor.gap_count > 0:
            anomalies.append(
                AgentAnomaly(
                    id=_run_id("anom"),
                    severity="critical",
                    category="odds_sequence",
                    summary=f"{cursor.provider} {cursor.stream} requires resync",
                    detail=cursor.note,
                    blocked_signals=blocked_signals,
                    detected_at=_now(),
                )
            )

    for health in provider_health:
        if health.configured and not health.healthy:
            anomalies.append(
                AgentAnomaly(
                    id=_run_id("anom"),
                    severity="critical",
                    category="provider_health",
                    summary=f"{health.provider} configured but unhealthy",
                    detail=health.status,
                    blocked_signals=blocked_signals,
                    detected_at=_now(),
                )
            )
        quota_used = health.quota_used or 0
        quota_limit = health.quota_limit or 0
        if quota_limit and quota_used / quota_limit >= 0.8:
            anomalies.append(
                AgentAnomaly(
                    id=_run_id("anom"),
                    severity="warning",
                    category="provider_quota",
                    summary=f"{health.provider} quota above 80%",
                    detail=f"{quota_used}/{quota_limit} billable units used.",
                    blocked_signals=0,
                    detected_at=_now(),
                )
            )

    for snapshot in data_quality:
        if snapshot.stale_ticks > 0:
            detail_parts = [f"stale_ticks={snapshot.stale_ticks}"]
            if snapshot.latency_ms is not None:
                detail_parts.append(f"latency_ms={snapshot.latency_ms}")
            if snapshot.notes:
                detail_parts.append("; ".join(snapshot.notes))
            anomalies.append(
                AgentAnomaly(
                    id=_run_id("anom"),
                    severity="critical",
                    category="provider_latency",
                    summary=f"{snapshot.provider} {snapshot.feed} has stale provider ticks",
                    detail="; ".join(detail_parts),
                    blocked_signals=snapshot.blocked_signals,
                    detected_at=_now(),
                )
            )
        feed_score = (
            snapshot.score_completeness
            if "score" in snapshot.feed or "live-state" in snapshot.feed
            else 1.0
        )
        feed_odds = snapshot.odds_completeness if "odds" in snapshot.feed else 1.0
        if min(feed_score, feed_odds, snapshot.sequence_health) < 0.95:
            anomalies.append(
                AgentAnomaly(
                    id=_run_id("anom"),
                    severity="warning",
                    category="data_quality",
                    summary=f"{snapshot.provider} {snapshot.feed} quality below threshold",
                    detail="; ".join(snapshot.notes) or "Completeness or sequence health degraded.",
                    blocked_signals=snapshot.blocked_signals,
                    detected_at=_now(),
                )
            )

    if paper_performance.max_drawdown >= settings.weekly_drawdown_limit_fraction:
        anomalies.append(
            AgentAnomaly(
                id=_run_id("anom"),
                severity="critical",
                category="risk",
                summary="Paper drawdown reached weekly risk cap",
                detail=(
                    f"max_drawdown={paper_performance.max_drawdown:.4f}, "
                    f"cap={settings.weekly_drawdown_limit_fraction:.4f}"
                ),
                blocked_signals=0,
                detected_at=_now(),
            )
        )

    if bankroll.weekly_drawdown >= settings.weekly_drawdown_limit_fraction:
        anomalies.append(
            AgentAnomaly(
                id=_run_id("anom"),
                severity="critical",
                category="bankroll",
                summary="Bankroll weekly drawdown cap reached",
                detail=(
                    f"weekly_drawdown={bankroll.weekly_drawdown:.4f}, "
                    f"cap={settings.weekly_drawdown_limit_fraction:.4f}"
                ),
                blocked_signals=0,
                detected_at=_now(),
            )
        )

    if execution_status.can_submit_real_orders:
        anomalies.append(
            AgentAnomaly(
                id=_run_id("anom"),
                severity="warning",
                category="execution",
                summary="Real execution gates report ready",
                detail="This phase is paper-first; verify compliance before any hard-block change.",
                blocked_signals=0,
                detected_at=_now(),
            )
        )

    estimated_agent_spend = round((cost_report.signals_generated * 0.02) + 0.4, 2)
    if estimated_agent_spend > settings.openclaw_daily_model_budget_usd:
        anomalies.append(
            AgentAnomaly(
                id=_run_id("anom"),
                severity="warning",
                category="cost",
                summary="Estimated OpenClaw model spend exceeds daily budget",
                detail=(
                    f"estimated_agent_spend={estimated_agent_spend:.2f}, "
                    f"model_budget={settings.openclaw_daily_model_budget_usd:.2f}"
                ),
                blocked_signals=0,
                detected_at=_now(),
            )
        )

    if not analyses:
        anomalies.append(
            AgentAnomaly(
                id=_run_id("anom"),
                severity="info",
                category="coverage",
                summary="No matches available for current analysis date",
                detail="Autopilot will only brief and monitor until fixtures arrive.",
                blocked_signals=0,
                detected_at=_now(),
            )
        )

    return anomalies


def build_agent_briefing(
    settings: Settings,
    *,
    analyses: list[MatchAnalysis],
    provider_health: list[ProviderHealth],
    provider_cursors: list[ProviderCursor],
    data_quality: list[DataQualitySnapshot],
    execution_status: ExecutionStatus,
    paper_performance: PaperPerformance,
    bankroll: BankrollSnapshot,
    cost_report: DailyCostReport,
    orders: Iterable[ExecutionOrder] | None = None,
    latest_run: AgentRun | None = None,
) -> AgentBriefing:
    order_snapshot = _order_snapshot(orders)
    entries = _entry_signals(analyses)
    anomalies = detect_anomalies(
        settings,
        analyses=analyses,
        provider_health=provider_health,
        provider_cursors=provider_cursors,
        data_quality=data_quality,
        execution_status=execution_status,
        paper_performance=paper_performance,
        bankroll=bankroll,
        cost_report=cost_report,
    )
    critical_count = sum(1 for anomaly in anomalies if anomaly.severity == "critical")
    next_actions = [
        "Criar paper orders somente para sinais Entrada gerados pelo backend.",
        "Enviar briefing diario e alertas live via Dashboard/Telegram allowlist.",
        "Bloquear execucao real enquanto REAL_EXECUTION_HARD_BLOCK=true.",
    ]
    if critical_count:
        next_actions.insert(0, "Investigar anomalias criticas antes de qualquer novo paper burst.")

    return AgentBriefing(
        autopilot_enabled=settings.openclaw_autopilot_enabled,
        channel=",".join(settings.openclaw_channels),
        allowed_actions=[
            "read_status",
            "read_signals",
            "create_paper_order",
            "run_replay",
            "run_backtest",
            "write_agent_audit_log",
        ],
        triage_model=settings.openclaw_triage_model,
        critical_model=settings.openclaw_critical_model,
        router_policy=settings.openclaw_router_policy,
        daily_model_budget_usd=settings.openclaw_daily_model_budget_usd,
        live_matches=sum(1 for analysis in analyses if analysis.match.state.status == "live"),
        entry_signals=len(entries),
        paper_orders=sum(1 for order in order_snapshot if order.status == OrderStatus.PAPER),
        open_orders=_open_order_count(order_snapshot),
        provider_alerts=len(anomalies),
        readiness_status=paper_performance.readiness_status,
        summary=(
            f"OpenClaw can monitor {len(analyses)} matches and {len(entries)} entry signals. "
            f"Real execution remains blocked: {execution_status.real_execution_hard_block}."
        ),
        next_actions=next_actions,
        latest_run=latest_run,
    )


def _existing_order_for_signal(
    signal_id: str,
    orders: Iterable[ExecutionOrder] | None = None,
) -> bool:
    return any(order.signal_id == signal_id for order in _order_snapshot(orders))


def run_agent_autopilot(
    settings: Settings,
    analyses: list[MatchAnalysis],
    request: AgentAutopilotRequest,
    anomalies: list[AgentAnomaly],
    orders: Iterable[ExecutionOrder] | None = None,
) -> AgentAutopilotResult:
    order_snapshot = _order_snapshot(orders)
    actions: list[AgentAction] = []
    created_orders: list[ExecutionOrder] = []
    paper_orders_created = 0
    paper_orders_skipped = 0

    critical_anomalies = _critical_anomalies(anomalies)
    critical = bool(request.request_real_execution) or bool(critical_anomalies)

    if not settings.openclaw_autopilot_enabled:
        actions.append(
            AgentAction(
                type="autopilot",
                status=AgentActionStatus.BLOCKED,
                summary="OpenClaw autopilot disabled by configuration.",
                created_at=_now(),
            )
        )
    elif request.create_paper_orders and critical_anomalies:
        skipped = min(len(_entry_signals(analyses)), request.max_paper_orders)
        paper_orders_skipped += skipped
        actions.append(
            AgentAction(
                type="paper_autopilot",
                status=AgentActionStatus.BLOCKED,
                summary=(
                    "Paper autopilot blocked by critical operational anomalies: "
                    f"{_summarize_anomalies(critical_anomalies)}."
                ),
                created_at=_now(),
            )
        )
    elif request.create_paper_orders:
        for signal in _entry_signals(analyses)[: request.max_paper_orders]:
            if _existing_order_for_signal(signal.id, order_snapshot):
                paper_orders_skipped += 1
                actions.append(
                    AgentAction(
                        type="paper_order",
                        status=AgentActionStatus.SKIPPED,
                        target_id=signal.id,
                        summary="Paper order already exists for this signal.",
                        created_at=_now(),
                    )
                )
                continue
            try:
                order = create_order(
                    settings,
                    analyses,
                    OrderRequest(
                        signal_id=signal.id,
                        notes=request.notes or "openclaw autopilot paper order",
                    ),
                    real=False,
                    orders=order_snapshot,
                )
                order_snapshot.append(order)
                created_orders.append(order)
                paper_orders_created += 1
                actions.append(
                    AgentAction(
                        type="paper_order",
                        status=AgentActionStatus.EXECUTED,
                        target_id=order.id,
                        summary=(
                            f"Paper order created for {order.player_name} at "
                            f"{order.requested_odds:.2f}."
                        ),
                        created_at=_now(),
                    )
                )
            except Exception as exc:
                actions.append(
                    AgentAction(
                        type="paper_order",
                        status=AgentActionStatus.FAILED,
                        target_id=signal.id,
                        summary=f"Paper order failed: {exc}",
                        created_at=_now(),
                    )
                )
    else:
        actions.append(
            AgentAction(
                type="paper_order",
                status=AgentActionStatus.SKIPPED,
                summary="Autopilot evaluated only; create_paper_orders=false.",
                created_at=_now(),
            )
        )

    real_execution_blocked = False
    if request.request_real_execution:
        real_execution_blocked = True
        actions.append(
            AgentAction(
                type="real_execution",
                status=AgentActionStatus.BLOCKED,
                summary=(
                    "Real execution request blocked in OpenClaw phase. "
                    "Backend REAL_EXECUTION_HARD_BLOCK remains authoritative."
                ),
                created_at=_now(),
            )
        )

    if not actions:
        actions.append(
            AgentAction(
                type="autopilot",
                status=AgentActionStatus.SKIPPED,
                summary="No eligible Entrada signals were available for paper execution.",
                created_at=_now(),
            )
        )

    run = _remember_run(
        AgentRun(
            id=_run_id("agent"),
            run_type=AgentRunType.AUTOPILOT_EVALUATE,
            source=request.source,
            model_routes=_model_routes(settings, critical=critical),
            actions=actions,
            summary=(
                f"Autopilot evaluated {len(_entry_signals(analyses))} entry signals, "
                f"created {paper_orders_created} paper orders and skipped {paper_orders_skipped}."
            ),
            created_at=_now(),
        )
    )

    return AgentAutopilotResult(
        run=run,
        paper_orders_created=paper_orders_created,
        paper_orders_skipped=paper_orders_skipped,
        real_execution_blocked=real_execution_blocked,
        anomalies=anomalies,
        created_orders=created_orders,
    )
