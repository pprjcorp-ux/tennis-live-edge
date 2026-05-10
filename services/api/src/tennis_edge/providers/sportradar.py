from tennis_edge.domain import MatchState, PointEvent, Provider, RawProviderPayload, ScoreTick


def parse_sportradar_score(payload: RawProviderPayload) -> ScoreTick:
    body = payload.payload
    home = body.get("home_score", {})
    away = body.get("away_score", {})
    state = MatchState(
        status=body.get("status", "live"),
        p1_sets=int(home.get("sets", 0)),
        p2_sets=int(away.get("sets", 0)),
        p1_games=int(home.get("games", 0)),
        p2_games=int(away.get("games", 0)),
        point_score=f"{home.get('point', '0')}-{away.get('point', '0')}",
        server_player_id=body.get("server"),
        is_tiebreak=bool(body.get("is_tiebreak", False)),
        is_break_point=body.get("last_point_result") == "break_point",
        momentum_player_id=body.get("momentum_player_id"),
        source_latency_ms=int((payload.ingested_at - payload.source_ts).total_seconds() * 1000),
    )
    return ScoreTick(
        match_id=body["match_id"],
        provider=Provider.SPORTRADAR,
        state=state,
        source_ts=payload.source_ts,
        ingested_at=payload.ingested_at,
    )


def parse_sportradar_point(payload: RawProviderPayload) -> PointEvent:
    body = payload.payload
    return PointEvent(
        id=f"{payload.provider}:{body['match_id']}:{body['sequence']}",
        match_id=body["match_id"],
        provider=Provider.SPORTRADAR,
        sequence=int(body["sequence"]),
        set_number=int(body["set_number"]),
        game_number=int(body["game_number"]),
        server_player_id=body.get("server"),
        winner_player_id=body.get("winner"),
        point_score=body["point_score"],
        description=body.get("description", ""),
        source_ts=payload.source_ts,
        ingested_at=payload.ingested_at,
    )
