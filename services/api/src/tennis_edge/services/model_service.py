from math import exp, log

from tennis_edge.domain import Confidence, FeatureVector, Match, Prediction
from tennis_edge.services.odds import consensus_market_probability
from tennis_edge.services.tennis_markov import live_markov_probability


def _sigmoid(value: float) -> float:
    return 1 / (1 + exp(-value))


def _logit(probability: float) -> float:
    clipped = min(0.98, max(0.02, probability))
    return log(clipped / (1 - clipped))


def _elo_probability(diff: float) -> float:
    return 1 / (1 + 10 ** (-diff / 400))


def predict_match(match: Match, features: FeatureVector) -> Prediction:
    base_prob = _elo_probability(features.elo_diff)
    score = _logit(base_prob)
    score += features.ranking_diff * 0.003
    score += features.form_diff * 0.75
    score -= features.fatigue_diff * 0.35
    score += features.live_score_pressure
    score *= 0.86 + (features.data_quality * 0.14)

    heuristic_p1 = min(0.97, max(0.03, _sigmoid(score)))
    markov_p1 = live_markov_probability(match, features)
    market_p1 = None
    try:
        market_p1 = consensus_market_probability(match)[match.player1.id]
    except (KeyError, ZeroDivisionError):
        market_p1 = None

    if market_p1 is None:
        raw_p1 = 0.58 * heuristic_p1 + 0.42 * markov_p1
    elif match.state.status == "prematch":
        raw_p1 = 0.42 * heuristic_p1 + 0.28 * markov_p1 + 0.30 * market_p1
    else:
        raw_p1 = 0.35 * heuristic_p1 + 0.40 * markov_p1 + 0.25 * market_p1

    calibration_strength = min(0.22, features.market_volatility * 0.08 + (1 - features.data_quality) * 0.16)
    p1 = min(0.97, max(0.03, raw_p1 * (1 - calibration_strength) + 0.5 * calibration_strength))
    p2 = 1 - p1

    certainty = abs(p1 - 0.5)
    data_penalty = features.market_volatility * 0.08 + (1 - features.data_quality) * 0.18
    confidence_score = max(0, certainty - data_penalty)
    if confidence_score >= 0.22:
        confidence = Confidence.HIGH
    elif confidence_score >= 0.1:
        confidence = Confidence.MEDIUM
    else:
        confidence = Confidence.LOW

    explanations = [
        f"Model version: {'live_markov_v1' if match.state.status == 'live' else 'prematch_ensemble_v1'}",
        f"Surface Elo diff: {features.elo_diff:+.0f}",
        f"Form diff: {features.form_diff:+.2f}",
        f"Markov probability: {markov_p1:.2%}",
        f"Data quality: {features.data_quality:.2f}",
    ]
    if market_p1 is not None:
        explanations.append(f"No-vig market prior: {market_p1:.2%}")
    if match.state.status == "live":
        explanations.append(f"Live score pressure: {features.live_score_pressure:+.2f}")
    if features.market_volatility > 0.5:
        explanations.append("Odds feed latency/volatility elevated")

    margin = max(0.03, min(0.18, 0.22 - features.data_quality * 0.14 + features.market_volatility * 0.08))
    return Prediction(
        match_id=match.id,
        p1_win_prob=round(p1, 4),
        p2_win_prob=round(p2, 4),
        raw_p1_win_prob=round(raw_p1, 4),
        raw_p2_win_prob=round(1 - raw_p1, 4),
        confidence=confidence,
        mode="live" if match.state.status == "live" else "prematch",
        model_version="live_markov_v1" if match.state.status == "live" else "prematch_ensemble_v1",
        confidence_interval=(round(max(0.01, p1 - margin), 4), round(min(0.99, p1 + margin), 4)),
        explanations=explanations,
    )
