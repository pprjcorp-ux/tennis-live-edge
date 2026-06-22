---
name: tennis-edge-ops
description: Operate the local Tennis Live Edge backend through safe Agent Ops APIs for briefing, anomaly review, paper autopilot, and run audit.
---

# Tennis Edge Ops

Use this skill for Hermes-local operations against the private Tennis Live Edge
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
npm run api:ingest:live-budget
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs ingest-live-budget
npm run api:ingest
printf '{"event_id":"smoke-event","seq":1,"timestamp":"2026-06-07T20:00:00Z","data":{"bookmaker":"SmokeBook","market":"h2h","selections":[{"player_id":"p1","odds":1.8},{"player_id":"p2","odds":2.1}]}}' | TENNIS_EDGE_DATA_MODE=sample TENNIS_EDGE_PERSISTENCE_ENABLED=false npm run api:ingest:odds-message
npm run api:ingest:odds-stream -- --max-messages 25 --timeout-seconds 30
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs briefing
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs anomalies
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs runs
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs ingestion-runs
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs preflight
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs intelligence
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs events
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs playbook
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs live-stats
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs budget-chain
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs provider-smoke
printf "%s" "$ADMIN_API_TOKEN" | node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs ops-daily --token-stdin
printf "%s" "$ADMIN_API_TOKEN" | node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs autopilot --token-stdin
```

The `api:ingest` command runs one provider ingestion cycle and prints a JSON
summary with source, match count, raw payload count, signal count, and timestamp.
The `api:ingest:live-budget` command is the preferred cron entrypoint because
it combines score snapshot, odds websocket ingestion, and execution safety state
in one JSON report.
The `ingest-live-budget` skill command wraps that npm script and preserves
machine-readable JSON for Telegram/cron reports.
Recent ingestion cycles are journaled in `ingestion_runs` and exposed at
`GET /api/v1/ingestion/runs` when persistence is enabled; use the
`ingestion-runs` skill command to print them.
The `api:ingest:odds-message` command reads one Odds-API.io websocket-style JSON
message from stdin, persists raw payload/cursor/latency when Postgres is
enabled, attempts deterministic normalized `odds_ticks` storage for resolved
matches/players, and reports `resync_required` without creating orders.
The `api:ingest:odds-stream` command opens the live websocket only when
`ODDS_API_IO_KEY` exists and the persisted cursor is safe to consume from.
Only use `POST /api/v1/ingestion/provider-cursors/resync` after a trusted REST
snapshot has been applied and the last provider sequence is known.
The `ops-daily` command calls protected `POST /api/v1/ops/daily` to rehearse
replay contracts, paper auto-settlement, and Model Lab `training_examples`
without consuming live API quota.
The `autopilot` command creates paper orders only through
`POST /api/v1/agent/autopilot/evaluate`.
The `preflight` command should run before cron/autopilot jobs; it checks API
reachability, local gateway reachability, persistence, provider key readiness,
and the real-execution hard block.
The `intelligence` command is the preferred cron/Telegram status packet. It
reads only internal FastAPI endpoints and produces a redacted JSON decision
brief with operational mode, blockers, allowed collection paths, forbidden
collection paths, learning state, cost state, and safety state.
The `events` command converts the intelligence packet into deterministic
dispatch events for cron/webhook/Telegram. It reports an allowed command,
admin-token requirement, and paper-order permission for each event; it never
permits real order submission.
The `playbook` command converts the current state into a phase-based operating
plan with ready/waiting/blocked steps. It is a planner only; it does not execute
commands or create orders.
The `live-stats` command emits deterministic live collection, processing,
freshness, signal, cost, and learning metrics. It is safe for frequent polling
and keeps LLM-per-tick disabled.
The `budget-chain` command emits a dry-run provider onboarding plan. It can
name the next smoke command, but it does not execute provider APIs or spend
quota.
The `provider-smoke` command is the explicit local gate for the current budget
provider smoke. By default it returns blocked dry-run JSON; only
`--execute-provider-call` may run a supported smoke, and that flag must not be
used from cron or Telegram automation.
The `autopilot` command also runs preflight internally and aborts before calling
protected backend actions when the preflight status is `blocked`.

Use the repo npm wrapper for autopilot so the token is passed through stdin and
is not read by the skill from `.env` or process environment.

## Cost Router

- Routine route: `HERMES_TRIAGE_MODEL`, default `gpt-5.4-mini`.
- Critical route: `HERMES_CRITICAL_MODEL`, default `gpt-5.5`.
- Use the critical route only for severe anomalies, model-promotion reports, and
  real-execution readiness reviews.
