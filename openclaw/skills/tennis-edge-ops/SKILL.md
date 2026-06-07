---
name: tennis-edge-ops
description: Operate the local Tennis Live Edge backend through safe Agent Ops APIs for briefing, anomaly review, paper autopilot, and run audit.
---

# Tennis Edge Ops

Use this skill for OpenClaw-local operations against the private Tennis Live Edge
FastAPI backend.

## Boundaries

- Only call `TENNIS_EDGE_API_BASE`, defaulting to `http://localhost:8000`.
- Do not read `.env` files.
- Do not print `ADMIN_API_TOKEN` or any secret.
- Do not call Betfair or any sportsbook directly.
- Do not automate sportsbook browser sessions.
- Real execution is out of scope while `REAL_EXECUTION_HARD_BLOCK=true`.

## Commands

```bash
npm run api:ingest
printf '{"event_id":"smoke-event","seq":1,"timestamp":"2026-06-07T20:00:00Z","data":{"bookmaker":"SmokeBook","market":"h2h","selections":[{"player_id":"p1","odds":1.8},{"player_id":"p2","odds":2.1}]}}' | TENNIS_EDGE_DATA_MODE=sample TENNIS_EDGE_PERSISTENCE_ENABLED=false npm run api:ingest:odds-message
node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs briefing
node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs anomalies
node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs runs
node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs preflight
printf "%s" "$ADMIN_API_TOKEN" | node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs autopilot --token-stdin
```

The `api:ingest` command runs one provider ingestion cycle and prints a JSON
summary with source, match count, raw payload count, signal count, and timestamp.
The `api:ingest:odds-message` command reads one Odds-API.io websocket-style JSON
message from stdin, persists raw payload/cursor/latency when Postgres is
enabled, and reports `resync_required` without creating orders.
The `autopilot` command creates paper orders only through
`POST /api/v1/agent/autopilot/evaluate`.
The `preflight` command should run before cron/autopilot jobs; it checks API
reachability, local gateway reachability, persistence, provider key readiness,
and the real-execution hard block.
The `autopilot` command also runs preflight internally and aborts before calling
protected backend actions when the preflight status is `blocked`.

Use the repo npm wrapper for autopilot so the token is passed through stdin and
is not read by the skill from `.env` or process environment.

## Cost Router

- Routine route: `OPENCLAW_TRIAGE_MODEL`, default `gpt-5.4-mini`.
- Critical route: `OPENCLAW_CRITICAL_MODEL`, default `gpt-5.5`.
- Use the critical route only for severe anomalies, model-promotion reports, and
  real-execution readiness reviews.
