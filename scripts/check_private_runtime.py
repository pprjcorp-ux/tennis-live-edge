from __future__ import annotations

from pathlib import Path
import os
import sys


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    config = ROOT / "infra/cloudflare/tunnel-config.example.yml"
    schema = ROOT / "infra/schema.sql"
    env = ROOT / ".env.example"

    errors: list[str] = []
    if "api.edge.example.com" not in config.read_text():
        errors.append("Cloudflare API hostname example missing")
    if "edge.example.com" not in config.read_text():
        errors.append("Cloudflare dashboard hostname example missing")
    schema_text = schema.read_text()
    for table in [
        "raw_provider_payloads",
        "point_events",
        "market_suspensions",
        "provider_latency",
        "model_versions",
        "paper_orders",
        "execution_orders",
        "bankroll_snapshots",
        "learning_runs",
        "model_promotion_decisions",
        "execution_audit_events",
    ]:
        if table not in schema_text:
            errors.append(f"Schema missing {table}")
    env_text = env.read_text()
    for key in [
        "SPORTRADAR_API_KEY",
        "BETRADAR_UOF_TOKEN",
        "TXODDS_USER",
        "TXODDS_PASSWORD",
        "THE_ODDS_API_KEY",
        "CLOUDFLARE_TUNNEL_TOKEN",
        "PRIVATE_ALLOWED_EMAILS",
        "ADMIN_API_TOKEN",
        "EXECUTION_VENUE=betfair",
        "EXECUTION_STAGE=paper",
        "BANKROLL_BASE_CURRENCY",
        "BETFAIR_APP_KEY",
        "BETFAIR_USERNAME",
        "BETFAIR_CERT_PATH",
        "BETFAIR_KEY_PATH",
        "BETFAIR_PASSWORD_SECRET_REF",
        "BETFAIR_LIVE_KEY_APPROVED=false",
        "TENNIS_EDGE_CORS_ORIGIN",
        "TENNIS_EDGE_RUNTIME_PROFILE=lean_atp",
        "TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men",
        "ENTERPRISE_FEEDS_ENABLED=false",
        "EXECUTION_ENABLED=false",
    ]:
        if key not in env_text:
            errors.append(f".env.example missing {key}")
    if os.environ.get("EXECUTION_ENABLED", "false").lower() != "false":
        errors.append("EXECUTION_ENABLED must remain false for enterprise v1")

    if errors:
        sys.stderr.write("\n".join(errors) + "\n")
        return 1
    print("private runtime checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
