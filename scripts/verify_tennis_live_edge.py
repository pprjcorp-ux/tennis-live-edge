#!/usr/bin/env python3
"""
verify_tennis_live_edge.py
--------------------------

Realiza um smoke test contra uma instância do backend tennis-live-edge.

Uso:
    python3 scripts/verify_tennis_live_edge.py
        --base-url http://localhost:8000 --runtime-profile lean_atp
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


EXPECTED_SCORE_PROVIDERS = {"api_tennis", "sportradar"}


def fetch_json(
    url: str, headers: dict[str, str] | None = None
) -> dict[str, Any] | list[Any] | None:
    request = Request(url, headers=headers or {})
    try:
        with urlopen(request, timeout=10) as response:
            payload = response.read().decode("utf-8")
    except HTTPError as exc:
        print(f"Erro ao buscar {url}: HTTP {exc.code} {exc.reason}")
        return None
    except URLError as exc:
        print(f"Erro ao buscar {url}: {exc.reason}")
        return None
    except TimeoutError as exc:
        print(f"Erro ao buscar {url}: timeout ({exc})")
        return None

    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        print(f"Erro ao decodificar JSON de {url}: {exc}")
        return None


def test_cost_report(base_url: str) -> bool:
    print("\nChecando o relatório diário de custos...")
    url = f"{base_url.rstrip('/')}/api/v1/cost-report/daily"
    data = fetch_json(url)
    if not isinstance(data, dict):
        return False

    usages = data.get("api_calls_by_provider", [])
    providers = {usage.get("provider") for usage in usages if isinstance(usage, dict)}
    print(f"Provedores retornados pela API: {sorted(providers)}")

    if not providers.intersection(EXPECTED_SCORE_PROVIDERS):
        print(
            "Nenhum provedor esperado encontrado. "
            f"Esperado pelo menos um de: {sorted(EXPECTED_SCORE_PROVIDERS)}"
        )
        return False

    monthly_spend = data.get("estimated_monthly_spend_usd")
    print(f"Gasto mensal estimado: US$ {monthly_spend}")
    return True


def _match_items(payload: dict[str, Any] | list[Any]) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        matches = payload.get("matches", [])
        if isinstance(matches, list):
            return [item for item in matches if isinstance(item, dict)]
    return []


def _match_tour(item: dict[str, Any]) -> str | None:
    if isinstance(item.get("tour"), str):
        return item["tour"]
    match = item.get("match")
    if isinstance(match, dict) and isinstance(match.get("tour"), str):
        return match["tour"]
    return None


def test_lean_atp_coverage(base_url: str, runtime_profile: str) -> bool:
    print(f"\nChecando cobertura de partidas para o profile '{runtime_profile}'...")
    url = f"{base_url.rstrip('/')}/api/v1/live/matches"
    headers = {"X-Runtime-Profile": runtime_profile}
    data = fetch_json(url, headers=headers)
    if data is None:
        return False

    matches = _match_items(data)
    atp_matches = [match for match in matches if _match_tour(match) == "ATP"]
    print(f"Total de partidas: {len(matches)}; partidas ATP: {len(atp_matches)}")

    if runtime_profile == "lean_atp" and not atp_matches:
        print("Nenhuma partida ATP encontrada; a cobertura padrão pode estar incorreta.")
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke tests for tennis-live-edge.")
    parser.add_argument(
        "--base-url",
        default="http://localhost:8000",
        help="URL base da instância tennis-live-edge",
    )
    parser.add_argument(
        "--runtime-profile",
        default="lean_atp",
        help="Runtime profile para testar",
    )
    args = parser.parse_args()

    ok = True
    ok &= test_cost_report(args.base_url)
    ok &= test_lean_atp_coverage(args.base_url, args.runtime_profile)
    print("\nSmoke test finalizado.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
