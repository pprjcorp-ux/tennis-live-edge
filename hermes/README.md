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
npm run hermes:intelligence
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

`hermes:intelligence` is the high-signal operator packet for cron/Telegram. It
aggregates provider health, cursor gaps, data quality, cost, paper performance,
bankroll, live signals, replay lab and onboarding state. It recommends one safe
mode: investigate, budget-chain buildout, paper-autopilot candidate, collect
learning data, replay-lab hardening, or steady monitoring.

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
