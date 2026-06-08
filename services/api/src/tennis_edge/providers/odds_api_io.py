from collections.abc import AsyncIterator
from datetime import datetime, timezone
import json
import re
from typing import Any

from tennis_edge.domain import OddsQuote, Provider, ProviderCursor, RawProviderPayload
from tennis_edge.services.normalizer import payload_checksum
from tennis_edge.services.provider_cursor import ingest_odds_api_sequence


class OddsApiIoClient:
    websocket_url = "wss://api.odds-api.io/v3/ws"

    def __init__(self, api_key: str | None, data_mode: str = "sample") -> None:
        self.api_key = api_key
        self.data_mode = data_mode

    async def stream_live_odds(self) -> AsyncIterator[list[OddsQuote]]:
        """Stream Odds-API.io tennis moneyline quotes when credentials are present."""
        async for payload in self.stream_live_messages():
            yield self.parse_message(payload)

    async def stream_live_messages(
        self,
        *,
        stream: str = "tennis:moneyline",
        last_seq: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream raw Odds-API.io messages so operational ingestion can persist lineage."""
        if self.data_mode == "sample" or not self.api_key:
            if False:
                yield {}
            return

        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("Install websockets to enable Odds-API.io live streaming.") from exc

        connect_kwargs = {
            "additional_headers": {"Authorization": f"Bearer {self.api_key}"},
            "ping_interval": 20,
        }
        try:
            websocket_context = websockets.connect(self.websocket_url, **connect_kwargs)
        except TypeError:
            connect_kwargs["extra_headers"] = connect_kwargs.pop("additional_headers")
            websocket_context = websockets.connect(self.websocket_url, **connect_kwargs)

        async with websocket_context as websocket:
            await websocket.send(json.dumps(self.subscription_message(stream, last_seq=last_seq)))
            async for message in websocket:
                yield json.loads(message)

    def subscription_message(
        self,
        stream: str = "tennis:moneyline",
        *,
        last_seq: int | None = None,
    ) -> dict[str, Any]:
        message: dict[str, Any] = {
            "type": "subscribe",
            "sport": "tennis",
            "markets": ["ML", "h2h", "moneyline"],
            "stream": stream,
        }
        if last_seq is not None:
            message["lastSeq"] = last_seq
        return message

    def parse_message(
        self,
        payload: dict[str, Any],
        current_cursor: ProviderCursor | None = None,
        stream: str = "tennis:moneyline",
    ) -> list[OddsQuote]:
        quotes, _cursor = self.ingest_message(
            payload,
            current_cursor=current_cursor,
            stream=stream,
        )
        return quotes

    def ingest_message(
        self,
        payload: dict[str, Any],
        current_cursor: ProviderCursor | None = None,
        stream: str = "tennis:moneyline",
    ) -> tuple[list[OddsQuote], ProviderCursor]:
        cursor = ingest_odds_api_sequence(
            payload,
            stream=stream,
            current_cursor=current_cursor,
        )
        return self._quotes_from_payload(payload), cursor

    def raw_payload_from_message(
        self,
        payload: dict[str, Any],
        stream: str = "tennis:moneyline",
    ) -> RawProviderPayload:
        source_ts = self._message_timestamp(payload)
        source_event_id = self._source_event_id(payload, stream)
        checksum = payload_checksum(
            Provider.ODDS_API_IO,
            "odds",
            payload,
            source_event_id,
            source_ts,
        )
        return RawProviderPayload(
            id=f"raw_odds_api_io_{self._safe_id(source_event_id)}_{checksum[:12]}",
            provider=Provider.ODDS_API_IO,
            payload_type="odds",
            source_event_id=source_event_id,
            source_ts=source_ts,
            checksum=checksum,
            payload={**payload, "stream": stream},
        )

    def _quotes_from_payload(self, payload: dict[str, Any]) -> list[OddsQuote]:
        rows = payload.get("odds") or payload.get("data") or payload.get("events") or []
        if isinstance(rows, dict):
            rows = [rows]
        quotes: list[OddsQuote] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            bookmaker = str(row.get("bookmaker") or row.get("book") or row.get("sportsbook") or "unknown")
            source_ts = self._timestamp(row.get("timestamp") or row.get("source_ts") or payload.get("timestamp"))
            selections = row.get("selections") or row.get("outcomes") or row.get("prices") or []
            if isinstance(selections, dict):
                selections = [
                    {"player_id": player_id, "odds": odds}
                    for player_id, odds in selections.items()
                ]
            for selection in selections if isinstance(selections, list) else []:
                if not isinstance(selection, dict):
                    continue
                market = str(selection.get("market") or row.get("market") or "ML")
                if market.lower() not in {"ml", "h2h", "moneyline"}:
                    continue
                player_id = selection.get("player_id") or selection.get("participant_id") or selection.get("name")
                decimal_odds = selection.get("decimal_odds") or selection.get("odds") or selection.get("price")
                try:
                    odds_value = float(decimal_odds)
                except (TypeError, ValueError):
                    continue
                if not player_id or odds_value <= 1:
                    continue
                quotes.append(
                    OddsQuote(
                        bookmaker=bookmaker,
                        market="ML",
                        player_id=str(player_id),
                        decimal_odds=odds_value,
                        source_ts=source_ts,
                    )
                )
        return quotes

    def _source_event_id(self, payload: dict[str, Any], stream: str) -> str:
        for candidate in self._candidate_event_ids(payload):
            if candidate:
                return str(candidate)
        return stream

    def _candidate_event_ids(self, payload: dict[str, Any]) -> list[Any]:
        candidates = [
            payload.get("event_id"),
            payload.get("match_id"),
            payload.get("id"),
            payload.get("fixture_id"),
        ]
        rows = payload.get("odds") or payload.get("data") or payload.get("events") or []
        if isinstance(rows, dict):
            rows = [rows]
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            candidates.extend(
                [
                    row.get("event_id"),
                    row.get("match_id"),
                    row.get("id"),
                    row.get("fixture_id"),
                ]
            )
        return candidates

    def _message_timestamp(self, payload: dict[str, Any]) -> datetime:
        candidates: list[Any] = [
            payload.get("timestamp"),
            payload.get("source_ts"),
            payload.get("emitted_at"),
            payload.get("updated_at"),
        ]
        rows = payload.get("odds") or payload.get("data") or payload.get("events") or []
        if isinstance(rows, dict):
            rows = [rows]
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            candidates.extend(
                [
                    row.get("timestamp"),
                    row.get("source_ts"),
                    row.get("last_update"),
                    row.get("updated_at"),
                ]
            )
        parsed = [value for value in (self._timestamp_or_none(candidate) for candidate in candidates) if value]
        if parsed:
            return max(parsed)
        return datetime.now(timezone.utc).replace(microsecond=0)

    def _timestamp(self, value: Any) -> datetime:
        parsed = self._timestamp_or_none(value)
        if parsed is not None:
            return parsed
        return datetime.now(timezone.utc).replace(microsecond=0)

    def _timestamp_or_none(self, value: Any) -> datetime | None:
        if isinstance(value, datetime):
            return value
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                pass
        return None

    def _safe_id(self, value: str) -> str:
        safe = re.sub(r"[^a-zA-Z0-9_.:-]+", "_", value).strip("_")
        return safe or "tennis_moneyline"


def parse_odds_api_io_moneyline(payload: RawProviderPayload) -> list[OddsQuote]:
    quotes = OddsApiIoClient(api_key=None, data_mode="live").parse_message(payload.payload)
    return [
        quote.model_copy(
            update={
                "source_ts": payload.source_ts,
                "ingested_at": payload.ingested_at,
            }
        )
        for quote in quotes
    ]
