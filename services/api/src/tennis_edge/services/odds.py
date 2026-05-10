from collections import defaultdict

from tennis_edge.domain import Match, OddsQuote


def implied_probability(decimal_odds: float) -> float:
    if decimal_odds <= 1:
        raise ValueError("decimal odds must be greater than 1")
    return 1 / decimal_odds


def no_vig_probabilities(outcome_odds: dict[str, float]) -> dict[str, float]:
    raw = {player_id: implied_probability(odds) for player_id, odds in outcome_odds.items()}
    total = sum(raw.values())
    if total <= 0:
        raise ValueError("at least one valid outcome is required")
    return {player_id: prob / total for player_id, prob in raw.items()}


def best_moneyline(match: Match) -> dict[str, OddsQuote]:
    best: dict[str, OddsQuote] = {}
    for quote in match.odds:
        if quote.market != "ML":
            continue
        current = best.get(quote.player_id)
        if current is None or quote.decimal_odds > current.decimal_odds:
            best[quote.player_id] = quote
    return best


def consensus_market_probability(match: Match) -> dict[str, float]:
    grouped: dict[str, dict[str, float]] = defaultdict(dict)
    player_ids = {match.player1.id, match.player2.id}

    for quote in match.odds:
        if quote.market == "ML" and quote.player_id in player_ids:
            grouped[quote.bookmaker][quote.player_id] = quote.decimal_odds

    normalized: list[dict[str, float]] = []
    for book_odds in grouped.values():
        if player_ids.issubset(book_odds):
            normalized.append(no_vig_probabilities(book_odds))

    if not normalized:
        raise ValueError("no complete two-sided moneyline market found")

    return {
        player_id: sum(row[player_id] for row in normalized) / len(normalized)
        for player_id in player_ids
    }


def odds_latency_ms(match: Match) -> int | None:
    if not match.odds:
        return None
    latest = max(quote.ingested_at for quote in match.odds)
    freshest_source = max(quote.source_ts for quote in match.odds)
    return max(0, int((latest - freshest_source).total_seconds() * 1000))
