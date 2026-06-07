from __future__ import annotations

from pathlib import Path
import os
import sys

from check_cloudflare_private_runtime import validate_cloudflare_private_runtime


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    config = ROOT / "infra/cloudflare/tunnel-config.example.yml"
    schema = ROOT / "infra/schema.sql"
    env = ROOT / ".env.example"
    openclaw_skill = ROOT / "openclaw/skills/tennis-edge-ops/SKILL.md"
    openclaw_script = ROOT / "openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs"
    openclaw_policy = ROOT / "openclaw/openclaw.autopilot.example.json"

    errors: list[str] = []
    if "api.edge.example.com" not in config.read_text():
        errors.append("Cloudflare API hostname example missing")
    if "edge.example.com" not in config.read_text():
        errors.append("Cloudflare dashboard hostname example missing")
    cloudflare_errors = validate_cloudflare_private_runtime(
        tunnel_config=config.read_text(),
        env={
            "PRIVATE_ALLOWED_EMAILS": "operator@example.com",
            "ADMIN_API_TOKEN": "local-admin",
            "TENNIS_EDGE_CORS_ORIGIN": "http://localhost:3000,https://edge.example.com",
        },
        require_real_hosts=False,
    )
    errors.extend(f"Cloudflare example invalid: {error}" for error in cloudflare_errors)
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
        "provider_cursors",
        "data_quality_snapshots",
        "canonical_entity_conflicts",
        "paper_fills",
        "paper_settlements",
        "closing_line_snapshots",
        "training_examples",
        "calibration_reports",
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
        "REAL_EXECUTION_HARD_BLOCK=true",
        "MODEL_CHAMPION_VERSION=baseline_v0",
        "MIN_PAPER_SIGNALS_FOR_REAL_REVIEW=500",
        "MIN_PAPER_DAYS_FOR_REAL_REVIEW=60",
        "ODDS_WS_RESYNC_REQUIRED_BLOCKS_SIGNALS=true",
        "MODEL_PROMOTION_REQUIRE_CLV=true",
        "OPENCLAW_AUTOPILOT_ENABLED=true",
        "OPENCLAW_TRIAGE_MODEL=gpt-5.4-mini",
        "OPENCLAW_CRITICAL_MODEL=gpt-5.5",
        "OPENCLAW_ROUTER_POLICY=cost_optimized",
        "TENNIS_EDGE_CORS_ORIGIN",
        "TENNIS_EDGE_RUNTIME_PROFILE=lean_atp",
        "TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men,grand_slam_women",
        "TENNIS_EDGE_MONTHLY_BUDGET_USD=500",
        "ENTERPRISE_FEEDS_ENABLED=false",
        "EXECUTION_ENABLED=false",
    ]:
        if key not in env_text:
            errors.append(f".env.example missing {key}")
    if os.environ.get("EXECUTION_ENABLED", "false").lower() != "false":
        errors.append("EXECUTION_ENABLED must remain false for budget v1")
    if os.environ.get("REAL_EXECUTION_HARD_BLOCK", "true").lower() != "true":
        errors.append("REAL_EXECUTION_HARD_BLOCK must remain true for paper-first budget phase")
    for path in [openclaw_skill, openclaw_script, openclaw_policy]:
        if not path.exists():
            errors.append(f"OpenClaw artifact missing {path.relative_to(ROOT)}")
    if openclaw_script.exists():
        script_text = openclaw_script.read_text()
        for forbidden in ["readFileSync", "readFile(", "betfair.com", "placeOrders"]:
            if forbidden in script_text:
                errors.append(f"OpenClaw script contains forbidden reference {forbidden}")
    if openclaw_policy.exists():
        policy_text = openclaw_policy.read_text()
        for required in ["\"critical_model\": \"gpt-5.5\"", "\"allow_betfair_direct_api\": false"]:
            if required not in policy_text:
                errors.append(f"OpenClaw policy missing {required}")

    if errors:
        sys.stderr.write("\n".join(errors) + "\n")
        return 1
    print("private runtime checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
