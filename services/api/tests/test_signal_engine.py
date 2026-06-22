from tennis_edge.domain import MatchState, SignalStatus
from tennis_edge.sample_data import sample_matches
from tennis_edge.services.feature_engine import build_features
from tennis_edge.services.model_service import predict_match
from tennis_edge.services.signal_engine import capped_stake, threshold_for, build_signals


def test_thresholds_change_for_live_volatility() -> None:
    prematch = sample_matches()[0]
    live = sample_matches()[1]
    volatile = next(match for match in sample_matches() if match.state.is_volatile)

    assert threshold_for(prematch) == 0.04
    assert threshold_for(live) == 0.03
    assert threshold_for(volatile) == 0.06


def test_kelly_stake_is_capped() -> None:
    assert capped_stake(0.85, 2.2) == 0.015
    assert capped_stake(0.3, 1.5) == 0


def test_signal_engine_can_abstain_or_enter() -> None:
    match = sample_matches()[0]
    prediction = predict_match(match, build_features(match))
    signals = build_signals(match, prediction)

    assert len(signals) == 2
    assert signals[0].status in {
        SignalStatus.ENTRY,
        SignalStatus.MONITOR,
        SignalStatus.NO_VALUE,
        SignalStatus.BLOCKED,
    }

    match.state = MatchState(status="live", is_break_point=True, point_score="40-40")
    volatile_signals = build_signals(match, prediction)
    assert any(signal.threshold == 0.06 for signal in volatile_signals)


def test_signal_engine_blocks_stale_odds_even_with_large_edge() -> None:
    match = next(match for match in sample_matches() if match.id == "match_gs_001")
    features = build_features(match).model_copy(update={"odds_latency_ms": 3000})
    prediction = predict_match(match, features).model_copy(
        update={"p1_win_prob": 0.9, "p2_win_prob": 0.1}
    )

    signals = build_signals(match, prediction, features)

    assert signals
    assert all(signal.status != SignalStatus.ENTRY for signal in signals)
    assert all(signal.stake_fraction == 0 for signal in signals)
    assert any("Odds feed is stale" in signal.reason for signal in signals)


def test_signal_engine_blocks_invalid_live_score_state() -> None:
    base = next(match for match in sample_matches() if match.id == "match_atp_002")
    match = base.model_copy(
        update={
            "state": base.state.model_copy(
                update={"status": "live", "point_score": "bad-score"}
            )
        }
    )
    features = build_features(match)
    prediction = predict_match(match, features).model_copy(
        update={"p1_win_prob": 0.9, "p2_win_prob": 0.1}
    )

    signals = build_signals(match, prediction, features)

    assert signals
    assert all(signal.status != SignalStatus.ENTRY for signal in signals)
    assert all(signal.stake_fraction == 0 for signal in signals)
    assert any("Live score state is incomplete" in signal.reason for signal in signals)


def test_signal_engine_emits_no_signal_without_complete_moneyline() -> None:
    base = next(match for match in sample_matches() if match.id == "match_gs_001")
    match = base.model_copy(
        update={
            "odds": [quote for quote in base.odds if quote.player_id == base.player1.id]
        }
    )
    prediction = predict_match(match, build_features(match))

    assert build_signals(match, prediction, build_features(match)) == []
