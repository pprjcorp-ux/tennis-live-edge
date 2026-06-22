from tennis_edge.domain import (
    Confidence,
    FeatureVector,
    MarketState,
    Match,
    Prediction,
    RiskDecisionStatus,
    Signal,
    SignalStatus,
)
from tennis_edge.services.odds import best_moneyline, consensus_market_probability
from tennis_edge.services.risk_engine import confidence_from_risk, risk_decision, threshold_for_quality


def threshold_for(match: Match) -> float:
    if match.state.status == "prematch":
        return 0.04
    if match.state.is_volatile:
        return 0.06
    return 0.03


def fractional_kelly(probability: float, decimal_odds: float) -> float:
    b = decimal_odds - 1
    if b <= 0:
        return 0
    raw = ((b * probability) - (1 - probability)) / b
    return max(0, raw * 0.25)


def capped_stake(probability: float, decimal_odds: float) -> float:
    return min(0.015, fractional_kelly(probability, decimal_odds))


def build_signals(
    match: Match,
    prediction: Prediction,
    features: FeatureVector | None = None,
    market_states: list[MarketState] | None = None,
) -> list[Signal]:
    best = best_moneyline(match)
    if not {match.player1.id, match.player2.id}.issubset(best):
        return []

    try:
        market_probs = consensus_market_probability(match)
    except (KeyError, ValueError, ZeroDivisionError):
        return []
    if features is None:
        threshold = threshold_for(match)
    else:
        threshold = threshold_for_quality(match, features)
    model_probs = {
        match.player1.id: prediction.p1_win_prob,
        match.player2.id: prediction.p2_win_prob,
    }
    names = {match.player1.id: match.player1.name, match.player2.id: match.player2.name}

    signals: list[Signal] = []
    for player_id, model_prob in model_probs.items():
        market_prob = market_probs[player_id]
        edge = model_prob - market_prob
        stake_cap = 0.015
        decision = None
        if features is not None:
            decision = risk_decision(match, features, player_id, edge, market_states)
            stake_cap = decision.max_stake_fraction
        stake = min(stake_cap, fractional_kelly(model_prob, best[player_id].decimal_odds))

        if decision and decision.status == RiskDecisionStatus.BLOCK:
            status = SignalStatus.BLOCKED
            reason = " ".join(decision.reasons)
            stake = 0
        elif edge >= threshold and stake > 0:
            status = SignalStatus.ENTRY
            reason = "Edge acima do threshold com stake Kelly positivo."
        elif edge > 0:
            status = SignalStatus.MONITOR
            reason = "Edge positivo, mas abaixo do threshold operacional."
        else:
            status = SignalStatus.NO_VALUE
            reason = "Preco de mercado nao oferece valor contra o modelo."

        signals.append(
            Signal(
                id=f"{match.id}:{player_id}",
                match_id=match.id,
                player_id=player_id,
                player_name=names[player_id],
                status=status,
                model_prob=round(model_prob, 4),
                market_prob=round(market_prob, 4),
                best_odds=best[player_id].decimal_odds,
                edge=round(edge, 4),
                stake_fraction=round(stake, 4),
                threshold=threshold,
                confidence=confidence_from_risk(prediction.confidence, decision)
                if decision
                else (prediction.confidence if status == SignalStatus.ENTRY else Confidence.LOW),
                reason=reason,
            )
        )
    return sorted(signals, key=lambda signal: signal.edge, reverse=True)
