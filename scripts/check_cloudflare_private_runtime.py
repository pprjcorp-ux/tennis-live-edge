from __future__ import annotations

from pathlib import Path
import argparse
import os
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_HOSTS = {"edge.example.com", "api.edge.example.com"}


def validate_cloudflare_private_runtime(
    *,
    tunnel_config: str,
    env: dict[str, str],
    require_real_hosts: bool,
) -> list[str]:
    errors: list[str] = []
    hostnames = _extract_values(tunnel_config, "hostname")
    services = _extract_values(tunnel_config, "service")

    if {"edge.example.com", "api.edge.example.com"} - set(hostnames):
        errors.append("Tunnel config must include dashboard and API hostnames.")
    if require_real_hosts and any(host in EXAMPLE_HOSTS for host in hostnames):
        errors.append("Cloudflare tunnel still uses example hostnames.")
    if "http_status:404" not in services:
        errors.append("Tunnel config must end with an http_status:404 catch-all.")

    for service in services:
        if service.startswith("http_status:"):
            continue
        if not _is_local_http_service(service):
            errors.append(f"Tunnel service must target localhost or 127.0.0.1: {service}")

    allowed_emails = env.get("PRIVATE_ALLOWED_EMAILS", "").strip()
    if not allowed_emails:
        errors.append("PRIVATE_ALLOWED_EMAILS must be configured for Cloudflare Access.")
    elif "@" not in allowed_emails:
        errors.append("PRIVATE_ALLOWED_EMAILS must contain at least one email address.")

    if not env.get("ADMIN_API_TOKEN", "").strip():
        errors.append("ADMIN_API_TOKEN must be configured before exposing the dashboard privately.")

    cors = env.get("TENNIS_EDGE_CORS_ORIGIN", "")
    if require_real_hosts and "https://edge." not in cors:
        errors.append("TENNIS_EDGE_CORS_ORIGIN must include https://edge.<domain>.")
    if not require_real_hosts and "https://edge.example.com" not in cors:
        errors.append("TENNIS_EDGE_CORS_ORIGIN must include the dashboard hostname.")

    return errors


def _extract_values(text: str, key: str) -> list[str]:
    pattern = re.compile(rf"^\s*-\s*{key}:\s*(.+?)\s*$|^\s*{key}:\s*(.+?)\s*$")
    values = []
    for line in text.splitlines():
        match = pattern.match(line)
        if match:
            values.append((match.group(1) or match.group(2)).strip().strip('"').strip("'"))
    return values


def _is_local_http_service(service: str) -> bool:
    return service.startswith("http://localhost:") or service.startswith("http://127.0.0.1:")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate private Cloudflare Tunnel/Access local config.")
    parser.add_argument(
        "--config",
        default=str(Path.home() / ".cloudflared/tennis-live-edge.yml"),
        help="cloudflared tunnel config path",
    )
    parser.add_argument(
        "--example",
        action="store_true",
        help="validate the repository example config instead of a real hostname config",
    )
    args = parser.parse_args()

    config_path = ROOT / "infra/cloudflare/tunnel-config.example.yml" if args.example else Path(args.config)
    if not config_path.exists():
        sys.stderr.write(f"Cloudflare tunnel config not found: {config_path}\n")
        return 1

    errors = validate_cloudflare_private_runtime(
        tunnel_config=config_path.read_text(),
        env=dict(os.environ),
        require_real_hosts=not args.example,
    )
    if errors:
        sys.stderr.write("\n".join(errors) + "\n")
        return 1
    print("cloudflare private runtime checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
