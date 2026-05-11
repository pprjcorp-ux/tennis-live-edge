# OpenClaw Autopilot

OpenClaw is a local operations orchestrator for Tennis Live Edge. It monitors
the backend, creates paper orders only when the backend has already emitted a
valid `Entrada` signal, and summarizes anomalies/results.

## Local Commands

```bash
npm run openclaw:briefing
npm run openclaw:anomalies
npm run openclaw:runs
ADMIN_API_TOKEN=... npm run openclaw:autopilot
```

The skill lives in `openclaw/skills/tennis-edge-ops`. Copy it into
`~/.openclaw/skills/tennis-edge-ops` for the OpenClaw runtime to discover it.

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
