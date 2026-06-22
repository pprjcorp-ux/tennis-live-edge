from tennis_edge.domain import (
    CompetitionLevel,
    Confidence,
    FeatureVector,
    MarketState,
    MarketStatus,
    Match,
    RiskDecision,
    RiskDecisionStatus,
)


VALID_TENNIS_POINTS = {"0", "15", "30", "40", "A", "AD"}
MAX_LIVE_SCORE_STALENESS_MS = 15000


def max_stake_for(match: Match, features: FeatureVector) -> float:
    if match.competition_level == CompetitionLevel.ITF:
        return 0.004
    if match.competition_level in {CompetitionLevel.CHALLENGER, CompetitionLevel.WTA125}:
        return 0.008
    if features.data_quality < 0.75:
        return 0.006
    return 0.015


def threshold_for_quality(match: Match, features: FeatureVector) -> float:
    if match.state.status == "prematch":
        base = 0.04
    elif match.state.is_volatile:
        base = 0.06
    else:
        base = 0.03

    if match.competition_level == CompetitionLevel.ITF:
        base += 0.045
    elif match.competition_level in {CompetitionLevel.CHALLENGER, CompetitionLevel.WTA125}:
        base += 0.025
    if features.data_quality < 0.65:
        base += 0.025
    return round(base, 4)


def risk_decision(
    match: Match,
    features: FeatureVector,
    player_id: str,
    edge: float,
    market_states: list[MarketState] | None = None,
) -> RiskDecision:
    reasons: list[str] = []
    threshold = threshold_for_quality(match, features)
    max_stake = max_stake_for(match, features)
    market_states = market_states or []

    if any(state.status == MarketStatus.SUSPENDED for state in market_states):
        reasons.append("Market currently suspended by provider.")
    if features.odds_latency_ms is not None and features.odds_latency_ms > 2500:
        reasons.append("Odds feed is stale for live decisioning.")
    if (
        match.state.status == "live"
        and match.state.source_latency_ms is not None
        and match.state.source_latency_ms > MAX_LIVE_SCORE_STALENESS_MS
    ):
        reasons.append("Live score feed is stale for decisioning.")
    if match.state.status == "live" and not _score_state_valid(match):
        reasons.append("Live score state is incomplete.")
    if features.provider_count < 2 and edge < threshold + 0.02:
        reasons.append("Single-source odds require a larger edge.")
    if match.state.is_volatile and edge < threshold:
        reasons.append("Volatile live point state requires a larger edge.")
    if match.competition_level == CompetitionLevel.ITF:
        reasons.append("ITF confidence downgrade active.")
    if features.data_quality < 0.65:
        reasons.append("Data quality below enterprise sizing threshold.")

    hard_blocks = ("suspended", "stale", "incomplete", "single-source")
    if reasons and (
        edge < threshold or any(token in reason.lower() for reason in reasons for token in hard_blocks)
    ):
        status = RiskDecisionStatus.BLOCK
    elif edge >= threshold:
        status = RiskDecisionStatus.ALLOW
    elif edge > 0:
        status = RiskDecisionStatus.MONITOR
    else:
        status = RiskDecisionStatus.BLOCK
        reasons.append("No positive model edge.")

    return RiskDecision(
        match_id=match.id,
        player_id=player_id,
        status=status,
        threshold=threshold,
        max_stake_fraction=max_stake,
        reasons=reasons or ["Risk checks passed."],
    )


def confidence_from_risk(base: Confidence, decision: RiskDecision) -> Confidence:
    if decision.status != RiskDecisionStatus.ALLOW:
        return Confidence.LOW
    if decision.max_stake_fraction < 0.01:
        return Confidence.MEDIUM if base == Confidence.HIGH else Confidence.LOW
    return base


def _score_state_valid(match: Match) -> bool:
    point_score = match.state.point_score.strip().upper()
    if not point_score:
        return False
    if "-" not in point_score:
        return point_score in {"DEUCE", "GAME", "SET", "MATCH"}
    left, right, *_ = [part.strip() for part in point_score.split("-")]
    return left in VALID_TENNIS_POINTS and right in VALID_TENNIS_POINTS
