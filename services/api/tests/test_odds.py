import pytest

from tennis_edge.sample_data import sample_matches
from tennis_edge.services.odds import (
    best_moneyline,
    consensus_market_probability,
    no_vig_probabilities,
)


def test_no_vig_probabilities_sum_to_one() -> None:
    probs = no_vig_probabilities({"p1": 1.9, "p2": 1.95})
    assert round(sum(probs.values()), 6) == 1
    assert probs["p1"] > 0
    assert probs["p2"] > 0


def test_best_moneyline_chooses_highest_decimal() -> None:
    match = sample_matches()[0]
    best = best_moneyline(match)
    assert best["atp_sinner"].decimal_odds == 1.4
    assert best["atp_musetti"].decimal_odds == 3.25


def test_consensus_market_probability_requires_two_sided_market() -> None:
    match = sample_matches()[0]
    probs = consensus_market_probability(match)
    assert set(probs) == {match.player1.id, match.player2.id}
    assert round(sum(probs.values()), 6) == 1

    match.odds = match.odds[:1]
    with pytest.raises(ValueError):
        consensus_market_probability(match)
