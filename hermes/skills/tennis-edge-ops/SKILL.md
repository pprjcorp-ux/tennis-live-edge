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
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs runtime-check
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs doctor-triage
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs channel-readiness
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs channel-recovery-plan
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs backend-readiness
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs mission-control
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs mission-ledger
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs mission-ledger-report
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs intelligence
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs events
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs unblock-plan
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs playbook
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs live-stats
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs live-window
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs match-pulse
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs collection-plan
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs quota-plan
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs learning-review
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs budget-chain
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs provider-smoke
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs safe-loop
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs autonomy-brief
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs source-discovery
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs source-route-matrix
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs trigger-policy
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs ops-compiler
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs capability-audit
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs autonomy-gates
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs experiment-lab
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs experiment-ledger
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs experiment-ledger-report
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs backlog-plan
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs operator-packet
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs operator-ledger
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs operator-ledger-report
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs runtime-fix-priorities
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs scheduler-rehearsal
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs cron-proposal
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs activation-checklist
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs runtime-fix-plan
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
The `runtime-check` command runs read-only Hermes CLI diagnostics and captures
status/doctor output as JSON. It must not repair, install, or restart services.
The `doctor-triage` command runs bounded local probes for Hermes version,
status, and a short doctor attempt. It should classify doctor timeouts without
starting services, editing credentials, calling providers, or printing secrets.
The `channel-readiness` command proves local channel prerequisites without
FastAPI: Hermes CLI availability, gateway running state, bounded doctor pass,
Telegram allowlist, private Access allowlist, and local admin token presence.
It emits manual actions only and must keep `executes_now=false`.
The `channel-recovery-plan` command summarizes failed channel gates, local env
names, configured counts, verification commands, and human-only steps without
printing secret values or mutating runtime.
The `backend-readiness` command proves local FastAPI readiness with bounded
internal GETs against preflight, dashboard live-state, live matches, provider
health, cost profile and execution status. It must fail closed, preserve the
real-execution hard block, and never start services itself.
The `mission-control` command is the one-packet entrypoint for external agents:
it merges backend readiness, channel readiness, source-route matrix and
live-window into ordered lanes and one next action. It must not execute that
action.
The `mission-ledger` command records mission-control decisions as local JSONL
with `action_executed=false` and `mission_command_executed=false`. The
`mission-ledger-report` command summarizes repeated mission blockers and must
remain read-only.
Internal FastAPI requests are bounded by `HERMES_HTTP_TIMEOUT_MS` (default
5000ms, clamped between 100ms and 30000ms). Composed commands must fail closed
with `backend_api` blockers when the backend is unavailable or slow; they must
not hang, spend provider quota, create paper orders, or submit real orders.
The `intelligence` command is the preferred cron/Telegram status packet. It
reads only internal FastAPI endpoints and produces a redacted JSON decision
brief with operational mode, blockers, allowed collection paths, forbidden
collection paths, learning state, cost state, and safety state.
Enterprise-only cursors are deferred while enterprise is ineligible and must
not block budget-chain operation.
The `events` command converts the intelligence packet into deterministic
dispatch events for cron/webhook/Telegram. It reports an allowed command,
admin-token requirement, and paper-order permission for each event; it never
permits real order submission.
The `unblock-plan` command classifies blockers into prioritized safe lanes. It
is read-only and must not execute the suggested commands.
The `playbook` command converts the current state into a phase-based operating
plan with ready/waiting/blocked steps. It is a planner only; it does not execute
commands or create orders.
The `live-stats` command emits deterministic live collection, processing,
freshness, signal, cost, and learning metrics. It is safe for frequent polling
and keeps LLM-per-tick disabled.
The `live-window` command emits a read-only go/no-go decision for live
operation. It returns `paper_ready`, `monitor`, `blocked`, or `safety_stop`
with explicit gates and never executes the next action.
The `match-pulse` command ranks live matches into a compact watchlist using
freshness, pressure state, edge, signal status, and the live-window gate. It is
read-only and never creates orders itself.
The `collection-plan` command converts the watchlist into desired polling
lanes. It is read-only and keeps provider ingestion as operator-candidate
commands with `executes_now=false`.
The `quota-plan` command applies cost/budget throttles to collection cadence.
It is read-only and suppresses provider candidates when budget guardrails are
active.
The `learning-review` command emits a weekly readiness packet for ROI, CLV,
production training examples, model review gates, and real-execution hard
blocking. It is read-only and does not promote models.
The `budget-chain` command emits a dry-run provider onboarding plan. It can
name the next smoke command, but it does not execute provider APIs or spend
quota.
The `provider-smoke` command is the explicit local gate for the current budget
provider smoke. By default it returns blocked dry-run JSON; only
`--execute-provider-call` may run a supported smoke, and that flag must not be
used from cron or Telegram automation.
The `safe-loop` command is the preferred autonomous packet. It aggregates
runtime, intelligence, events, unblock-plan, playbook, live-stats, quota-plan,
budget-chain, and learning review into one read-only decision and never creates
orders or spends provider quota.
The `autonomy-brief` command converts safe-loop, live-window, quota, research
principles, and ledger priorities into one autonomy matrix and action queue. It
is read-only and must not execute the queued actions.
The `source-discovery` command maps useful data classes to allowed acquisition
paths and blocked routes. It is read-only and must treat jailbreak as route
discovery, never bypass.
The `source-route-matrix` command ranks those allowed paths into prioritized
replay/internal/provider/manual routes with triggers, cost tiers, success
evidence and blocked conditions. Provider routes must remain operator-only with
`provider_api_call_allowed=false`.
The `trigger-policy` command maps current state to debounced wakeup triggers
for cron, Telegram, dashboard, Cloudflare Agent, and OpenClaw gateway. It is
read-only and must not execute trigger commands.
The `ops-compiler` command compiles trigger policy, source discovery, autonomy
brief, operator packet, and model routing into one channel payload. It is
read-only and must not execute compiled actions.
The `capability-audit` command scores Hermes autonomy against current backend
evidence. It is read-only and must not execute the next safe command it reports.
The `autonomy-gates` command proves the highest current safe autonomy level with
ordered gates, `active_ceiling`, and `next_required_gate`. It is read-only, must
not create paper orders, and keeps enterprise review locked until the budget
chain is eligible.
The `experiment-lab` command ranks safe research/test paths with hypotheses,
prerequisites, `success_metrics`, evidence, and command previews. It is
read-only and must not execute experiments, spend provider quota, or create
orders.
The `experiment-ledger` command appends that lab decision to local JSONL with
`experiment_command_executed=false`. The `experiment-ledger-report` command
summarizes repeated experiment recommendations without writing or executing.
The `backlog-plan` command reads local mission, operator and experiment ledgers
and emits non-executing implementation priorities with target files, validation
commands, and acceptance evidence.
Runtime commands should carry `runtime_findings` and non-executed diagnostic
actions, with `mutates_runtime_if_run=true` for manual gateway/service changes.
The `operator-packet` command compresses safe-loop into a short channel-safe
decision for Telegram/OpenClaw. It is read-only and never executes the next
safe action it reports.
The `operator-ledger` command appends the channel packet to local JSONL with
`action_executed=false`. It writes only the local audit row.
The `operator-ledger-report` command summarizes that local JSONL without
writing or executing actions.
The `runtime-fix-priorities` command converts repeated ledger blockers into
non-mutating local remediation priorities.
The `scheduler-rehearsal` command turns safe-loop output into a proposed local
schedule and writes only a local JSONL audit row. It must not create cron jobs
or execute scheduled commands.
The `cron-proposal` command writes a local review manifest with `hermes cron add`
command previews. It must not call `hermes cron add` and must exclude autopilot,
provider-smoke, admin-token, quota-consuming, or order-creating jobs.
The `activation-checklist` command is the final non-mutating gate before a
human creates cron jobs. It exposes manual commands only when runtime,
Telegram/private allowlists, local admin secret presence, safe manifest, and
real-execution hard block all pass.
The `runtime-fix-plan` command turns failed activation gates into ordered
manual/local diagnostic actions. It is read-only, does not write manifests,
does not repair/restart/install services, and does not create jobs, paper
orders, provider API calls, or real orders.
The `autopilot` command also runs preflight internally and aborts before calling
protected backend actions when the preflight status is `blocked`.

Use the repo npm wrapper for autopilot so the token is passed through stdin and
is not read by the skill from `.env` or process environment.

## Cost Router

- Routine route: `HERMES_TRIAGE_MODEL`, default `gpt-5.4-mini`.
- Critical route: `HERMES_CRITICAL_MODEL`, default `gpt-5.5`.
- Use the critical route only for severe anomalies, model-promotion reports, and
  real-execution readiness reviews.
