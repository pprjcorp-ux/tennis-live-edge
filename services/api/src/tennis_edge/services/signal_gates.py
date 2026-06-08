from __future__ import annotations

from collections.abc import Callable

from tennis_edge.config import Settings
from tennis_edge.domain import (
    CursorStatus,
    Match,
    Provider,
    ProviderCursor,
    Signal,
    SignalStatus,
)
from tennis_edge.services.cost_profile import apply_coverage_gate, coverage_decision


class SignalGateService:
    def __init__(
        self,
        settings: Settings,
        provider_cursors: Callable[[], list[ProviderCursor]],
    ) -> None:
        self.settings = settings
        self.provider_cursors = provider_cursors

    def gate_signals_for_match(self, match: Match, signals: list[Signal]) -> list[Signal]:
        signals = apply_coverage_gate(signals, coverage_decision(match, self.settings))
        return self.apply_provider_gates(signals)

    def apply_provider_gates(self, signals: list[Signal]) -> list[Signal]:
        if (
            not signals
            or self.settings.data_mode == "sample"
            or not self.settings.odds_ws_resync_required_blocks_signals
        ):
            return signals

        odds_cursor = self._blocking_odds_cursor(self.provider_cursors())
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
                        "reason": (
                            "Odds websocket cursor requires resync; blocking entries. "
                            f"{signal.reason}"
                        ),
                    }
                )
            )
        return gated

    @staticmethod
    def _blocking_odds_cursor(cursors: list[ProviderCursor]) -> ProviderCursor | None:
        return next(
            (
                cursor
                for cursor in cursors
                if cursor.provider == Provider.ODDS_API_IO
                and cursor.status in {CursorStatus.GAP_DETECTED, CursorStatus.RESYNC_REQUIRED}
            ),
            None,
        )
