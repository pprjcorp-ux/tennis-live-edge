from tennis_edge.config import Settings
from tennis_edge.domain import CursorStatus, Provider
from tennis_edge.providers.odds_api_io import OddsApiIoClient
from tennis_edge.sample_data import sample_matches
from tennis_edge.services.enterprise_analytics import model_registry
from tennis_edge.services.execution_engine import execution_status
from tennis_edge.services.provider_cursor import (
    CURSORS,
    default_provider_cursors,
    ingest_odds_api_sequence,
    mark_resynced,
)
from tennis_edge.services.tennis_markov import (
    game_win_probability,
    match_win_probability,
    serve_point_from_hold_rate,
    set_win_probability,
)


def test_odds_api_sequence_gap_blocks_until_resync() -> None:
    CURSORS.clear()
    first = ingest_odds_api_sequence({"type": "updated", "seq": 10})
    gap = ingest_odds_api_sequence({"type": "updated", "seq": 12})
    resynced = mark_resynced(Provider.ODDS_API_IO, "tennis:moneyline", 12)

    assert first.status == CursorStatus.HEALTHY
    assert first.expected_next_seq == 11
    assert gap.status == CursorStatus.GAP_DETECTED
    assert gap.resync_required is True
    assert resynced.status == CursorStatus.RESYNCED
    assert resynced.expected_next_seq == 13


def test_odds_api_resync_required_message_is_tracked() -> None:
    CURSORS.clear()
    cursor = OddsApiIoClient(api_key="key", data_mode="live").parse_message(
        {"type": "resync_required"}
    )

    assert cursor == []
    stored = CURSORS[(Provider.ODDS_API_IO, "tennis:moneyline")]
    assert stored.status == CursorStatus.RESYNC_REQUIRED
    assert stored.resync_required is True


def test_live_default_odds_cursor_requires_resync_until_real_sequence_arrives() -> None:
    CURSORS.clear()

    cursors = default_provider_cursors(Settings(data_mode="live", odds_api_io_key=None))
    odds_cursor = next(cursor for cursor in cursors if cursor.provider == Provider.ODDS_API_IO)

    assert odds_cursor.status == CursorStatus.RESYNC_REQUIRED
    assert odds_cursor.resync_required is True
    assert odds_cursor.last_seq is None


def test_markov_engine_handles_game_set_and_match_states() -> None:
    hold_point = serve_point_from_hold_rate(0.82)
    game = game_win_probability(hold_point, "40-30")
    deuce = game_win_probability(hold_point, "DEUCE")
    set_prob = set_win_probability(0.82, 0.74, p1_games=5, p2_games=4, next_server=1)
    bo5 = match_win_probability(0.82, 0.74, best_of=5, p1_sets=2, p2_sets=1)

    assert 0.5 < game < 1
    assert 0.5 < deuce < 1
    assert set_prob > 0.65
    assert bo5 > 0.75


def test_model_registry_has_baseline_and_challengers() -> None:
    registry = model_registry(Settings())
    versions = {entry.model_version for entry in registry}

    assert {"baseline_v0", "prematch_ensemble_v1", "live_markov_v1"}.issubset(versions)
    assert any(entry.role == "champion" for entry in registry)


def test_prediction_uses_enterprise_model_version_and_interval() -> None:
    from tennis_edge.services.feature_engine import build_features
    from tennis_edge.services.model_service import predict_match

    match = sample_matches()[1]
    prediction = predict_match(match, build_features(match))

    assert prediction.model_version == "live_markov_v1"
    assert prediction.raw_p1_win_prob is not None
    assert prediction.confidence_interval is not None
    assert prediction.confidence_interval[0] < prediction.p1_win_prob < prediction.confidence_interval[1]


def test_real_execution_hard_block_overrides_full_configuration() -> None:
    status = execution_status(
        Settings(
            execution_enabled=True,
            execution_stage="tiny_real",
            betfair_app_key="app",
            betfair_username="user",
            betfair_cert_path="/tmp/cert",
            betfair_key_path="/tmp/key",
            betfair_password_secret_ref="env:BETFAIR_PASSWORD",
            betfair_live_key_approved=True,
            real_execution_hard_block=True,
        )
    )

    assert status.can_submit_real_orders is False
    assert any("REAL_EXECUTION_HARD_BLOCK=true" in reason for reason in status.reasons)
