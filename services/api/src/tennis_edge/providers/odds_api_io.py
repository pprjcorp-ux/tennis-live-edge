from collections.abc import AsyncIterator
from datetime import datetime, timezone
import json
from typing import Any

from tennis_edge.domain import OddsQuote


class OddsApiIoClient:
    websocket_url = "wss://api.odds-api.io/v3/ws"

    def __init__(self, api_key: str | None, data_mode: str = "sample") -> None:
        self.api_key = api_key
        self.data_mode = data_mode

    async def stream_live_odds(self) -> AsyncIterator[list[OddsQuote]]:
        """Stream Odds-API.io tennis moneyline quotes when credentials are present."""
        if self.data_mode == "sample" or not self.api_key:
            if False:
                yield []
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
            await websocket.send(
                json.dumps(
                    {
                        "type": "subscribe",
                        "sport": "tennis",
                        "markets": ["ML", "h2h", "moneyline"],
                    }
                )
            )
            async for message in websocket:
                yield self.parse_message(json.loads(message))

    def parse_message(self, payload: dict[str, Any]) -> list[OddsQuote]:
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
