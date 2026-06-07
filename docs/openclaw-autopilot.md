# OpenClaw Autopilot

OpenClaw is a local operations orchestrator for Tennis Live Edge. It monitors
the backend, creates paper orders only when the backend has already emitted a
valid `Entrada` signal, and summarizes anomalies/results.

## Local Commands

```bash
npm run api:ingest:live-budget
node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs ingest-live-budget
npm run api:ingest
printf '{"event_id":"smoke-event","seq":1,"timestamp":"2026-06-07T20:00:00Z","data":{"bookmaker":"SmokeBook","market":"h2h","selections":[{"player_id":"p1","odds":1.8},{"player_id":"p2","odds":2.1}]}}' | TENNIS_EDGE_DATA_MODE=sample TENNIS_EDGE_PERSISTENCE_ENABLED=false npm run api:ingest:odds-message
npm run api:ingest:odds-stream -- --max-messages 25 --timeout-seconds 30
npm run openclaw:briefing
npm run openclaw:anomalies
npm run openclaw:runs
npm run openclaw:preflight
ADMIN_API_TOKEN=... npm run openclaw:autopilot
```

The skill lives in `openclaw/skills/tennis-edge-ops`. Copy it into
`~/.openclaw/skills/tennis-edge-ops` for the OpenClaw runtime to discover it.

For scheduled budget operation, prefer `api:ingest:live-budget`. It runs the
API-Tennis snapshot and the Odds-API.io websocket consumer in one process, then
prints a single JSON summary with safety state.
OpenClaw can call the same cycle through the `ingest-live-budget` skill command
when you want all operations routed through `tennis_edge_ops.mjs`.
Each score snapshot, odds stream, and live-budget cycle is journaled in
`ingestion_runs` when persistence is enabled; read recent rows with
`GET /api/v1/ingestion/runs`.

## Audit Trail

`/api/v1/agent/runs` reads persisted `agent_runs` when Postgres is enabled and
falls back to in-memory runs only in sample/dev mode. Each run stores:

- source (`dashboard`, `telegram`, `cron`, `openclaw`, or `system`);
- model routes and estimated cost;
- actions taken, skipped, blocked, or failed;
- paper orders created through backend gates.

Critical-route runs are shown first in the audit view so severe anomaly or
real-execution-readiness reviews are not buried by routine polling.

Odds-API.io websocket smoke/replay can use
`POST /api/v1/ingestion/odds-api-io/message` or the
`api:ingest:odds-message` stdin wrapper. That path persists the raw provider
payload, updates the provider cursor, records latency, attempts deterministic
`odds_ticks` normalization for already-resolved matches/players, and reports
whether `resync_required` should block signals.

After a trusted REST snapshot is applied, the protected
`POST /api/v1/ingestion/provider-cursors/resync` endpoint records the provider,
stream, and last trusted sequence. Use it to clear websocket gaps only after the
snapshot is actually reconciled.

`api:ingest:odds-stream` opens the live Odds-API.io websocket only when
`ODDS_API_IO_KEY` is configured and the persisted cursor does not require
resync. It uses the same persistent message-ingestion path for each websocket
payload.

## Preflight

Run `npm run openclaw:preflight` before cron/autopilot execution. It checks:

- FastAPI Agent Ops reachability;
- admin-token readiness for protected actions;
- OpenClaw loopback gateway reachability;
- persistence/store status;
- budget provider key readiness;
- `REAL_EXECUTION_HARD_BLOCK` and `can_submit_real_orders=false`.

`npm run openclaw:autopilot` also performs this preflight internally and aborts
before protected actions when the preflight status is `blocked`. A `degraded`
status is allowed for paper mode, for example when live provider keys are still
missing but persistence and safety gates are healthy.

## Model Routing

- Routine triage: `OPENCLAW_TRIAGE_MODEL=gpt-5.4-mini`
- Critical reports: `OPENCLAW_CRITICAL_MODEL=gpt-5.5`
- Policy: `OPENCLAW_ROUTER_POLICY=cost_optimized`

The model route is for summaries, anomaly interpretation, model-promotion
reports, and readiness reviews. Edge math, Markov probabilities, stake sizing,
risk gates, and orders remain deterministic backend code.

## Safety Boundary

OpenClaw must not read `.env`, print secrets, call Betfair directly, or automate
bookmaker/sportsbook browsers. It may call internal FastAPI endpoints that
enforce deterministic gates.
