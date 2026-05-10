from tennis_edge.domain import FeatureVector, Match, Surface
from tennis_edge.services.normalizer import competition_data_quality
from tennis_edge.services.odds import odds_latency_ms


def surface_elo(player, surface: Surface) -> float:
    if surface == Surface.CLAY:
        return player.elo_clay
    if surface in {Surface.HARD, Surface.INDOOR_HARD}:
        return player.elo_hard
    return player.elo_overall


def build_features(match: Match) -> FeatureVector:
    p1 = match.player1
    p2 = match.player2
    state = match.state
    ranking_diff = 0.0
    if p1.ranking and p2.ranking:
        ranking_diff = float(p2.ranking - p1.ranking)

    live_pressure = 0.0
    if state.status == "live":
        live_pressure += (state.p1_sets - state.p2_sets) * 0.18
        live_pressure += (state.p1_games - state.p2_games) * 0.035
        if state.server_player_id == p1.id:
            live_pressure += 0.035
        elif state.server_player_id == p2.id:
            live_pressure -= 0.035
        if state.momentum_player_id == p1.id:
            live_pressure += 0.045
        elif state.momentum_player_id == p2.id:
            live_pressure -= 0.045
        if state.is_break_point:
            live_pressure += -0.04 if state.server_player_id == p1.id else 0.04

    latency = odds_latency_ms(match) or 0
    market_volatility = min(1.0, latency / 2000)

    provider_names = {quote.bookmaker for quote in match.odds}
    provider_count = max(1, len(match.provider_ids), len(provider_names))
    latency = odds_latency_ms(match)
    data_quality = competition_data_quality(match.competition_level, provider_count)
    if latency and latency > 1500:
        data_quality = max(0.1, data_quality - 0.14)

    return FeatureVector(
        match_id=match.id,
        elo_diff=surface_elo(p1, match.surface) - surface_elo(p2, match.surface),
        ranking_diff=ranking_diff,
        form_diff=p1.recent_win_rate - p2.recent_win_rate,
        fatigue_diff=p1.fatigue_risk - p2.fatigue_risk,
        live_score_pressure=live_pressure,
        market_volatility=market_volatility,
        competition_level=match.competition_level,
        data_quality=round(data_quality, 4),
        provider_count=provider_count,
        odds_latency_ms=latency,
        surface=match.surface,
    )
