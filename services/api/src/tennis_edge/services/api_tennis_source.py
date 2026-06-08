from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import date

from tennis_edge.domain import ProviderMatchPayload
from tennis_edge.providers.api_tennis import ApiTennisClient


class ApiTennisMatchSource:
    def __init__(self, client: ApiTennisClient) -> None:
        self.client = client
        self.last_warnings: list[str] = []

    async def get_today_matches(self, target_date: date) -> list[ProviderMatchPayload]:
        self.last_warnings = []
        fixtures = await self._safe_payloads(
            "fixtures",
            lambda: self.client.get_today_match_payloads(target_date),
        )
        livescore = await self._safe_payloads(
            "livescore",
            self.client.get_livescore_payloads,
        )
        return [*fixtures, *livescore]

    async def _safe_payloads(
        self,
        endpoint: str,
        fetch: Callable[[], Awaitable[list[ProviderMatchPayload]]],
    ) -> list[ProviderMatchPayload]:
        try:
            return await fetch()
        except Exception as exc:
            self.last_warnings.append(
                f"API-Tennis {endpoint} endpoint failed: {type(exc).__name__}"
            )
            return []
