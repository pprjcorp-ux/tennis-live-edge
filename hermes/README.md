# Hermes Agent Ops

This folder contains the local Hermes Agent operating surface for Tennis Live
Edge. It replaces the previous OpenClaw folder.

Hermes is allowed to monitor the FastAPI backend, run operational reports, and
create paper orders through deterministic backend gates. Hermes must not hold
sportsbook credentials, call Betfair directly, automate sportsbook browsers, or
place real-money orders.

## Install

```bash
hermes status
hermes doctor
hermes security audit --deep
```

Keep the gateway local-only. Use Telegram only after pairing an allowlisted user.

```bash
export TENNIS_EDGE_API_BASE=http://localhost:8000
export ADMIN_API_TOKEN=replace-with-local-admin-token
export HERMES_TELEGRAM_ALLOWED_USER_IDS=123456789
```

## Local Skill Commands

```bash
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
npm run hermes:live-window
npm run hermes:learning-review
npm run hermes:budget-chain
npm run hermes:provider-smoke
npm run hermes:safe-loop
npm run hermes:scheduler-rehearsal
npm run hermes:cron-proposal
npm run hermes:activation-checklist
npm run hermes:runtime-fix-plan
npm run hermes:ops:daily
npm run hermes:autopilot
```

Use `npm --silent run hermes:intelligence` or the direct `node
hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs intelligence` command
when another tool needs pure JSON without the npm banner.

`hermes:ops:daily` and `hermes:autopilot` read `ADMIN_API_TOKEN` from the
repo-local `.env` in the npm wrapper and pass it to the skill through stdin. The
skill script itself does not read `.env` files or print secret values.

`hermes:ops:daily` runs replay contracts, paper auto-settlement, and Model Lab
rehearsal without live API calls. `hermes:autopilot` only creates paper orders
for backend-approved `Entrada` signals. Real execution remains blocked by
`REAL_EXECUTION_HARD_BLOCK=true`.

`hermes:runtime-check` runs `hermes status` and `hermes doctor` as local
read-only diagnostics and returns JSON with stdout/stderr/exit codes. It does
not start, stop, install, or repair Hermes services.

`hermes:intelligence` is the high-signal operator packet for cron/Telegram. It
aggregates provider health, cursor gaps, data quality, cost, paper performance,
bankroll, live signals, replay lab and onboarding state. It recommends one safe
mode: investigate, budget-chain buildout, paper-autopilot candidate, collect
learning data, replay-lab hardening, or steady monitoring.
Enterprise-only cursors such as Sportradar/Betradar/TXODDS are reported as
`deferred_enterprise_cursors` while the budget chain is incomplete, so they do
not block lean ATP/Grand Slam operation before enterprise is eligible.

`hermes:events` converts that packet into deterministic event triggers for
cron/webhook routing. It can recommend commands such as `hermes:preflight`,
`api:check:operational-truth`, `hermes:ops:daily`, or `hermes:autopilot`.
Paper order creation is only marked possible for `paper_autopilot_candidate`
when no high-severity data, cursor, provider, preflight, budget-chain, or real
execution safety blocker exists.

`hermes:unblock-plan` turns blockers into prioritized operator lanes: local
runtime, provider smoke, provider credentials, data quality, learning
collection, and deferred enterprise work. It is read-only and never runs the
suggested commands.

`hermes:playbook` converts the same state into phase-based operating steps:
observe, stabilize data, complete the budget chain, collect learning evidence,
paper autopilot, and weekly learning review. It does not run commands. It marks
each step as `ready`, `waiting`, or `blocked`, and always keeps
`can_submit_real_orders=false`.

`hermes:live-stats` is the low-cost live operations packet. It derives
collection health, processing health, signal readiness, freshness buckets,
learning progress, cost efficiency, and the safe sampling policy from internal
FastAPI state. It is designed for frequent cron/Telegram use without LLM
analysis on every tick.

`hermes:live-window` is the go/no-go packet for a live operating window. It
combines event gates, provider mode, freshness, budget-chain state, signal
readiness, and execution safety into `paper_ready`, `monitor`, `blocked`, or
`safety_stop`. It is read-only and never executes the returned next action.

`hermes:learning-review` is the weekly readiness packet. It summarizes
settled paper evidence, production training examples, ROI/CLV readiness and
high-severity blockers, routes interpretation to `gpt-5.5`, and still returns
`real_execution_recommendation=keep_blocked`.

`hermes:budget-chain` turns API onboarding state into a dry-run provider smoke
plan. It reports the current provider, required prerequisites, and exact smoke
command, but defaults `provider_api_call_allowed=false` so Hermes cannot spend
vendor quota without an explicit operator action.

`hermes:provider-smoke` is the explicit execution gate for the current budget
provider smoke. Without `--execute-provider-call`, it returns a blocked dry-run
packet with `provider_api_call_allowed=false` and the command it would run. Do
not put `--execute-provider-call` in cron or Telegram automation; use it only
from a local operator shell when you intentionally want to spend provider quota.

`hermes:safe-loop` is the preferred autonomous status packet. It aggregates the
local runtime check, intelligence, event routing, unblock plan, playbook,
live-stats, budget-chain, and weekly-learning packets into one read-only JSON
decision. It never creates paper orders, spends provider quota, calls provider
smoke execution, or submits real orders.

`hermes:scheduler-rehearsal` turns the latest safe-loop output into a proposed
local schedule and appends a JSONL audit row to `hermes/runs/`. It does not
create real cron jobs, execute commands, create paper orders, spend provider
quota, or submit real orders.

`hermes:cron-proposal` writes a reviewable local manifest at
`hermes/runs/cron-proposal.json` with exact `hermes cron add` command previews.
It does not call `hermes cron add` and excludes provider-smoke, autopilot,
admin-token, quota-consuming, and order-creating jobs.

`hermes:activation-checklist` is the final non-mutating gate before a human
creates cron jobs. It checks Hermes runtime health, Telegram allowlist,
private-access email allowlist, local admin secret presence, cron manifest
safety, no executed commands, and the real-execution hard block. It prints only
booleans/counts for secrets and exposes manual activation commands only when
all checks pass.

`hermes:runtime-fix-plan` converts failed activation-checklist gates into
ordered local/operator actions. It is read-only, does not write the cron
manifest, does not execute repair/restart/install commands, does not create
jobs, and keeps provider API calls, paper orders, and real execution blocked.

Cron creation examples are in `hermes/cron.examples.md`; create them only after
Telegram pairing/allowlist and local admin secrets are configured.

## Persistent Audit

When Postgres persistence is enabled, Hermes autopilot writes every run to the
backend `agent_runs` table and persists each created paper order. `npm run
hermes:runs` should keep showing the last operational runs after an API restart.
In sample/dev mode, the endpoint falls back to process memory.

Run `npm run hermes:preflight` before cron/autopilot jobs. It checks the API,
Hermes loopback gateway, admin-token readiness, persistence, budget provider
keys, and the real-execution hard block.

## Model Router Defaults

- Routine triage and reports: `HERMES_TRIAGE_MODEL=gpt-5.4-mini`
- Critical anomaly/readiness/model-promotion reports: `HERMES_CRITICAL_MODEL=gpt-5.5`
- Policy: `HERMES_ROUTER_POLICY=cost_optimized`

The model router is for explanations and reports. Edge math, Markov logic, risk
gates, and order decisions remain deterministic Python backend code.

## Collection Boundary

Hermes may accelerate collection by orchestrating licensed provider APIs,
websockets, internal FastAPI endpoints, persisted Postgres replay, and manual
operator notes. It must not use sportsbook UI automation, anti-bot bypass,
geolocation bypass, credential/session extraction, or paywall/ToS
circumvention.
