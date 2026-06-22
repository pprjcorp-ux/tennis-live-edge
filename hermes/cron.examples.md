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

Safe-loop packet every 5 minutes when Hermes needs one complete autonomous
decision packet:

```bash
hermes cron add \
  --name tennis-edge-safe-loop \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:safe-loop from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report status, runtime, active_phase, next_best_command, safe_commands, budget_chain, and safety. Do not execute recommended commands, create orders, run provider smoke, or spend provider quota from this cron." \
  --timeout-seconds 90
```

Scheduler rehearsal before creating or changing real cron jobs:

```bash
npm --silent run hermes:scheduler-rehearsal
```

This writes only a local JSONL audit row under `hermes/runs/`. It does not call
`hermes cron add`, execute recommended commands, create orders, run provider
smoke, or spend provider quota.

Reviewable cron proposal manifest:

```bash
npm --silent run hermes:cron-proposal
```

This writes `hermes/runs/cron-proposal.json` with exact command previews for
safe read-only jobs. It does not create jobs and excludes autopilot,
provider-smoke, admin-token, quota-consuming, and order-creating routes.

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

Live stats every minute during active windows:

```bash
hermes cron add \
  --name tennis-edge-live-stats \
  --every 1m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:live-stats from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report health_scores, freshness, sampling_policy, budget_chain, and safety only. Do not run LLM analysis per tick and do not create orders from this cron." \
  --timeout-seconds 45
```

Budget-chain dry-run every 15 minutes during onboarding:

```bash
hermes cron add \
  --name tennis-edge-budget-chain \
  --every 15m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:budget-chain from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report current_step, blockers, smoke_command, and provider_api_call_allowed. Do not execute the smoke command from this cron." \
  --timeout-seconds 45
```

Do not schedule `npm run hermes:provider-smoke -- --execute-provider-call`.
Provider smoke execution may spend quota and is reserved for a local operator
shell after reviewing the dry-run `hermes:budget-chain` packet.

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
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:learning-review from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report review_status, metrics, gates, blockers, and next_actions. Do not enable real execution." \
  --timeout-seconds 180
```
