from dataclasses import dataclass, field
from uuid import uuid4

from tennis_edge.domain import (
    MarketState,
    OddsQuote,
    PointEvent,
    Provider,
    RawProviderPayload,
    ReplayRunResult,
    ScoreTick,
)
from tennis_edge.providers.api_tennis import parse_api_tennis_score
from tennis_edge.providers.betradar_uof import parse_betradar_market_state
from tennis_edge.providers.odds_api_io import parse_odds_api_io_moneyline
from tennis_edge.providers.sportradar import parse_sportradar_point, parse_sportradar_score
from tennis_edge.providers.txodds import parse_txodds_moneyline
from tennis_edge.services.normalizer import dedupe_payloads


@dataclass
class ReplayState:
    score_ticks: list[ScoreTick] = field(default_factory=list)
    point_events: list[PointEvent] = field(default_factory=list)
    odds_quotes: list[OddsQuote] = field(default_factory=list)
    market_states: list[MarketState] = field(default_factory=list)


class ReplayEngine:
    def replay(self, payloads: list[RawProviderPayload]) -> ReplayState:
        state = ReplayState()
        for payload in dedupe_payloads(payloads):
            if payload.provider == Provider.API_TENNIS and payload.payload_type == "score":
                score_tick = parse_api_tennis_score(payload)
                if score_tick is not None:
                    state.score_ticks.append(score_tick)
            elif payload.provider == Provider.ODDS_API_IO and payload.payload_type == "odds":
                state.odds_quotes.extend(
                    parse_odds_api_io_moneyline(payload, remember_in_process=False)
                )
            elif payload.provider == Provider.SPORTRADAR and payload.payload_type == "score":
                state.score_ticks.append(parse_sportradar_score(payload))
            elif payload.provider == Provider.SPORTRADAR and payload.payload_type == "point":
                state.point_events.append(parse_sportradar_point(payload))
            elif payload.provider == Provider.TXODDS and payload.payload_type == "odds":
                state.odds_quotes.extend(parse_txodds_moneyline(payload))
            elif payload.provider == Provider.BETRADAR_UOF and payload.payload_type == "market_state":
                state.market_states.append(parse_betradar_market_state(payload))
        return state

    def summarize(self, match_id: str, payloads: list[RawProviderPayload], signals: int) -> ReplayRunResult:
        state = self.replay(payloads)
        return ReplayRunResult(
            run_id=f"replay_{uuid4().hex[:12]}",
            match_id=match_id,
            events_replayed=len(dedupe_payloads(payloads)),
            score_ticks=len(state.score_ticks),
            odds_ticks=len(state.odds_quotes),
            signals_generated=signals,
            final_status="completed",
        )
