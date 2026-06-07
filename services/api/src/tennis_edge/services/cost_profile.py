from dataclasses import dataclass
from datetime import datetime, timezone

from tennis_edge.config import Settings
from tennis_edge.domain import (
    CompetitionLevel,
    CostProfile,
    Confidence,
    DailyCostReport,
    Match,
    MatchAnalysis,
    PaperPerformance,
    Provider,
    ProviderCostUsage,
    ProviderHealth,
    Signal,
    SignalStatus,
    Tour,
)


GRAND_SLAMS = {
    "australian open",
    "roland garros",
    "french open",
    "wimbledon",
    "us open",
}

LEAN_PROVIDER_MONTHLY_USD = {
    Provider.API_TENNIS: 80.0,
    Provider.ODDS_API_IO: 251.0,
    Provider.THE_ODDS_API: 99.0,
}

ENTERPRISE_PROVIDER_MONTHLY_USD = {
    Provider.SPORTRADAR: 2500.0,
    Provider.BETRADAR_UOF: 1200.0,
    Provider.TXODDS: 1000.0,
    Provider.API_TENNIS: 80.0,
    Provider.ODDS_API_IO: 251.0,
    Provider.THE_ODDS_API: 99.0,
}


@dataclass(frozen=True)
class CoverageDecision:
    eligible: bool
    reason: str


def estimated_monthly_spend(settings: Settings) -> float:
    if settings.runtime_profile == "lean_atp":
        return round(sum(LEAN_PROVIDER_MONTHLY_USD.values()), 2)
    if settings.runtime_profile == "enterprise_roi_clv":
        return round(sum(ENTERPRISE_PROVIDER_MONTHLY_USD.values()), 2)
    return 0


def cost_profile(settings: Settings) -> CostProfile:
    enterprise_providers = [
        Provider.SPORTRADAR,
        Provider.BETRADAR_UOF,
        Provider.TXODDS,
    ]
    lean_providers = [
        Provider.API_TENNIS,
        Provider.ODDS_API_IO,
        Provider.THE_ODDS_API,
    ]
    enabled = lean_providers + (enterprise_providers if settings.enterprise_feeds_enabled else [])
    notes = (
        [
            "Lean ATP profile uses API-Tennis, Odds-API.io and TheOddsAPI while enterprise feeds stay disabled.",
            "Coverage gates restrict actionable signals to ATP main tour and men's/women's Grand Slam singles.",
        ]
        if settings.runtime_profile == "lean_atp"
        else [
            "Enterprise profile budgets for Sportradar, Betradar UOF and TXODDS, but adapters stay feature-flagged until credentials/contracts are validated.",
            "Paper-first mode records CLV/ROI before any real-money activation review.",
        ]
    )
    return CostProfile(
        active_plan=settings.runtime_profile,
        monthly_budget_usd=settings.monthly_budget_usd,
        estimated_monthly_spend_usd=estimated_monthly_spend(settings),
        enabled_providers=enabled,
        disabled_providers=enterprise_providers if not settings.enterprise_feeds_enabled else [],
        coverage_scope=sorted(settings.coverage_set),
        score_primary=settings.score_primary,
        odds_primary=settings.odds_primary,
        odds_archive=settings.odds_archive,
        enterprise_feeds_enabled=settings.enterprise_feeds_enabled,
        notes=notes,
    )


def is_grand_slam_tournament(match: Match) -> bool:
    tournament = match.tournament.lower()
    return any(name in tournament for name in GRAND_SLAMS)


def is_grand_slam_men(match: Match) -> bool:
    return match.tour == Tour.ATP and is_grand_slam_tournament(match)


def is_grand_slam_women(match: Match) -> bool:
    return match.tour == Tour.WTA and is_grand_slam_tournament(match)


def is_atp_main(match: Match) -> bool:
    return match.tour == Tour.ATP and match.competition_level == CompetitionLevel.ATP


def coverage_decision(match: Match, settings: Settings) -> CoverageDecision:
    if settings.runtime_profile != "lean_atp":
        return CoverageDecision(True, "Runtime profile allows all configured coverage.")

    allowed = settings.coverage_set
    if "atp_main" in allowed and is_atp_main(match):
        return CoverageDecision(True, "ATP main-tour coverage.")
    if "grand_slam_men" in allowed and is_grand_slam_men(match):
        return CoverageDecision(True, "Men's Grand Slam singles coverage.")
    if "grand_slam_women" in allowed and is_grand_slam_women(match):
        return CoverageDecision(True, "Women's Grand Slam singles coverage.")
    return CoverageDecision(False, "Outside lean Grand Slam/ATP coverage; monitor-only.")


def apply_coverage_gate(signals: list[Signal], decision: CoverageDecision) -> list[Signal]:
    if decision.eligible:
        return signals

    gated: list[Signal] = []
    for signal in signals:
        next_status = SignalStatus.MONITOR if signal.edge > 0 else SignalStatus.NO_VALUE
        gated.append(
            signal.model_copy(
                update={
                    "status": next_status,
                    "stake_fraction": 0,
                    "confidence": Confidence.LOW,
                    "reason": f"{decision.reason} {signal.reason}",
                }
            )
        )
    return gated


def should_escalate_polling(analysis: MatchAnalysis) -> bool:
    if analysis.match.state.status != "live":
        return False
    if not analysis.signals:
        return False
    if analysis.features.odds_latency_ms is None or analysis.features.odds_latency_ms > 2500:
        return False
    if not analysis.match.state.point_score:
        return False
    return any(
        signal.edge > 0 and abs(signal.threshold - signal.edge) <= 0.02
        for signal in analysis.signals
    )


def provider_health_for(settings: Settings) -> list[ProviderHealth]:
    now = datetime.now(timezone.utc).replace(microsecond=0)
    sample = settings.data_mode == "sample"
    enterprise_status = (
        "enterprise adapter contract-gated"
        if settings.runtime_profile == "enterprise_roi_clv"
        else "disabled by lean_atp profile"
    )
    return [
        ProviderHealth(
            provider=Provider.API_TENNIS,
            configured=bool(settings.api_tennis_key),
            healthy=bool(settings.api_tennis_key) or sample,
            latency_ms=900 if sample else None,
            last_message_at=now if sample else None,
            status="score primary sample feed" if sample else "score primary configured",
            cost_tier="$80/mo",
            coverage_scope="ATP main + men's/women's Grand Slam score/livescore",
            quota_used=0 if sample else None,
            quota_limit=200000,
            last_billable_call_at=None,
        ),
        ProviderHealth(
            provider=Provider.ODDS_API_IO,
            configured=bool(settings.odds_api_io_key),
            healthy=bool(settings.odds_api_io_key) or sample,
            latency_ms=740 if sample else None,
            last_message_at=now if sample else None,
            status="odds websocket sample feed" if sample else "odds websocket primary",
            cost_tier="£198/mo Starter+WS",
            coverage_scope="Live/watchlist ML odds",
            quota_used=0 if sample else None,
            quota_limit=5000,
            last_billable_call_at=None,
        ),
        ProviderHealth(
            provider=Provider.THE_ODDS_API,
            configured=bool(settings.the_odds_api_key),
            healthy=bool(settings.the_odds_api_key) or sample,
            latency_ms=1100 if sample else None,
            last_message_at=now if sample else None,
            status="historical archive sample" if sample else "historical archive configured",
            cost_tier="$99/mo Business",
            coverage_scope="Historical odds, archive and comparison",
            quota_used=0 if sample else None,
            quota_limit=200000,
            last_billable_call_at=None,
        ),
        ProviderHealth(
            provider=Provider.SPORTRADAR,
            configured=bool(settings.sportradar_api_key),
            healthy=bool(settings.sportradar_api_key) or sample,
            latency_ms=520 if sample else None,
            last_message_at=now if sample else None,
            status="score/live-state sample adapter" if sample else enterprise_status,
            cost_tier="enterprise quote estimate $2.5k/mo",
            coverage_scope="ATP/WTA/Challenger/ITF score, timeline, delay/retirement",
            quota_used=0,
            quota_limit=None,
        ),
        ProviderHealth(
            provider=Provider.BETRADAR_UOF,
            configured=bool(settings.betradar_uof_token),
            healthy=bool(settings.betradar_uof_token) or sample,
            latency_ms=600 if sample else None,
            last_message_at=now if sample else None,
            status="market-state sample adapter" if sample else enterprise_status,
            cost_tier="enterprise quote estimate $1.2k/mo",
            coverage_scope="Market state, betstop, suspension and settlement status",
            quota_used=0,
            quota_limit=None,
        ),
        ProviderHealth(
            provider=Provider.TXODDS,
            configured=bool(settings.txodds_user and settings.txodds_password),
            healthy=bool(settings.txodds_user and settings.txodds_password) or sample,
            latency_ms=480 if sample else None,
            last_message_at=now if sample else None,
            status="in-running odds sample adapter" if sample else enterprise_status,
            cost_tier="enterprise quote estimate $1k/mo",
            coverage_scope="Low-latency independent in-running tennis odds",
            quota_used=0,
            quota_limit=None,
        ),
    ]


def daily_cost_report(
    settings: Settings,
    analyses: list[MatchAnalysis],
    paper_performance: PaperPerformance | None = None,
) -> DailyCostReport:
    skipped = sum(1 for analysis in analyses if not coverage_decision(analysis.match, settings).eligible)
    signals = [signal for analysis in analyses for signal in analysis.signals]
    entry_signals = [signal for signal in signals if signal.status == SignalStatus.ENTRY]
    monthly = estimated_monthly_spend(settings)
    daily = round(monthly / 30, 2) if monthly else 0
    live_matches = sum(1 for analysis in analyses if analysis.match.state.status == "live")
    watchlist = sum(1 for analysis in analyses if should_escalate_polling(analysis))
    positive_clv_signals = paper_performance.positive_clv_signals if paper_performance else 0

    price_map = (
        ENTERPRISE_PROVIDER_MONTHLY_USD
        if settings.runtime_profile == "enterprise_roi_clv"
        else LEAN_PROVIDER_MONTHLY_USD
    )
    usages = [
        ProviderCostUsage(
            provider=Provider.API_TENNIS,
            api_calls=max(1, len(analyses)),
            quota_used=max(1, len(analyses)),
            quota_limit=200000,
            estimated_daily_cost_usd=round(price_map[Provider.API_TENNIS] / 30, 2),
        ),
        ProviderCostUsage(
            provider=Provider.ODDS_API_IO,
            api_calls=max(1, live_matches + watchlist),
            websocket_minutes=live_matches * 120,
            quota_used=max(1, live_matches + watchlist),
            quota_limit=5000,
            estimated_daily_cost_usd=round(price_map[Provider.ODDS_API_IO] / 30, 2),
        ),
        ProviderCostUsage(
            provider=Provider.THE_ODDS_API,
            api_calls=1,
            quota_used=1,
            quota_limit=200000,
            estimated_daily_cost_usd=round(price_map[Provider.THE_ODDS_API] / 30, 2),
        ),
    ]
    if settings.runtime_profile == "enterprise_roi_clv":
        usages.extend(
            [
                ProviderCostUsage(
                    provider=Provider.SPORTRADAR,
                    api_calls=max(1, len(analyses)),
                    quota_used=max(1, len(analyses)),
                    quota_limit=None,
                    estimated_daily_cost_usd=round(price_map[Provider.SPORTRADAR] / 30, 2),
                ),
                ProviderCostUsage(
                    provider=Provider.BETRADAR_UOF,
                    api_calls=max(1, live_matches),
                    quota_used=max(1, live_matches),
                    quota_limit=None,
                    estimated_daily_cost_usd=round(price_map[Provider.BETRADAR_UOF] / 30, 2),
                ),
                ProviderCostUsage(
                    provider=Provider.TXODDS,
                    api_calls=max(1, live_matches + watchlist),
                    websocket_minutes=live_matches * 120,
                    quota_used=max(1, live_matches + watchlist),
                    quota_limit=None,
                    estimated_daily_cost_usd=round(price_map[Provider.TXODDS] / 30, 2),
                ),
            ]
        )

    return DailyCostReport(
        active_plan=settings.runtime_profile,
        estimated_monthly_spend_usd=monthly,
        estimated_daily_spend_usd=daily,
        api_calls_by_provider=usages,
        websocket_uptime_pct=0.992 if settings.odds_primary.endswith("_ws") else 0,
        matches_analyzed=len(analyses),
        matches_skipped_by_coverage=skipped,
        signals_generated=len(entry_signals),
        cost_per_signal_usd=round(daily / len(entry_signals), 2) if entry_signals else None,
        cost_per_positive_clv_signal_usd=round(daily / positive_clv_signals, 2)
        if positive_clv_signals
        else None,
        watchlist_escalations=watchlist,
        note=(
            f"Cost per positive-CLV signal uses {positive_clv_signals} settled paper signals."
            if positive_clv_signals
            else "Positive-CLV cost stays null until closing-line results are imported."
        ),
    )
