from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import httpx

from tennis_edge.config import Settings
from tennis_edge.domain import BetfairOrderMapping


class BetfairClient:
    identity_url = "https://identitysso-cert.betfair.com/api/certlogin"
    betting_url = "https://api.betfair.com/exchange/betting/json-rpc/v1"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def place_limit_order(self, mapping: BetfairOrderMapping) -> dict[str, Any]:
        password = self._password()
        if not password:
            raise ValueError("Betfair password secret could not be resolved.")
        if not self.settings.betfair_cert_path or not self.settings.betfair_key_path:
            raise ValueError("Betfair certificate paths are missing.")

        with httpx.Client(
            cert=(self.settings.betfair_cert_path, self.settings.betfair_key_path),
            timeout=5,
        ) as client:
            token = self._login(client, password)
            payload = self.place_orders_payload(mapping)
            response = client.post(
                self.betting_url,
                headers={
                    "X-Application": self.settings.betfair_app_key or "",
                    "X-Authentication": token,
                    "content-type": "application/json",
                    "accept": "application/json",
                },
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
            if "error" in data:
                raise ValueError(f"Betfair placeOrders failed: {data['error']}")
            return data.get("result", {})

    def _login(self, client: httpx.Client, password: str) -> str:
        response = client.post(
            self.identity_url,
            headers={
                "X-Application": self.settings.betfair_app_key or "",
                "accept": "application/json",
            },
            data={
                "username": self.settings.betfair_username or "",
                "password": password,
            },
        )
        response.raise_for_status()
        data = response.json()
        if data.get("loginStatus") != "SUCCESS" or not data.get("sessionToken"):
            raise ValueError(f"Betfair login failed: {data.get('loginStatus', 'unknown')}")
        return str(data["sessionToken"])

    def _password(self) -> str | None:
        secret_ref = self.settings.betfair_password_secret_ref
        if not secret_ref:
            return None
        if secret_ref.startswith("env:"):
            return os.environ.get(secret_ref.removeprefix("env:"))
        if secret_ref.startswith("file:"):
            path = Path(secret_ref.removeprefix("file:")).expanduser()
            if path.exists():
                return path.read_text().strip()
            return None
        return os.environ.get(secret_ref)

    @staticmethod
    def place_orders_payload(mapping: BetfairOrderMapping) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "method": "SportsAPING/v1.0/placeOrders",
            "params": {
                "marketId": mapping.market_id,
                "instructions": [
                    {
                        "selectionId": mapping.selection_id,
                        "handicap": 0,
                        "side": mapping.side,
                        "orderType": "LIMIT",
                        "limitOrder": {
                            "size": mapping.stake_amount,
                            "price": mapping.limit_price,
                            "persistenceType": "LAPSE",
                        },
                    }
                ],
                "customerRef": mapping.customer_order_ref,
                "customerStrategyRef": mapping.customer_strategy_ref,
                "async": False,
            },
            "id": mapping.customer_order_ref,
        }
