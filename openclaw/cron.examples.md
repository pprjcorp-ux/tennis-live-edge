# OpenClaw Cron Examples

Use these after Telegram pairing/allowlist and local secrets are configured.
They are not created automatically because the repository must not assume a
Telegram chat id or store `ADMIN_API_TOKEN`.

Ingestion every 5 minutes while the system is active:

```bash
openclaw cron add \
  --name tennis-edge-live-budget-cycle \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run node openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs ingest-live-budget from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report score_ingestion, odds_ingestion, and safety state; do not create orders from this cron." \
  --timeout-seconds 45
```

Daily briefing, cheap model:

```bash
openclaw cron add \
  --name tennis-edge-daily-briefing \
  --cron "0 8 * * *" \
  --tz America/Sao_Paulo \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm run openclaw:briefing from /Users/ppfahd/Workspace/projects/tennis-live-edge and summarize data health, signals, paper performance, and cost." \
  --timeout-seconds 60
```

Preflight every 15 minutes while the system is active:

```bash
openclaw cron add \
  --name tennis-edge-preflight \
  --every 15m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm run openclaw:preflight from /Users/ppfahd/Workspace/projects/tennis-live-edge. If status is blocked, report the failed checks and do not run autopilot." \
  --timeout-seconds 45
```

Live anomaly scan every 15 minutes:

```bash
openclaw cron add \
  --name tennis-edge-anomaly-scan \
  --every 15m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm run openclaw:anomalies from /Users/ppfahd/Workspace/projects/tennis-live-edge. Escalate only critical provider, cursor, data-quality, risk, or bankroll anomalies." \
  --timeout-seconds 60
```

Paper autopilot every 5 minutes during live windows, only after
`ADMIN_API_TOKEN` is available to OpenClaw as a local secret:

```bash
openclaw cron add \
  --name tennis-edge-paper-autopilot \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm run openclaw:autopilot from /Users/ppfahd/Workspace/projects/tennis-live-edge. The command must obey preflight and create paper orders only through the backend; never request real execution." \
  --timeout-seconds 60
```

Weekly learning/readiness review, strong model route:

```bash
openclaw cron add \
  --name tennis-edge-weekly-learning-review \
  --cron "0 20 * * 0" \
  --tz America/Sao_Paulo \
  --model gpt-5.5 \
  --message "Use the tennis-edge-ops skill and local API reports to prepare a weekly ROI/CLV/calibration/readiness review. Do not enable real execution." \
  --timeout-seconds 180
```
