from __future__ import annotations

from tennis_edge.domain import Match, Provider


def primary_provider_for_ids(provider_ids: dict[str, str]) -> Provider:
    if "api_tennis" in provider_ids:
        return Provider.API_TENNIS
    if "theoddsapi" in provider_ids:
        return Provider.THE_ODDS_API
    return Provider.SAMPLE


def odds_provider_for_ids(provider_ids: dict[str, str], *, has_odds: bool) -> Provider | None:
    if not has_odds:
        return None
    if "theoddsapi" in provider_ids and "odds_api_io" not in provider_ids:
        return Provider.THE_ODDS_API
    return Provider.ODDS_API_IO


def provider_lineage_for_ids(
    provider_ids: dict[str, str],
    *,
    has_odds: bool,
) -> list[Provider]:
    lineage = [primary_provider_for_ids(provider_ids)]
    odds_provider = odds_provider_for_ids(provider_ids, has_odds=has_odds)
    if odds_provider is not None:
        lineage.append(odds_provider)
    return list(dict.fromkeys(lineage))


def provider_lineage_for_match(match: Match) -> list[Provider]:
    return provider_lineage_for_ids(match.provider_ids, has_odds=bool(match.odds))


def primary_provider_for_match(match: Match) -> Provider:
    return primary_provider_for_ids(match.provider_ids)


def odds_provider_for_match(match: Match) -> Provider | None:
    return odds_provider_for_ids(match.provider_ids, has_odds=bool(match.odds))
