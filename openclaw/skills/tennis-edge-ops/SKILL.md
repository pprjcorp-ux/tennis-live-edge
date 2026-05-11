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
node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs briefing
node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs anomalies
node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs runs
ADMIN_API_TOKEN=... node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs autopilot
```

The `autopilot` command creates paper orders only through
`POST /api/v1/agent/autopilot/evaluate`.

## Cost Router

- Routine route: `OPENCLAW_TRIAGE_MODEL`, default `gpt-5.4-mini`.
- Critical route: `OPENCLAW_CRITICAL_MODEL`, default `gpt-5.5`.
- Use the critical route only for severe anomalies, model-promotion reports, and
  real-execution readiness reviews.
