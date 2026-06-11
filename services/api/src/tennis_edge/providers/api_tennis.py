from datetime import date, datetime, time, timezone
from typing import Any

import httpx

from tennis_edge.domain import (
    CompetitionLevel,
    Match,
    MatchState,
    Player,
    Provider,
    ProviderMatchPayload,
    RawProviderPayload,
    ScoreTick,
    Surface,
    Tour,
)
from tennis_edge.sample_data import sample_matches
from tennis_edge.services.normalizer import canonical_player_id, payload_checksum


class ApiTennisClient:
    base_url = "https://api.api-tennis.com/tennis/"

    def __init__(self, api_key: str | None, data_mode: str = "sample") -> None:
        self.api_key = api_key
        self.data_mode = data_mode

    async def get_today_matches(self, target_date: date) -> list[Match]:
        if self.data_mode == "sample":
            return sample_matches()
        records = await self.get_today_match_payloads(target_date)
        return [record.match for record in records]

    async def get_today_match_payloads(self, target_date: date) -> list[ProviderMatchPayload]:
        if self.data_mode == "sample":
            return [
                ProviderMatchPayload(
                    match=match,
                    raw_payload=self._raw_payload_for_match(
                        self._sample_event_payload(match),
                        match,
                        payload_type="fixture" if match.state.status == "prematch" else "score",
                    ),
                )
                for match in sample_matches()
            ]
        if not self.api_key:
            return []

        params = {
            "method": "get_fixtures",
            "APIkey": self.api_key,
            "date_start": target_date.isoformat(),
            "date_stop": target_date.isoformat(),
        }
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(self.base_url, params=params)
            response.raise_for_status()

        return self._parse_match_payloads(response.json(), default_status="prematch")

    async def get_livescore(self) -> list[Match]:
        if self.data_mode == "sample":
            return sample_matches()
        records = await self.get_livescore_payloads()
        return [record.match for record in records]

    async def get_livescore_payloads(self) -> list[ProviderMatchPayload]:
        if self.data_mode == "sample":
            return [
                ProviderMatchPayload(
                    match=match,
                    raw_payload=self._raw_payload_for_match(
                        self._sample_event_payload(match),
                        match,
                        payload_type="score",
                    ),
                )
                for match in sample_matches()
            ]
        if not self.api_key:
            return []

        params = {"method": "get_livescore", "APIkey": self.api_key}
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(self.base_url, params=params)
            response.raise_for_status()
        return self._parse_match_payloads(response.json(), default_status="live")

    def _parse_matches(self, payload: dict[str, Any], default_status: str) -> list[Match]:
        return [record.match for record in self._parse_match_payloads(payload, default_status)]

    def _parse_match_payloads(
        self,
        payload: dict[str, Any],
        default_status: str,
    ) -> list[ProviderMatchPayload]:
        events = payload.get("result", payload.get("data", []))
        if isinstance(events, dict):
            events = list(events.values())
        if not isinstance(events, list):
            return []

        parsed: list[ProviderMatchPayload] = []
        for event in events:
            if not isinstance(event, dict):
                continue
            match = self._parse_event(event, default_status)
            if match:
                payload_type = "fixture" if default_status == "prematch" else "score"
                parsed.append(
                    ProviderMatchPayload(
                        match=match,
                        raw_payload=self._raw_payload_for_match(
                            event,
                            match,
                            payload_type=payload_type,
                        ),
                    )
                )
        return parsed

    def _raw_payload_for_match(
        self,
        event: dict[str, Any],
        match: Match,
        *,
        payload_type: str,
    ) -> RawProviderPayload:
        source_ts = (
            match.scheduled_at
            if payload_type == "fixture"
            else datetime.now(timezone.utc).replace(microsecond=0)
        )
        source_event_id = match.provider_match_id or match.id
        checksum = payload_checksum(
            Provider.API_TENNIS,
            payload_type,
            event,
            source_event_id=source_event_id,
            source_ts=source_ts,
        )
        return RawProviderPayload(
            id=f"raw_api_tennis_{source_event_id}_{checksum[:12]}",
            provider=Provider.API_TENNIS,
            payload_type=payload_type,  # type: ignore[arg-type]
            source_event_id=source_event_id,
            source_ts=source_ts,
            payload=event,
            checksum=checksum,
        )

    def _sample_event_payload(self, match: Match) -> dict[str, Any]:
        status = match.state.status
        if status == "prematch":
            event_status = "Not Started"
        elif status == "finished":
            event_status = "Finished"
        else:
            event_status = "Set 1"
        server = ""
        if match.state.server_player_id == match.player1.id:
            server = "First Player"
        elif match.state.server_player_id == match.player2.id:
            server = "Second Player"
        return {
            "canonical_match_id": match.id,
            "event_key": match.provider_match_id or match.id,
            "event_date": match.scheduled_at.date().isoformat(),
            "event_time": match.scheduled_at.strftime("%H:%M:%S"),
            "event_first_player": match.player1.name,
            "event_second_player": match.player2.name,
            "event_first_player_key": match.player1.provider_ids.get("api_tennis", match.player1.id),
            "event_second_player_key": match.player2.provider_ids.get("api_tennis", match.player2.id),
            "event_type_type": f"{match.tour.value} Singles",
            "tournament_name": match.tournament,
            "tournament_round": match.round,
            "tournament_surface": match.surface.value.replace("_", " ").title(),
            "event_status": event_status,
            "event_final_result": f"{match.state.p1_sets} - {match.state.p2_sets}",
            "event_game_result": f"{match.state.p1_games} - {match.state.p2_games}",
            "event_point": match.state.point_score,
            "event_serve": server,
        }

    def _parse_event(self, event: dict[str, Any], default_status: str) -> Match | None:
        event_key = self._first(event, "event_key", "event_id", "id", "fixture_id")
        first_name = self._first(event, "event_first_player", "first_player", "home_team")
        second_name = self._first(event, "event_second_player", "second_player", "away_team")
        if not event_key or not first_name or not second_name:
            return None

        tournament = str(self._first(event, "tournament_name", "event_tournament_name", "league_name") or "Tennis")
        event_type = str(self._first(event, "event_type_type", "event_type", "league_name", "tour") or "")
        tour = Tour.WTA if "wta" in f"{event_type} {tournament}".lower() else Tour.ATP
        competition_level = self._competition_level(tour, tournament, event_type)
        player1 = self._player(event, "first", str(first_name), tour)
        player2 = self._player(event, "second", str(second_name), tour)
        canonical_match_id = self._first(event, "canonical_match_id")

        return Match(
            id=str(canonical_match_id or f"api_tennis_{event_key}"),
            provider_ids={"api_tennis": str(event_key)},
            provider_match_id=str(event_key),
            tournament=tournament,
            round=str(self._first(event, "tournament_round", "event_round", "round") or "TBD"),
            tour=tour,
            competition_level=competition_level,
            surface=self._surface(event),
            indoor=self._is_indoor(event),
            best_of=5 if "grand slam" in tournament.lower() and tour == Tour.ATP else 3,
            scheduled_at=self._scheduled_at(event),
            player1=player1,
            player2=player2,
            state=self._state(event, player1.id, player2.id, default_status),
            odds=[],
        )

    def _player(self, event: dict[str, Any], side: str, name: str, tour: Tour) -> Player:
        key_prefix = "event_first" if side == "first" else "event_second"
        short_prefix = "first" if side == "first" else "second"
        provider_id = self._first(
            event,
            f"{key_prefix}_player_key",
            f"{short_prefix}_player_key",
            f"{short_prefix}_player_id",
        )
        player_id = (
            f"{tour.lower()}_api_tennis_{provider_id}"
            if provider_id
            else canonical_player_id(name, tour)
        )
        country = self._first(
            event,
            f"{key_prefix}_player_country",
            f"{short_prefix}_player_country",
            f"{short_prefix}_player_country_code",
        )
        return Player(
            id=player_id,
            provider_ids={"api_tennis": str(provider_id)} if provider_id else {},
            name=name,
            tour=tour,
            country=str(country or ""),
        )

    def _state(
        self,
        event: dict[str, Any],
        p1_id: str,
        p2_id: str,
        default_status: str,
    ) -> MatchState:
        status_text = str(self._first(event, "event_status", "status", "match_status") or "").lower()
        if any(token in status_text for token in ["finished", "ended", "retired", "walkover"]):
            status = "finished"
        elif any(token in status_text for token in ["not started", "scheduled", "postponed"]):
            status = "prematch"
        else:
            status = default_status if default_status in {"prematch", "live"} else "prematch"

        p1_sets, p2_sets = self._sets(event)
        p1_games, p2_games = self._games(event)
        point_score = str(self._first(event, "event_point", "point_score", "event_game_result") or "0-0")
        point_score = point_score.replace(" - ", "-")
        server = str(self._first(event, "event_serve", "serve", "server") or "").lower()
        if "first" in server or server in {"1", "home"}:
            server_id = p1_id
        elif "second" in server or server in {"2", "away"}:
            server_id = p2_id
        else:
            server_id = None

        return MatchState(
            status=status,  # type: ignore[arg-type]
            p1_sets=p1_sets,
            p2_sets=p2_sets,
            p1_games=p1_games,
            p2_games=p2_games,
            point_score=point_score,
            server_player_id=server_id,
            is_tiebreak="tie" in status_text or "tiebreak" in point_score.lower(),
            is_break_point="break" in status_text,
        )

    def _sets(self, event: dict[str, Any]) -> tuple[int, int]:
        scores = event.get("scores")
        if isinstance(scores, list) and scores:
            p1 = 0
            p2 = 0
            for score in scores:
                if not isinstance(score, dict):
                    continue
                left = self._int(score.get("score_first"))
                right = self._int(score.get("score_second"))
                if left is None or right is None:
                    continue
                if left > right:
                    p1 += 1
                elif right > left:
                    p2 += 1
            return p1, p2
        return self._pair(event.get("event_final_result"))

    def _games(self, event: dict[str, Any]) -> tuple[int, int]:
        current_game = event.get("event_game_result") or event.get("event_current_result")
        if current_game:
            return self._pair(current_game)
        scores = event.get("scores")
        if isinstance(scores, list) and scores:
            for score in reversed(scores):
                if not isinstance(score, dict):
                    continue
                left = self._int(score.get("score_first"))
                right = self._int(score.get("score_second"))
                if left is not None and right is not None:
                    return left, right
        return 0, 0

    def _scheduled_at(self, event: dict[str, Any]) -> datetime:
        raw_date = self._first(event, "event_date", "date", "start_date")
        raw_time = self._first(event, "event_time", "time", "start_time")
        try:
            parsed_date = date.fromisoformat(str(raw_date))
            parsed_time = time.fromisoformat(str(raw_time or "00:00"))
            return datetime.combine(parsed_date, parsed_time, tzinfo=timezone.utc)
        except ValueError:
            return datetime.now(timezone.utc).replace(microsecond=0)

    def _surface(self, event: dict[str, Any]) -> Surface:
        surface = str(self._first(event, "tournament_surface", "surface") or "").lower()
        if "grass" in surface:
            return Surface.GRASS
        if "clay" in surface:
            return Surface.CLAY
        if "indoor" in surface:
            return Surface.INDOOR_HARD
        return Surface.HARD

    def _is_indoor(self, event: dict[str, Any]) -> bool:
        surface = str(self._first(event, "tournament_surface", "surface") or "").lower()
        return "indoor" in surface

    def _competition_level(
        self,
        tour: Tour,
        tournament: str,
        event_type: str,
    ) -> CompetitionLevel:
        text = f"{tournament} {event_type}".lower()
        if "itf" in text:
            return CompetitionLevel.ITF
        if "challenger" in text:
            return CompetitionLevel.CHALLENGER
        if "125" in text and tour == Tour.WTA:
            return CompetitionLevel.WTA125
        return CompetitionLevel.WTA if tour == Tour.WTA else CompetitionLevel.ATP

    def _pair(self, value: Any) -> tuple[int, int]:
        if value is None:
            return 0, 0
        text = str(value)
        parts = [part.strip() for part in text.replace(":", "-").split("-")]
        if len(parts) < 2:
            return 0, 0
        left = self._int(parts[0])
        right = self._int(parts[1])
        return left or 0, right or 0

    def _int(self, value: Any) -> int | None:
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return None

    def _first(self, event: dict[str, Any], *keys: str) -> Any:
        for key in keys:
            value = event.get(key)
            if value not in (None, ""):
                return value
        return None


def parse_api_tennis_score(payload: RawProviderPayload) -> ScoreTick | None:
    records = ApiTennisClient(api_key=None, data_mode="live")._parse_match_payloads(
        {"result": [payload.payload]},
        default_status="live",
    )
    if not records:
        return None
    match = records[0].match
    state = match.state.model_copy(
        update={
            "source_latency_ms": int(
                (payload.ingested_at - payload.source_ts).total_seconds() * 1000
            )
        }
    )
    return ScoreTick(
        match_id=match.id,
        provider=Provider.API_TENNIS,
        state=state,
        source_ts=payload.source_ts,
        ingested_at=payload.ingested_at,
    )
