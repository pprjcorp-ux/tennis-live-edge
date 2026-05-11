from __future__ import annotations

from functools import lru_cache

from tennis_edge.domain import FeatureVector, Match


POINT_MAP = {
    "0": 0,
    "15": 1,
    "30": 2,
    "40": 3,
    "A": 4,
    "AD": 4,
}


def _clip_probability(value: float) -> float:
    return min(0.92, max(0.08, value))


@lru_cache(maxsize=None)
def _game_from_points(server_point_prob: float, server_points: int, return_points: int) -> float:
    p = _clip_probability(server_point_prob)
    if server_points >= 4 and server_points - return_points >= 2:
        return 1.0
    if return_points >= 4 and return_points - server_points >= 2:
        return 0.0
    if server_points >= 3 and return_points >= 3:
        deuce = (p * p) / ((p * p) + ((1 - p) * (1 - p)))
        if server_points == return_points:
            return deuce
        if server_points == return_points + 1:
            return p + (1 - p) * deuce
        if return_points == server_points + 1:
            return p * deuce
    return (
        p * _game_from_points(p, server_points + 1, return_points)
        + (1 - p) * _game_from_points(p, server_points, return_points + 1)
    )


def game_win_probability(server_point_prob: float, point_score: str = "0-0") -> float:
    if point_score.upper() == "DEUCE":
        return _game_from_points(_clip_probability(server_point_prob), 3, 3)
    if "-" not in point_score:
        return _game_from_points(_clip_probability(server_point_prob), 0, 0)
    left, right, *_ = [part.strip().upper() for part in point_score.split("-")]
    return _game_from_points(
        _clip_probability(server_point_prob),
        POINT_MAP.get(left, 0),
        POINT_MAP.get(right, 0),
    )


def serve_point_from_hold_rate(hold_rate: float) -> float:
    low = 0.35
    high = 0.85
    target = min(0.97, max(0.03, hold_rate))
    for _ in range(32):
        midpoint = (low + high) / 2
        if game_win_probability(midpoint) < target:
            low = midpoint
        else:
            high = midpoint
    return (low + high) / 2


def opponent_adjusted_serve_point_probability(
    server_hold_rate: float,
    opponent_break_rate: float,
    *,
    tour_hold_average: float = 0.78,
    tour_break_average: float = 0.22,
    surface_adjustment: float = 0.0,
) -> float:
    server_point = serve_point_from_hold_rate(server_hold_rate)
    opponent_pressure = (opponent_break_rate - tour_break_average) * 0.22
    tour_context = (server_hold_rate - tour_hold_average) * 0.08
    return _clip_probability(server_point - opponent_pressure + tour_context + surface_adjustment)


def _tiebreak_win_probability(
    p1_on_serve: float,
    p2_on_serve: float,
    p1_points: int = 0,
    p2_points: int = 0,
    next_server: int = 1,
    point_number: int = 0,
) -> float:
    @lru_cache(maxsize=None)
    def solve(a: int, b: int, server: int, point_index: int) -> float:
        if a >= 7 and a - b >= 2:
            return 1.0
        if b >= 7 and b - a >= 2:
            return 0.0
        if a + b > 30:
            return 1.0 if a > b else 0.0
        p1_point = p1_on_serve if server == 1 else 1 - p2_on_serve
        next_point = point_index + 1
        next_server_value = _tiebreak_server(next_point)
        return p1_point * solve(a + 1, b, next_server_value, next_point) + (
            1 - p1_point
        ) * solve(a, b + 1, next_server_value, next_point)

    return solve(p1_points, p2_points, next_server, point_number)


def _tiebreak_server(point_number: int) -> int:
    if point_number == 0:
        return 1
    block = (point_number - 1) // 2
    return 2 if block % 2 == 0 else 1


def set_win_probability(
    p1_hold: float,
    p2_hold: float,
    *,
    p1_games: int = 0,
    p2_games: int = 0,
    next_server: int = 1,
    p1_serve_point: float | None = None,
    p2_serve_point: float | None = None,
) -> float:
    p1_serve_point = p1_serve_point or serve_point_from_hold_rate(p1_hold)
    p2_serve_point = p2_serve_point or serve_point_from_hold_rate(p2_hold)

    @lru_cache(maxsize=None)
    def solve(a: int, b: int, server: int) -> float:
        if a >= 6 and a - b >= 2:
            return 1.0
        if b >= 6 and b - a >= 2:
            return 0.0
        if a == 6 and b == 6:
            return _tiebreak_win_probability(p1_serve_point, p2_serve_point, next_server=server)
        if server == 1:
            game_prob = p1_hold
            return game_prob * solve(a + 1, b, 2) + (1 - game_prob) * solve(a, b + 1, 2)
        game_prob = p2_hold
        return (1 - game_prob) * solve(a + 1, b, 1) + game_prob * solve(a, b + 1, 1)

    return solve(p1_games, p2_games, next_server)


def match_win_probability(
    p1_hold: float,
    p2_hold: float,
    *,
    best_of: int = 3,
    p1_sets: int = 0,
    p2_sets: int = 0,
    p1_games: int = 0,
    p2_games: int = 0,
    next_server: int = 1,
    p1_serve_point: float | None = None,
    p2_serve_point: float | None = None,
) -> float:
    sets_to_win = 3 if best_of == 5 else 2
    current_set = set_win_probability(
        p1_hold,
        p2_hold,
        p1_games=p1_games,
        p2_games=p2_games,
        next_server=next_server,
        p1_serve_point=p1_serve_point,
        p2_serve_point=p2_serve_point,
    )
    fresh_set = set_win_probability(
        p1_hold,
        p2_hold,
        next_server=1,
        p1_serve_point=p1_serve_point,
        p2_serve_point=p2_serve_point,
    )

    @lru_cache(maxsize=None)
    def solve(p1_won_sets: int, p2_won_sets: int, current_set_pending: bool) -> float:
        if p1_won_sets >= sets_to_win:
            return 1.0
        if p2_won_sets >= sets_to_win:
            return 0.0
        set_prob = current_set if current_set_pending else fresh_set
        return set_prob * solve(p1_won_sets + 1, p2_won_sets, False) + (
            1 - set_prob
        ) * solve(p1_won_sets, p2_won_sets + 1, False)

    return solve(p1_sets, p2_sets, True)


def live_markov_probability(match: Match, features: FeatureVector) -> float:
    surface_adjustment = {
        "clay": -0.006,
        "grass": 0.008,
        "hard": 0.0,
        "indoor_hard": 0.006,
    }.get(str(match.surface), 0.0)
    p1_serve_point = opponent_adjusted_serve_point_probability(
        match.player1.hold_rate,
        match.player2.break_rate,
        surface_adjustment=surface_adjustment,
    )
    p2_serve_point = opponent_adjusted_serve_point_probability(
        match.player2.hold_rate,
        match.player1.break_rate,
        surface_adjustment=surface_adjustment,
    )
    p1_hold = game_win_probability(p1_serve_point)
    p2_hold = game_win_probability(p2_serve_point)
    next_server = 1 if match.state.server_player_id == match.player1.id else 2
    probability = match_win_probability(
        p1_hold,
        p2_hold,
        best_of=match.best_of,
        p1_sets=match.state.p1_sets,
        p2_sets=match.state.p2_sets,
        p1_games=match.state.p1_games,
        p2_games=match.state.p2_games,
        next_server=next_server,
        p1_serve_point=p1_serve_point,
        p2_serve_point=p2_serve_point,
    )
    bayes_live_shift = max(-0.08, min(0.08, features.live_score_pressure * 0.2))
    return min(0.97, max(0.03, probability + bayes_live_shift))
