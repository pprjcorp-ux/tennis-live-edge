# Hermes Autopilot

Hermes is a local operations orchestrator for Tennis Live Edge. It monitors
the backend, creates paper orders only when the backend has already emitted a
valid `Entrada` signal, and summarizes anomalies/results.

## Local Commands

```bash
npm run api:ingest:live-budget
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs ingest-live-budget
npm run api:ingest
printf '{"event_id":"smoke-event","seq":1,"timestamp":"2026-06-07T20:00:00Z","data":{"bookmaker":"SmokeBook","market":"h2h","selections":[{"player_id":"p1","odds":1.8},{"player_id":"p2","odds":2.1}]}}' | TENNIS_EDGE_DATA_MODE=sample TENNIS_EDGE_PERSISTENCE_ENABLED=false npm run api:ingest:odds-message
npm run api:ingest:odds-stream -- --max-messages 25 --timeout-seconds 30
npm run api:ops:daily
npm run hermes:briefing
npm run hermes:anomalies
npm run hermes:runs
npm run hermes:preflight
npm run hermes:runtime-check
npm run hermes:intelligence
npm run hermes:events
npm run hermes:unblock-plan
npm run hermes:playbook
npm run hermes:live-stats
npm run hermes:learning-review
npm run hermes:budget-chain
npm run hermes:provider-smoke
npm run hermes:safe-loop
npm run hermes:scheduler-rehearsal
npm run hermes:cron-proposal
npm run hermes:activation-checklist
ADMIN_API_TOKEN=... npm run hermes:ops:daily
ADMIN_API_TOKEN=... npm run hermes:autopilot
```

For machine-readable JSON without npm's banner, call
`npm --silent run hermes:intelligence` or the direct `node
hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs intelligence`
entrypoint.

The skill lives in `hermes/skills/tennis-edge-ops`. Copy it into
`~/.hermes/skills/tennis-edge-ops` for the Hermes runtime to discover it.

For scheduled budget operation, prefer `api:ingest:live-budget`. It runs the
API-Tennis snapshot and the Odds-API.io websocket consumer in one process, then
prints a single JSON summary with safety state.
Hermes can call the same cycle through the `ingest-live-budget` skill command
when you want all operations routed through `tennis_edge_ops.mjs`.
Each score snapshot, odds stream, and live-budget cycle is journaled in
`ingestion_runs` when persistence is enabled; read recent rows with
`GET /api/v1/ingestion/runs`.

Before live provider keys are configured, use `api:ops:daily`,
`hermes:ops:daily`, or protected `POST /api/v1/ops/daily` for the daily
paper-first rehearsal. It runs replay contracts, paper auto-settlement, and the
Model Lab `training_examples` backtest path while reporting `live_api_calls=0`.
The auto-settlement response includes structured per-order `decisions`, so
Hermes can summarize settled, skipped, failed, and training-example-missing
outcomes without parsing free-form reason strings.

Use `hermes:runtime-check` when `unblock-plan` prioritizes the local runtime
lane. It captures `hermes status` and `hermes doctor` output in JSON but does
not modify LaunchAgents, daemons, gateway state, or credentials.

For higher autonomy, use `hermes:intelligence` as the default scheduled packet.
It reads internal APIs only and emits one machine-readable recommendation:
`investigate`, `budget_chain_buildout`, `paper_autopilot_candidate`,
`collect_learning_data`, `replay_lab_hardening`, or `steady_state_monitoring`.
This gives Hermes enough state to choose between monitoring, safe paper
autopilot, replay hardening, provider onboarding, and weekly learning review
without scraping or bypassing external systems.
Deferred enterprise cursors are separated into `deferred_enterprise_cursors`
until the budget chain is complete and enterprise is eligible, preventing
Sportradar/Betradar/TXODDS placeholders from blocking lean budget work.

Use `hermes:events` when Hermes cron, webhook, Telegram, or the dashboard needs
an action router instead of a broad status packet. It converts the intelligence
state into deterministic events with one allowed command, whether an admin token
is required, whether paper orders can be created, and
`can_submit_real_orders=false`. It blocks paper autopilot when preflight,
provider health, cursor resync, data quality, budget-chain, or real-execution
safety blockers exist.

Use `hermes:unblock-plan` when the operator needs the fastest safe path from
blocked state to budget-chain progress. It classifies blockers into read-only
local diagnostics, explicit provider smoke, credential work, replay/data quality
checks, learning collection, and deferred enterprise items.

Use `hermes:playbook` when the operator or a Hermes channel needs a phase plan.
It does not execute commands. It groups the current state into observe,
stabilize-data, budget-chain, collect-learning, paper-autopilot, and
learning-review steps, with write/live-call flags and hard real-execution
denials on every step.

Use `hermes:live-stats` for high-frequency live operations summaries. It emits
deterministic collection, processing, signal, freshness, cost, learning, and
sampling-policy metrics from internal APIs only. This is the preferred packet
for fast monitoring because it avoids per-tick LLM analysis.

Use `hermes:learning-review` for weekly ROI/CLV/calibration/readiness review.
It is read-only, recommends the `gpt-5.5` route for interpretation, and keeps
`real_execution_recommendation=keep_blocked` until a separate compliance task.

Use `hermes:budget-chain` before running any paid provider smoke. It reports
the active onboarding step and the exact command to run, while keeping
`provider_api_call_allowed=false` and requiring explicit operator
confirmation before quota-consuming API calls.

Use `hermes:provider-smoke` only as the local confirmation gate. The default
run is blocked dry-run output. Adding `--execute-provider-call` may spend
provider quota, so that flag must remain out of cron, Telegram, webhooks, and
LLM-triggered automation.

Use `hermes:safe-loop` as the default autonomous packet when Hermes needs the
widest safe context in one call. It aggregates runtime diagnostics,
intelligence, event routing, unblock lanes, playbook phases, live stats,
budget-chain state, and learning review into one read-only decision. It does
not create paper orders, execute provider smoke, spend quota, or submit real
orders.

Use `hermes:scheduler-rehearsal` before creating or changing real Hermes cron
jobs. It converts the current safe-loop packet into proposed intervals and
appends a local JSONL row under `hermes/runs/`. It does not create, update, or
delete cron jobs and does not execute the commands in the schedule.

Use `hermes:cron-proposal` to generate a reviewable cron manifest. It writes
`hermes/runs/cron-proposal.json` with exact `hermes cron add` command previews
for safe read-only jobs only. It does not call `hermes cron add` and excludes
autopilot, provider-smoke, admin-token, quota-consuming, and order-creating
jobs.

Use `hermes:activation-checklist` as the final non-mutating gate before any
manual cron creation. It checks Hermes runtime health, Telegram allowlist,
private-access email allowlist, local admin token presence, cron manifest
safety, no executed commands, and the real-execution hard block. Manual
activation commands are empty until every check passes.

## Audit Trail

`/api/v1/agent/runs` reads persisted `agent_runs` when Postgres is enabled and
falls back to in-memory runs only in sample/dev mode. Each run stores:

- source (`dashboard`, `telegram`, `cron`, `hermes`, or `system`);
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

Run `npm run hermes:preflight` before cron/autopilot execution. It checks:

- FastAPI Agent Ops reachability;
- admin-token readiness for protected actions;
- Hermes loopback gateway reachability;
- persistence/store status;
- budget provider key readiness;
- `REAL_EXECUTION_HARD_BLOCK` and `can_submit_real_orders=false`.

`npm run hermes:autopilot` also performs this preflight internally and aborts
before protected actions when the preflight status is `blocked`. A `degraded`
status is allowed for paper mode, for example when live provider keys are still
missing but persistence and safety gates are healthy.

## Model Routing

- Routine triage: `HERMES_TRIAGE_MODEL=gpt-5.4-mini`
- Critical reports: `HERMES_CRITICAL_MODEL=gpt-5.5`
- Policy: `HERMES_ROUTER_POLICY=cost_optimized`

The model route is for summaries, anomaly interpretation, model-promotion
reports, and readiness reviews. Edge math, Markov probabilities, stake sizing,
risk gates, and orders remain deterministic backend code.

## Safety Boundary

Hermes must not read `.env`, print secrets, call Betfair directly, or automate
bookmaker/sportsbook browsers. It may call internal FastAPI endpoints that
enforce deterministic gates.

Treat requests for "jailbreak" in this project as requests for safe operational
leverage, not bypass. Allowed collection paths are licensed provider APIs,
provider websockets, internal FastAPI endpoints, persisted Postgres replay, and
manual operator notes. Forbidden paths are sportsbook UI automation, anti-bot
bypass, geolocation bypass, credential/session extraction, and paywall/ToS
circumvention.
