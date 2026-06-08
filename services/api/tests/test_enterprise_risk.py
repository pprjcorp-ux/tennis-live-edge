from datetime import timedelta

from tennis_edge.domain import MarketState, MarketStatus, Provider, SignalStatus
from tennis_edge.sample_data import sample_matches
from tennis_edge.services.feature_engine import build_features
from tennis_edge.services.model_service import predict_match
from tennis_edge.services.risk_engine import risk_decision, threshold_for_quality
from tennis_edge.services.signal_engine import build_signals


def test_itf_match_gets_stricter_threshold_and_lower_stake_cap() -> None:
    match = next(item for item in sample_matches() if item.competition_level == "ITF")
    features = build_features(match)
    decision = risk_decision(match, features, match.player1.id, edge=0.12)

    assert threshold_for_quality(match, features) >= 0.075
    assert decision.max_stake_fraction == 0.004
    assert any("ITF" in reason for reason in decision.reasons)


def test_market_suspension_blocks_entry_even_with_edge() -> None:
    match = sample_matches()[0]
    features = build_features(match)
    prediction = predict_match(match, features)
    market_state = MarketState(
        match_id=match.id,
        provider=Provider.BETRADAR_UOF,
        bookmaker="BetradarLive",
        market="ML",
        status=MarketStatus.SUSPENDED,
        reason="betstop",
        source_ts=match.odds[0].source_ts,
    )

    signals = build_signals(match, prediction, features, [market_state])

    assert any(signal.status == SignalStatus.BLOCKED for signal in signals)


def test_stale_live_odds_are_blocked() -> None:
    match = sample_matches()[1]
    for quote in match.odds:
        quote.source_ts = quote.ingested_at - timedelta(seconds=12)
    features = build_features(match)
    prediction = predict_match(match, features)

    signals = build_signals(match, prediction, features)

    assert any("stale" in signal.reason for signal in signals)


def test_stale_live_score_is_blocked() -> None:
    base_match = sample_matches()[1]
    match = base_match.model_copy(
        update={
            "state": base_match.state.model_copy(update={"source_latency_ms": 16000})
        }
    )
    features = build_features(match)
    prediction = predict_match(match, features)

    signals = build_signals(match, prediction, features)

    assert any("Live score feed is stale" in signal.reason for signal in signals)
    assert all(signal.status != SignalStatus.ENTRY for signal in signals)
