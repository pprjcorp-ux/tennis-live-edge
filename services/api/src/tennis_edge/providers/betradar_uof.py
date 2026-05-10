from tennis_edge.domain import MarketState, MarketStatus, Provider, RawProviderPayload


def parse_betradar_market_state(payload: RawProviderPayload) -> MarketState:
    body = payload.payload
    status = MarketStatus(body.get("status", "open"))
    return MarketState(
        match_id=body["match_id"],
        provider=Provider.BETRADAR_UOF,
        bookmaker=body.get("bookmaker", "Betradar"),
        market=body.get("market", "ML"),
        status=status,
        reason=body.get("reason"),
        source_ts=payload.source_ts,
        ingested_at=payload.ingested_at,
    )
