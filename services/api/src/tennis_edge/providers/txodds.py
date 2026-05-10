from tennis_edge.domain import OddsQuote, Provider, RawProviderPayload


def parse_txodds_moneyline(payload: RawProviderPayload) -> list[OddsQuote]:
    body = payload.payload
    bookmaker = body.get("bookmaker", "TXODDS")
    market = body.get("market", "ML")
    odds = body.get("odds", {})
    return [
        OddsQuote(
            bookmaker=bookmaker,
            market=market,
            player_id=player_id,
            decimal_odds=float(decimal_odds),
            source_ts=payload.source_ts,
            ingested_at=payload.ingested_at,
        )
        for player_id, decimal_odds in odds.items()
    ]


def txodds_provider() -> Provider:
    return Provider.TXODDS
