from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def _load_checker():
    spec = spec_from_file_location(
        "check_cloudflare_private_runtime",
        ROOT / "scripts/check_cloudflare_private_runtime.py",
    )
    assert spec and spec.loader
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cloudflare_checker_accepts_private_example_config() -> None:
    checker = _load_checker()

    errors = checker.validate_cloudflare_private_runtime(
        tunnel_config=(ROOT / "infra/cloudflare/tunnel-config.example.yml").read_text(),
        env={
            "PRIVATE_ALLOWED_EMAILS": "operator@example.com",
            "TENNIS_EDGE_CORS_ORIGIN": "http://localhost:3000,https://edge.example.com",
            "ADMIN_API_TOKEN": "local-admin",
        },
        require_real_hosts=False,
    )

    assert errors == []


def test_cloudflare_checker_rejects_public_or_unprotected_runtime() -> None:
    checker = _load_checker()
    unsafe_config = """
tunnel: tennis-live-edge
credentials-file: /Users/ppfahd/.cloudflared/tennis-live-edge.json
ingress:
  - hostname: edge.example.com
    service: http://0.0.0.0:3000
  - hostname: api.edge.example.com
    service: http://localhost:8000
  - service: http_status:404
"""

    errors = checker.validate_cloudflare_private_runtime(
        tunnel_config=unsafe_config,
        env={
            "PRIVATE_ALLOWED_EMAILS": "",
            "TENNIS_EDGE_CORS_ORIGIN": "http://localhost:3000",
            "ADMIN_API_TOKEN": "",
        },
        require_real_hosts=True,
    )

    assert "Cloudflare tunnel still uses example hostnames." in errors
    assert "Tunnel service must target localhost or 127.0.0.1: http://0.0.0.0:3000" in errors
    assert "PRIVATE_ALLOWED_EMAILS must be configured for Cloudflare Access." in errors
    assert "ADMIN_API_TOKEN must be configured before exposing the dashboard privately." in errors
    assert "TENNIS_EDGE_CORS_ORIGIN must include https://edge.<domain>." in errors
