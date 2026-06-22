# Hermes Cron Examples

Use these after Telegram pairing/allowlist and local secrets are configured.
They are not created automatically because the repository must not assume a
Telegram chat id or store `ADMIN_API_TOKEN`.

Ingestion every 5 minutes while the system is active:

```bash
hermes cron add \
  --name tennis-edge-live-budget-cycle \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs ingest-live-budget from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report score_ingestion, odds_ingestion, and safety state; do not create orders from this cron." \
  --timeout-seconds 45
```

Daily briefing, cheap model:

```bash
hermes cron add \
  --name tennis-edge-daily-briefing \
  --cron "0 8 * * *" \
  --tz America/Sao_Paulo \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm run hermes:briefing from /Users/ppfahd/Workspace/projects/tennis-live-edge and summarize data health, signals, paper performance, and cost." \
  --timeout-seconds 60
```

Daily operational rehearsal, paper-first and no live API quota:

```bash
hermes cron add \
  --name tennis-edge-daily-ops-rehearsal \
  --cron "15 8 * * *" \
  --tz America/Sao_Paulo \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm run hermes:ops:daily from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report replay_passed, paper_auto_settlement, model_lab_backtest, live_api_calls, and execution safety state." \
  --timeout-seconds 90
```

Preflight every 15 minutes while the system is active:

```bash
hermes cron add \
  --name tennis-edge-preflight \
  --every 15m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm run hermes:preflight from /Users/ppfahd/Workspace/projects/tennis-live-edge. If status is blocked, report the failed checks and do not run autopilot." \
  --timeout-seconds 45
```

Live anomaly scan every 15 minutes:

```bash
hermes cron add \
  --name tennis-edge-anomaly-scan \
  --every 15m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm run hermes:anomalies from /Users/ppfahd/Workspace/projects/tennis-live-edge. Escalate only critical provider, cursor, data-quality, risk, or bankroll anomalies." \
  --timeout-seconds 60
```

Intelligence packet every 5 minutes during active windows:

```bash
hermes cron add \
  --name tennis-edge-intelligence-packet \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:intelligence from /Users/ppfahd/Workspace/projects/tennis-live-edge. Summarize mode, blockers, data_snapshot, signal_snapshot, learning_snapshot, cost_snapshot, and safety. Do not create orders from this cron." \
  --timeout-seconds 60
```

Event router every 5 minutes during active windows:

```bash
hermes cron add \
  --name tennis-edge-event-router \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:events from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report severity, events, recommended_commands, can_run_paper_autopilot, and safety. Do not create orders from this cron." \
  --timeout-seconds 60
```

Playbook handoff every 5 minutes during active windows:

```bash
hermes cron add \
  --name tennis-edge-playbook \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:playbook from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report active_phase, ready steps, blocked steps, current_budget_step, and safety boundaries. Do not execute the listed commands from this cron." \
  --timeout-seconds 60
```

Paper autopilot every 5 minutes during live windows, only after
`ADMIN_API_TOKEN` is available to Hermes as a local secret:

```bash
hermes cron add \
  --name tennis-edge-paper-autopilot \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm run hermes:autopilot from /Users/ppfahd/Workspace/projects/tennis-live-edge. The command must obey preflight and create paper orders only through the backend; never request real execution." \
  --timeout-seconds 60
```

Weekly learning/readiness review, strong model route:

```bash
hermes cron add \
  --name tennis-edge-weekly-learning-review \
  --cron "0 20 * * 0" \
  --tz America/Sao_Paulo \
  --model gpt-5.5 \
  --message "Use the tennis-edge-ops skill and local API reports to prepare a weekly ROI/CLV/calibration/readiness review. Do not enable real execution." \
  --timeout-seconds 180
```
