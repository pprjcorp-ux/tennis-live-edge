# Tennis Live Edge - Agent Handoff

## Canonical Branches

- `budget`: default public branch, ATP main-tour plus men's/women's Grand Slam
  singles profile, approximately `$500/mo` vendor target, enterprise feeds
  disabled.
- `enterprise`: full enterprise profile, ROI/CLV paper trading, Betfair
  architecture hard-blocked by default, Hermes Autopilot, private runtime docs.

Do not create more long-lived product branches without explicit request. Older
`codex/*` branches are archive-only after consolidation.

## Working Directory

Use `/Users/ppfahd/Workspace/projects/tennis-live-edge` as the project root.
The user home directory is a broader macOS workspace and git root; keep edits
scoped to this repo.

Do not commit `.env`, `.logs/`, `.venv/`, `.next/`, `node_modules/`,
`.DS_Store`, secrets, or machine-specific files.

## Architecture

- `services/api`: FastAPI backend, provider adapters, feature/model/signal
  engines, replay/backtest, execution gates, and Agent Ops.
- `apps/web`: Next.js dashboard.
- `infra/schema.sql`: Postgres/Timescale event-sourced schema.
- `infra/cloudflare`: Cloudflare Tunnel/Access docs.
- `hermes`: local-only Hermes skill/config examples.
- `docs`: shared architecture plus branch-specific operating docs.
- `docs/strategic-refactor-plan.md`: current product objective, best v2
  direction, refactor order, and Hermes/Cloudflare/provider strategy.
- `docs/hermes-operating-model.md`: safe Hermes autonomy ladder, collection
  boundaries, and cron/event structure.

## Runtime Defaults

Enterprise branch:

- `TENNIS_EDGE_RUNTIME_PROFILE=enterprise_roi_clv`
- `TENNIS_EDGE_MONTHLY_BUDGET_USD=6000`
- `TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men,grand_slam_women`
- `EXECUTION_ENABLED=false`
- `EXECUTION_STAGE=paper`
- `REAL_EXECUTION_HARD_BLOCK=true`
- `HERMES_CRITICAL_MODEL=gpt-5.5`

Budget branch:

- `TENNIS_EDGE_RUNTIME_PROFILE=lean_atp`
- `TENNIS_EDGE_MONTHLY_BUDGET_USD=500`
- `TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men,grand_slam_women`
- `TENNIS_EDGE_PERSISTENCE_ENABLED=true`
- `ENTERPRISE_FEEDS_ENABLED=false`
- `EXECUTION_ENABLED=false`
- `REAL_EXECUTION_HARD_BLOCK=true`

Live paper entries require durable operational truth: in `TENNIS_EDGE_DATA_MODE=live`,
`DATABASE_URL` must be configured and Postgres/Timescale must be healthy before
`can_generate_entries=true`.

Provider mode must stay explicit: the dashboard reads
`/api/v1/dashboard/live-state -> operational_state.provider_mode_matrix` to show
`sample`, `replay`, `live_without_keys`, and `live_with_keys` with entry gates,
evidence, blockers, and next action. Do not collapse this back to a single
label-only UI.

Model Lab must stay dataset-first: live backtests and calibration reports use
persisted `training_examples` for the active `model_version` and `feature_set`.
The dashboard reads this from
`/api/v1/dashboard/live-state -> operational_state.model_lab`; do not replace it
with paper-order memory or synthetic sample metrics in live mode.

Replay Lab is the provider rehearsal surface. Keep
`/api/v1/dashboard/live-state -> operational_state.replay_lab` green before
adding or debugging paid APIs. It must expose `budget_replay_fixtures`, fake
API-Tennis/Odds-API.io/TheOddsAPI contracts, and healthy/gap/resync scenarios
without live keys or vendor quota.
Live mode must not fall back to sample payloads implicitly; use
`/api/v1/replay/run` with `use_fixture_seed=true` only for explicit admin
rehearsal runs. Use `POST /api/v1/replay/contracts/run` before adding or
debugging paid provider keys; it runs healthy, gap, and `resync_required`
fixture scenarios and must pass without consuming live quota.
The dashboard must also surface
`operational_state.replay_lab.last_contract_persistence` so each scenario shows
persisted raw payload, score tick, odds tick, provider latency, and cursor
evidence after restart. Keep `provider_cursors_replayed` separate from
`cursors_saved`: fixture replays may validate cursor contracts while preserving
an existing live cursor instead of overwriting it.

## API Onboarding

Add external APIs only after the core remains green without live keys. The
runtime exposes the current sequence through
`/api/v1/dashboard/live-state -> operational_state.api_onboarding`:

1. Budget replay fixtures as the fake API layer for provider contracts.
2. TheOddsAPI REST/archive and comparison.
3. API-Tennis fixtures/livescore.
4. Odds-API.io websocket live odds after cursor/replay/resync gates.
5. Sportradar/Betradar/TXODDS enterprise feeds only after budget paper evidence.

If a provider fails, quota ends, odds are stale, moneyline is incomplete, or a
cursor requires resync, keep the dashboard alive and abstain instead of forcing
`Entrada`.

## Safety Rules

- The system can abstain; no forced picks.
- No real-money execution is enabled by default in any branch.
- No LLM, Hermes agent, Cloudflare Agent, browser automation, scraping, or
  geolocation workaround may place bets directly.
- Agents may only explain, monitor, review, or call internal APIs that enforce
  deterministic backend gates.
- Hermes cron/webhook/Telegram routing should consume `npm run hermes:events`;
  it may only create paper orders when that router reports
  `can_run_paper_autopilot=true` and the backend still approves the protected
  `hermes:autopilot` call.
- Hermes blocked-state routing should consume `npm run hermes:unblock-plan`;
  it is read-only and should classify local diagnostics, provider smoke,
  credential work, data quality, learning, and deferred enterprise lanes before
  any manual action.
- Hermes local runtime diagnostics should consume `npm run hermes:runtime-check`;
  it is read-only and must not install, restart, repair, create LaunchAgents, or
  alter credentials. It should expose `runtime_findings` and diagnostic actions
  such as a stopped gateway as non-executed manual review steps.
- Hermes channel readiness should consume `npm run hermes:channel-readiness`;
  it is independent of FastAPI and should prove the `channel_ready` ceiling
  with local runtime, Telegram allowlist, private Access allowlist, and admin
  token checks before any cron/Telegram activation.
- Hermes must defer enterprise-only cursor blockers while
  `enterprise_eligible=false`; Sportradar/Betradar/TXODDS placeholders should
  not block budget-chain work before enterprise activation.
- Hermes operator handoff should consume `npm run hermes:playbook`; it is a
  planner only and must not execute listed commands or bypass backend gates.
- Hermes high-frequency monitoring should consume `npm run hermes:live-stats`;
  it provides deterministic live collection/processing metrics and keeps
  `llm_per_tick_allowed=false`.
- Hermes live-window decisions should consume `npm run hermes:live-window`; it
  is a read-only go/no-go packet for live collection/paper readiness, must not
  execute commands, spend provider quota, create orders, or enable real
  execution, and should return `paper_ready`, `monitor`, `blocked`, or
  `safety_stop` with explicit gates.
- Hermes per-match live triage should consume `npm run hermes:match-pulse`; it
  is a read-only watchlist/ranking packet over `/api/v1/live/matches`, must not
  create paper orders itself, and should only point to protected backend paper
  autopilot when the global live-window gate is `paper_ready`.
- Hermes collection cadence planning should consume
  `npm run hermes:collection-plan`; it converts match-pulse priorities into
  desired score/odds polling lanes, but must remain read-only, must not execute
  provider ingestion, and must keep `provider_api_call_allowed=false`.
- Hermes quota/cost throttling should consume `npm run hermes:quota-plan`; it
  wraps collection-plan with budget utilization guards, may slow or freeze
  desired polling cadence, and must never execute provider commands.
- Hermes weekly learning/readiness review should consume
  `npm run hermes:learning-review`; it is read-only, routes interpretation to
  the critical model, and must keep real execution blocked.
- Hermes provider onboarding should consume `npm run hermes:budget-chain`; it
  is dry-run only and must not spend provider quota unless the operator
  intentionally runs the reported smoke command.
- Hermes provider smoke execution must go through `npm run hermes:provider-smoke`;
  without `--execute-provider-call` it is blocked dry-run only. Never place that
  flag in cron, Telegram, webhook, or autonomous LLM routes.
- Hermes autonomous loop routing should consume `npm run hermes:safe-loop`;
  it aggregates runtime, intelligence, event routing, playbook, live stats,
  quota-plan, budget-chain, and learning review packets, but must remain
  read-only and must never create paper orders, spend provider quota, or submit
  real orders itself.
- Hermes maximum-autonomy planning should consume `npm run hermes:autonomy-brief`;
  it is read-only, event-driven, no LLM per tick, and must treat "jailbreak" as
  allowed-path discovery only, never bypass or sportsbook automation.
- Hermes data-source discovery should consume `npm run hermes:source-discovery`;
  it maps score, odds, archive, public context, operator notes, and replay to
  allowed acquisition paths without live provider calls or scraping.
- Hermes source-route ranking should consume `npm run hermes:source-route-matrix`;
  it turns allowed paths into prioritized replay/internal/provider/manual routes
  with event triggers, cost tiers, success evidence, and explicit
  `provider_api_call_allowed=false`.
- Hermes wakeup policy should consume `npm run hermes:trigger-policy`; it maps
  runtime, events, source discovery, quota, and learning state into debounced
  triggers for cron/webhook/Telegram/dashboard/Cloudflare/OpenClaw without
  executing trigger commands.
- Hermes external-agent orchestration should consume `npm run hermes:ops-compiler`;
  it compiles trigger policy, source discovery, autonomy brief, operator packet,
  and model routing into one non-executing payload.
- Hermes objective/capability review should consume `npm run hermes:capability-audit`;
  it scores runtime, collection, statistics, paper autopilot, learning,
  orchestration, budget-chain, and enterprise-gate readiness without executing
  the reported next command.
- Hermes autonomy gate proof should consume `npm run hermes:autonomy-gates`;
  it turns capability audit, cron activation checks, event routing, and the
  budget chain into explicit pass/blocked/locked gates with `active_ceiling`
  and `next_required_gate`, while remaining read-only and unable to create
  paper orders itself.
- Hermes experiment lab should consume `npm run hermes:experiment-lab`; it
  ranks safe experiments for source discovery, live collection cadence, paper
  learning, and enterprise readiness with hypotheses and success metrics, but
  must not execute the experiment command, spend provider quota, or create
  paper orders itself.
- Hermes experiment decision auditing should consume
  `npm run hermes:experiment-ledger`; it may write only local JSONL rows under
  `hermes/runs/`, must record `action_executed=false` and
  `experiment_command_executed=false`, and must never execute the chosen
  experiment command.
- Hermes experiment quality review should consume
  `npm run hermes:experiment-ledger-report`; it is read-only and should
  summarize repeated experiment recommendations, active ceilings, and ready
  experiment counts without executing commands.
- Hermes backlog planning should consume `npm run hermes:backlog-plan`; it
  reads only local operator/experiment ledgers and converts repeated evidence
  into non-executing implementation priorities with target files, validation
  commands, and acceptance evidence.
- Hermes channel summaries should consume `npm run hermes:operator-packet`;
  it compresses safe-loop for Telegram/OpenClaw and must never execute the
  `next_action` it reports.
- Hermes operator decision auditing should consume `npm run hermes:operator-ledger`;
  it may write only local JSONL rows under `hermes/runs/` and must record
  `action_executed=false`.
- Hermes operator quality review should consume `npm run hermes:operator-ledger-report`;
  it is read-only and must never execute repeated next-action commands.
- Hermes runtime priority planning should consume `npm run hermes:runtime-fix-priorities`;
  it is read-only and must never execute `diagnostic_command` values.
- Hermes scheduler rehearsal should consume `npm run hermes:scheduler-rehearsal`;
  it may write only local JSONL audit rows under `hermes/runs/`, must not create
  real cron jobs, and must never execute the commands it schedules.
- Hermes cron proposal should consume `npm run hermes:cron-proposal`; it may
  write only a local review manifest under `hermes/runs/`, must not call
  `hermes cron add`, and must exclude provider-smoke, autopilot, admin-token,
  quota-consuming, or order-creating jobs.
- Hermes cron activation review should consume
  `npm run hermes:activation-checklist`; it must not create jobs, must not print
  secrets, and should expose manual activation commands only when runtime,
  Telegram allowlist, private access allowlist, local admin secret, safe cron
  manifest, and real-execution hard block all pass.
- Hermes runtime fix planning should consume `npm run hermes:runtime-fix-plan`;
  it must remain read-only, must not write manifests, run repair/restart/install
  commands, create jobs, spend provider quota, or create orders, and should
  expose only ordered manual/local diagnostic actions from failed activation
  checks.
- Real execution requires a separate compliance/account/API activation task.

## Verification

Run from the repo root:

```bash
docker compose up -d
docker compose exec -T postgres psql -U tennis -d tennis_edge < infra/schema.sql
npm run api:test
npm run api:ingest
printf '{"event_id":"smoke-event","seq":1,"timestamp":"2026-06-07T20:00:00Z","data":{"bookmaker":"SmokeBook","market":"h2h","selections":[{"player_id":"p1","odds":1.8},{"player_id":"p2","odds":2.1}]}}' | TENNIS_EDGE_DATA_MODE=sample TENNIS_EDGE_PERSISTENCE_ENABLED=false npm run api:ingest:odds-message
npm --prefix apps/web run build
python3 scripts/check_private_runtime.py
npm run api:check:operational-truth -- --pretty
npm run hermes:events
npm run hermes:playbook
npm run hermes:live-stats
npm run hermes:live-window
npm run hermes:match-pulse
npm run hermes:collection-plan
npm run hermes:quota-plan
npm run hermes:budget-chain
npm run hermes:safe-loop
npm run hermes:channel-readiness
npm run hermes:autonomy-brief
npm run hermes:source-discovery
npm run hermes:source-route-matrix
npm run hermes:trigger-policy
npm run hermes:ops-compiler
npm run hermes:capability-audit
npm run hermes:autonomy-gates
npm run hermes:experiment-lab
npm run hermes:experiment-ledger
npm run hermes:experiment-ledger-report
npm run hermes:backlog-plan
npm run hermes:scheduler-rehearsal
npm run hermes:cron-proposal
npm run hermes:activation-checklist
npm run hermes:runtime-fix-plan
```

`api:check:operational-truth` is the required integrated smoke before API
onboarding work: it validates local Postgres schema, fake-provider replay
contracts, dashboard persisted source summary, fail-closed replay signals,
execution hard block, and rehearsal-only `training_examples` without spending
provider quota.

When the local API is running:

```bash
npm run hermes:briefing
curl -s http://localhost:8000/api/v1/execution/status
curl -s http://localhost:8000/api/v1/cost-profile
```
