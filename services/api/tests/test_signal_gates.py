from tennis_edge.config import Settings
from tennis_edge.domain import CursorStatus, Provider, ProviderCursor, SignalStatus
from tennis_edge.sample_data import sample_matches
from tennis_edge.services.feature_engine import build_features
from tennis_edge.services.model_service import predict_match
from tennis_edge.services.signal_engine import build_signals
from tennis_edge.services.signal_gates import SignalGateService


def _match_and_signals(match_id: str):
    match = next(match for match in sample_matches() if match.id == match_id)
    features = build_features(match)
    prediction = predict_match(match, features)
    return match, build_signals(match, prediction, features)


def _odds_cursor(status: CursorStatus) -> ProviderCursor:
    return ProviderCursor(
        provider=Provider.ODDS_API_IO,
        stream="tennis:moneyline",
        status=status,
        resync_required=status in {CursorStatus.GAP_DETECTED, CursorStatus.RESYNC_REQUIRED},
        note="test cursor",
    )


def test_live_resync_cursor_blocks_entry_signals_and_zeroes_stakes() -> None:
    match, signals = _match_and_signals("match_gs_001")
    service = SignalGateService(
        Settings(data_mode="live", odds_ws_resync_required_blocks_signals=True),
        provider_cursors=lambda: [_odds_cursor(CursorStatus.RESYNC_REQUIRED)],
    )

    gated = service.gate_signals_for_match(match, signals)

    assert any(signal.status == SignalStatus.ENTRY for signal in signals)
    assert all(signal.status != SignalStatus.ENTRY for signal in gated)
    assert all(signal.stake_fraction == 0 for signal in gated)
    assert all(
        signal.reason.startswith("Odds websocket cursor requires resync")
        for signal in gated
    )


def test_sample_mode_ignores_provider_cursor_blocking() -> None:
    _, signals = _match_and_signals("match_gs_001")
    service = SignalGateService(
        Settings(data_mode="sample"),
        provider_cursors=lambda: [_odds_cursor(CursorStatus.GAP_DETECTED)],
    )

    assert service.apply_provider_gates(signals) == signals


def test_disabled_resync_gate_leaves_live_signals_unchanged() -> None:
    _, signals = _match_and_signals("match_gs_001")
    service = SignalGateService(
        Settings(data_mode="live", odds_ws_resync_required_blocks_signals=False),
        provider_cursors=lambda: [_odds_cursor(CursorStatus.RESYNC_REQUIRED)],
    )

    assert service.apply_provider_gates(signals) == signals


def test_resync_required_boolean_blocks_even_with_inconsistent_cursor_status() -> None:
    match, signals = _match_and_signals("match_gs_001")
    inconsistent_cursor = ProviderCursor(
        provider=Provider.ODDS_API_IO,
        stream="tennis:moneyline",
        status=CursorStatus.HEALTHY,
        resync_required=True,
        note="persisted cursor still requires resync",
    )
    service = SignalGateService(
        Settings(data_mode="live", odds_ws_resync_required_blocks_signals=True),
        provider_cursors=lambda: [inconsistent_cursor],
    )

    gated = service.gate_signals_for_match(match, signals)

    assert all(signal.status != SignalStatus.ENTRY for signal in gated)
    assert all(signal.stake_fraction == 0 for signal in gated)


def test_coverage_gate_runs_before_provider_cursor_gate() -> None:
    match, signals = _match_and_signals("match_wta_002")
    service = SignalGateService(
        Settings(
            data_mode="live",
            runtime_profile="lean_atp",
            coverage="atp_main,grand_slam_men,grand_slam_women",
            odds_ws_resync_required_blocks_signals=True,
        ),
        provider_cursors=lambda: [_odds_cursor(CursorStatus.GAP_DETECTED)],
    )

    gated = service.gate_signals_for_match(match, signals)

    assert all(signal.status != SignalStatus.ENTRY for signal in gated)
    assert any("Outside lean Grand Slam/ATP coverage" in signal.reason for signal in gated)
    assert all(
        signal.reason.startswith("Odds websocket cursor requires resync")
        for signal in gated
    )
