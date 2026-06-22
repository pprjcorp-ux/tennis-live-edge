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
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:safe-loop from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report status, runtime, active_phase, quota_plan, next_best_command, safe_commands, budget_chain, and safety. Do not execute recommended commands, create orders, run provider smoke, or spend provider quota from this cron." \
  --timeout-seconds 90
```

Autonomy brief every 5 minutes when Hermes needs the highest-level safe
autonomy decision:

```bash
hermes cron add \
  --name tennis-edge-autonomy-brief \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:autonomy-brief from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report recommended_lane, autonomy_matrix, action_queue, safe_jailbreak_paths, forbidden_actions, and safety. Do not execute action_queue commands, create orders, run provider smoke, spend provider quota, or submit real orders from this cron." \
  --timeout-seconds 90
```

Source discovery every 15 minutes during collection buildout:

```bash
hermes cron add \
  --name tennis-edge-source-discovery \
  --every 15m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:source-discovery from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report discovery_scope, acquisition_matrix, provider_routes, next_safe_command, safe_jailbreak_policy, and forbidden_actions. Do not execute next_safe_command, scrape sites, create orders, run provider smoke, spend provider quota, or submit real orders from this cron." \
  --timeout-seconds 90
```

Trigger policy every 5 minutes for wakeup routing:

```bash
hermes cron add \
  --name tennis-edge-trigger-policy \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:trigger-policy from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report next_wakeup, triggers, debounce_policy, source_discovery, forbidden_actions, and safety. Do not execute trigger commands, create orders, run provider smoke, spend provider quota, or submit real orders from this cron." \
  --timeout-seconds 90
```

Ops compiler every 5 minutes for external agent channels:

```bash
hermes cron add \
  --name tennis-edge-ops-compiler \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:ops-compiler from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report compiled_action, execution_graph, model_router, operator_packet, source_discovery, trigger_policy, and safety. Do not execute compiled_action or graph commands, create orders, run provider smoke, spend provider quota, or submit real orders from this cron." \
  --timeout-seconds 90
```

Capability audit every 15 minutes to prove current autonomy limits:

```bash
hermes cron add \
  --name tennis-edge-capability-audit \
  --every 15m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:capability-audit from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report status, overall_score, autonomy_ceiling, next_safe_command, capabilities, blocked_routes, and safety. Do not execute next_safe_command, create orders, spend provider quota, or submit real orders from this cron." \
  --timeout-seconds 90
```

Autonomy gates every 5 minutes to prove the current escalation ceiling:

```bash
hermes cron add \
  --name tennis-edge-autonomy-gates \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:autonomy-gates from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report status, active_ceiling, next_required_gate, gates, capability_audit, and safety. Do not execute gate commands, create paper orders, spend provider quota, or submit real orders from this cron." \
  --timeout-seconds 90
```

Experiment lab every 15 minutes to rank safe research/test paths:

```bash
hermes cron add \
  --name tennis-edge-experiment-lab \
  --every 15m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:experiment-lab from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report research_question, active_ceiling, next_experiment, experiments, success_metrics, and safety. Do not execute experiment commands, create paper orders, spend provider quota, or submit real orders from this cron." \
  --timeout-seconds 90
```

Experiment ledger every 15 minutes to persist the recommendation locally:

```bash
hermes cron add \
  --name tennis-edge-experiment-ledger \
  --every 15m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:experiment-ledger from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report status, ledger path, active_ceiling_id, next_experiment_id, ready_experiment_ids, and safety. Do not execute experiment commands, create paper orders, spend provider quota, or submit real orders from this cron." \
  --timeout-seconds 90
```

Experiment ledger quality report hourly:

```bash
hermes cron add \
  --name tennis-edge-experiment-ledger-report \
  --every 1h \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:experiment-ledger-report from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report total_records, top_experiment, active_ceiling_counts, ready_experiment_counts, action_executed_count, and experiment_command_executed_count. Do not execute any reported command." \
  --timeout-seconds 60
```

Backlog plan hourly to turn local evidence into implementation priorities:

```bash
hermes cron add \
  --name tennis-edge-backlog-plan \
  --every 1h \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:backlog-plan from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report next_item, items, target_files, validation_commands, acceptance_evidence, and safety. Do not execute validation commands, edit files, create orders, spend provider quota, or submit real orders from this cron." \
  --timeout-seconds 60
```

Compact operator packet every 5 minutes for Telegram/OpenClaw:

```bash
hermes cron add \
  --name tennis-edge-operator-packet \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:operator-packet from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report priority, headline, short_message, next_action, cost_guard, and safety. Do not execute next_action, create orders, run provider smoke, or spend provider quota from this cron." \
  --timeout-seconds 90
```

Local operator ledger every 5 minutes:

```bash
hermes cron add \
  --name tennis-edge-operator-ledger \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:operator-ledger from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report status, priority, ledger path, next_action_command, and safety. Do not execute the recorded next action, create orders, run provider smoke, or spend provider quota from this cron." \
  --timeout-seconds 90
```

Operator ledger quality report hourly:

```bash
hermes cron add \
  --name tennis-edge-operator-ledger-report \
  --every 1h \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:operator-ledger-report from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report total_records, priority_counts, status_counts, outcome_counts, next_action_counts, top_blocker, and action_executed_count. Do not execute any reported command." \
  --timeout-seconds 60
```

Runtime fix priorities hourly:

```bash
hermes cron add \
  --name tennis-edge-runtime-fix-priorities \
  --every 1h \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:runtime-fix-priorities from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report next_priority, priorities, ledger_report.top_blocker, and safety. Do not execute diagnostic_command or source_command." \
  --timeout-seconds 60
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

Final non-mutating activation checklist:

```bash
npm --silent run hermes:activation-checklist
```

Only when `activation_allowed=true`, review the returned
`manual_activation_commands` and create jobs manually from a local operator
shell. The checklist itself does not call `hermes cron add`.

If activation is blocked, run the read-only fix planner manually:

```bash
npm --silent run hermes:runtime-fix-plan
```

Do not schedule `runtime-fix-plan`. It is an operator diagnostic packet only and
must not create jobs, write manifests, run repairs, spend provider quota, or
create paper orders.

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

Live window go/no-go every 1-5 minutes during active windows:

```bash
hermes cron add \
  --name tennis-edge-live-window \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:live-window from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report status, window_open, gates, blockers, next_action, sampling_policy, and safety. Do not execute next_action, create orders, run provider smoke, or spend provider quota from this cron." \
  --timeout-seconds 60
```

Match pulse watchlist every 1-5 minutes during active windows:

```bash
hermes cron add \
  --name tennis-edge-match-pulse \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:match-pulse from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report status, live_window_status, top_match, watchlist attention counts, blockers, and safety. Do not execute next_action, create orders, run provider smoke, or spend provider quota from this cron." \
  --timeout-seconds 60
```

Collection cadence plan every 1-5 minutes during active windows:

```bash
hermes cron add \
  --name tennis-edge-collection-plan \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:collection-plan from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report status, targets, safe_commands, provider_commands, blockers, and safety. Do not execute provider_commands, create orders, run provider smoke, or spend provider quota from this cron." \
  --timeout-seconds 60
```

Quota-aware cadence guard every 1-5 minutes during active windows:

```bash
hermes cron add \
  --name tennis-edge-quota-plan \
  --every 5m \
  --model gpt-5.4-mini \
  --message "Use the tennis-edge-ops skill. Run npm --silent run hermes:quota-plan from /Users/ppfahd/Workspace/projects/tennis-live-edge. Report status, throttle, effective_targets, safe_commands, provider_commands, and safety. Do not execute provider_commands, create orders, run provider smoke, or spend provider quota from this cron." \
  --timeout-seconds 60
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
