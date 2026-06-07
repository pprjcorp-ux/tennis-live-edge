# OpenClaw Autopilot

This folder contains the local OpenClaw operating surface for Tennis Live Edge.
It is intentionally narrow: OpenClaw can monitor the FastAPI backend, create
paper orders through deterministic gates, and generate summaries. It does not
hold sportsbook credentials, call Betfair directly, automate browsers, or place
real-money orders.

## Install

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
openclaw security audit --deep
```

Keep the gateway local-only. Use Telegram only with an allowlist.

```bash
export TENNIS_EDGE_API_BASE=http://localhost:8000
export ADMIN_API_TOKEN=replace-with-local-admin-token
export OPENCLAW_TELEGRAM_ALLOWED_USER_IDS=123456789
```

## Local Skill Commands

```bash
npm run openclaw:briefing
npm run openclaw:anomalies
npm run openclaw:runs
npm run openclaw:preflight
npm run openclaw:autopilot
```

`openclaw:autopilot` reads `ADMIN_API_TOKEN` from the repo-local `.env` in the
npm wrapper and passes it to the skill through stdin. The skill itself does not
read `.env` or environment variables. It only creates paper orders for
backend-approved `Entrada` signals. Real execution remains blocked by
`REAL_EXECUTION_HARD_BLOCK=true`.
Cron creation examples are in `openclaw/cron.examples.md`; create them only
after Telegram pairing/allowlist and local admin secrets are configured.

## Persistent Audit

When Postgres persistence is enabled, OpenClaw autopilot writes every run to the
backend `agent_runs` table and persists each created paper order. `npm run
openclaw:runs` should therefore keep showing the last operational runs after an
API restart. In sample/dev mode, the endpoint falls back to process memory.

Run `npm run openclaw:preflight` before cron/autopilot jobs. It checks the API,
OpenClaw loopback gateway, admin-token readiness, persistence, budget provider
keys, and the real-execution hard block.

## Model Router Defaults

- Routine triage and reports: `OPENCLAW_TRIAGE_MODEL=gpt-5.4-mini`
- Critical anomaly/readiness/model-promotion reports: `OPENCLAW_CRITICAL_MODEL=gpt-5.5`
- Policy: `OPENCLAW_ROUTER_POLICY=cost_optimized`

The model router is for explanations and reports. Edge math, Markov logic, risk
gates, and order decisions remain deterministic Python backend code.
