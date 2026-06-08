from __future__ import annotations

from datetime import date

from tennis_edge.domain import (
    DailyMetrics,
    LiveDashboardSnapshot,
    MatchAnalysis,
    OperationalStateSnapshot,
    PaperPerformance,
    Signal,
    SignalStatus,
)
from tennis_edge.services.operational_state import OperationalStateService


class LiveDashboardReadModel:
    def __init__(self, operational_state: OperationalStateService) -> None:
        self.operational_state = operational_state

    def snapshot(
        self,
        target_date: date,
        analyses: list[MatchAnalysis],
        paper: PaperPerformance,
    ) -> LiveDashboardSnapshot:
        operational_state = self.operational_state_snapshot(target_date, analyses, paper)
        return LiveDashboardSnapshot(
            matches=analyses,
            metrics=self.daily_metrics(analyses, paper),
            signals=self.sorted_signals(analyses),
            operational_state=operational_state,
            readiness=self.operational_state.live_readiness(operational_state),
        )

    def operational_state_snapshot(
        self,
        target_date: date,
        analyses: list[MatchAnalysis],
        paper: PaperPerformance,
    ) -> OperationalStateSnapshot:
        return self.operational_state.snapshot(
            cost_report=self.operational_state.daily_cost_report(
                target_date,
                analyses,
                paper,
            )
        )

    @staticmethod
    def daily_metrics(
        analyses: list[MatchAnalysis],
        paper: PaperPerformance,
    ) -> DailyMetrics:
        all_signals = [signal for analysis in analyses for signal in analysis.signals]
        entries = [signal for signal in all_signals if signal.status == SignalStatus.ENTRY]
        positive_edges = [signal.edge for signal in all_signals if signal.edge > 0]
        confidence_values = [
            abs(analysis.prediction.p1_win_prob - 0.5) * 2 for analysis in analyses
        ]

        return DailyMetrics(
            matches=len(analyses),
            live_matches=sum(1 for analysis in analyses if analysis.match.state.status == "live"),
            entry_signals=len(entries),
            monitor_signals=sum(
                1 for signal in all_signals if signal.status == SignalStatus.MONITOR
            ),
            no_value_signals=sum(
                1 for signal in all_signals if signal.status == SignalStatus.NO_VALUE
            ),
            average_edge=round(sum(positive_edges) / len(positive_edges), 4)
            if positive_edges
            else 0,
            average_model_confidence=round(
                sum(confidence_values) / len(confidence_values), 4
            )
            if confidence_values
            else 0,
            paper_roi=paper.roi,
            clv=paper.clv,
            brier_score=paper.calibration_error,
            note=(
                "Paper metrics loaded from persisted paper performance."
                if paper.settled_orders
                else "Paper metrics ficam nulos ate existirem sinais liquidados e closing lines."
            ),
        )

    @staticmethod
    def sorted_signals(analyses: list[MatchAnalysis]) -> list[Signal]:
        signals = [signal for analysis in analyses for signal in analysis.signals]
        return sorted(signals, key=lambda signal: signal.edge, reverse=True)
