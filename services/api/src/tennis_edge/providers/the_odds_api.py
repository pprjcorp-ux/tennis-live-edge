from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx

from tennis_edge.domain import OddsQuote, Provider, RawProviderPayload
from tennis_edge.services.normalizer import normalize_name, payload_checksum


@dataclass(frozen=True)
class TheOddsApiEvent:
    id: str
    sport_key: str
    home_team: str
    away_team: str
    commence_time: datetime
    quotes: list[OddsQuote] = field(default_factory=list)
    raw_payload: RawProviderPayload | None = None

    @property
    def name_key(self) -> frozenset[str]:
        return frozenset({normalize_name(self.home_team), normalize_name(self.away_team)})


class TheOddsApiClient:
    base_url = "https://api.the-odds-api.com/v4"

    def __init__(self, api_key: str | None, data_mode: str = "sample") -> None:
        self.api_key = api_key
        self.data_mode = data_mode

    async def get_tennis_h2h_events(self) -> list[TheOddsApiEvent]:
        if self.data_mode == "sample" or not self.api_key:
            return []

        async with httpx.AsyncClient(timeout=20) as client:
            sports = await self._active_tennis_sports(client)
            events: list[TheOddsApiEvent] = []
            for sport_key in sports:
                response = await client.get(
                    f"{self.base_url}/sports/{sport_key}/odds",
                    params={
                        "apiKey": self.api_key,
                        "regions": "us,uk,eu",
                        "markets": "h2h",
                        "oddsFormat": "decimal",
                        "dateFormat": "iso",
                    },
                )
                response.raise_for_status()
                payload = response.json()
                if isinstance(payload, list):
                    events.extend(self.parse_odds_payload(sport_key, payload))
            return events

    async def _active_tennis_sports(self, client: httpx.AsyncClient) -> list[str]:
        response = await client.get(f"{self.base_url}/sports", params={"apiKey": self.api_key})
        response.raise_for_status()
        rows = response.json()
        sports: list[str] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            key = str(row.get("key") or "")
            group = str(row.get("group") or "").lower()
            active = row.get("active", True)
            if key.startswith("tennis_") and "tennis" in group and active:
                sports.append(key)
        return sports

    def parse_odds_payload(
        self, sport_key: str, payload: list[dict[str, Any]]
    ) -> list[TheOddsApiEvent]:
        events: list[TheOddsApiEvent] = []
        for row in payload:
            home = str(row.get("home_team") or "")
            away = str(row.get("away_team") or "")
            event_id = str(row.get("id") or "")
            if not event_id or not home or not away:
                continue
            quotes = self._quotes_for_event(row)
            events.append(
                TheOddsApiEvent(
                    id=event_id,
                    sport_key=sport_key,
                    home_team=home,
                    away_team=away,
                    commence_time=self._timestamp(row.get("commence_time")),
                    quotes=quotes,
                    raw_payload=self._raw_payload_for_event(row, sport_key, event_id),
                )
            )
        return events

    def _raw_payload_for_event(
        self,
        row: dict[str, Any],
        sport_key: str,
        event_id: str,
    ) -> RawProviderPayload:
        source_ts = self._source_timestamp_for_event(row)
        checksum = payload_checksum(
            Provider.THE_ODDS_API,
            "odds",
            row,
            source_event_id=event_id,
            source_ts=source_ts,
        )
        return RawProviderPayload(
            id=f"raw_theoddsapi_{event_id}_{checksum[:12]}",
            provider=Provider.THE_ODDS_API,
            payload_type="odds",
            source_event_id=event_id,
            source_ts=source_ts,
            payload={"sport_key": sport_key, **row},
            checksum=checksum,
        )

    def _source_timestamp_for_event(self, row: dict[str, Any]) -> datetime:
        timestamps = [
            self._timestamp(row.get("last_update") or row.get("commence_time"))
        ]
        for bookmaker in row.get("bookmakers") or []:
            if not isinstance(bookmaker, dict):
                continue
            if bookmaker.get("last_update"):
                timestamps.append(self._timestamp(bookmaker.get("last_update")))
            for market in bookmaker.get("markets") or []:
                if isinstance(market, dict) and market.get("last_update"):
                    timestamps.append(self._timestamp(market.get("last_update")))
        return max(timestamps)

    def _quotes_for_event(self, row: dict[str, Any]) -> list[OddsQuote]:
        quotes: list[OddsQuote] = []
        source_ts = self._timestamp(row.get("last_update") or row.get("commence_time"))
        for bookmaker in row.get("bookmakers") or []:
            if not isinstance(bookmaker, dict):
                continue
            book_name = str(bookmaker.get("title") or bookmaker.get("key") or "theoddsapi")
            book_ts = self._timestamp(bookmaker.get("last_update") or source_ts)
            for market in bookmaker.get("markets") or []:
                if not isinstance(market, dict) or str(market.get("key")) != "h2h":
                    continue
                market_ts = self._timestamp(market.get("last_update") or book_ts)
                for outcome in market.get("outcomes") or []:
                    if not isinstance(outcome, dict):
                        continue
                    try:
                        decimal_odds = float(outcome.get("price"))
                    except (TypeError, ValueError):
                        continue
                    if decimal_odds <= 1:
                        continue
                    name = str(outcome.get("name") or "")
                    if not name:
                        continue
                    quotes.append(
                        OddsQuote(
                            bookmaker=book_name,
                            market="ML",
                            player_id=normalize_name(name),
                            decimal_odds=decimal_odds,
                            source_ts=market_ts,
                        )
                    )
        return quotes

    def _timestamp(self, value: Any) -> datetime:
        if isinstance(value, datetime):
            return value
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                pass
        return datetime.now(timezone.utc).replace(microsecond=0)
