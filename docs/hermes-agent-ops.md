# Hermes Autopilot

Hermes is a local operations orchestrator for Tennis Live Edge. It monitors
the backend, creates paper orders only when the backend has already emitted a
valid `Entrada` signal, and summarizes anomalies/results.

## Local Commands

```bash
npm run api:ingest:live-budget
node hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs ingest-live-budget
npm run api:ingest
printf '{"event_id":"smoke-event","seq":1,"timestamp":"2026-06-07T20:00:00Z","data":{"bookmaker":"SmokeBook","market":"h2h","selections":[{"player_id":"p1","odds":1.8},{"player_id":"p2","odds":2.1}]}}' | TENNIS_EDGE_DATA_MODE=sample TENNIS_EDGE_PERSISTENCE_ENABLED=false npm run api:ingest:odds-message
npm run api:ingest:odds-stream -- --max-messages 25 --timeout-seconds 30
npm run api:ops:daily
npm run hermes:briefing
npm run hermes:anomalies
npm run hermes:runs
npm run hermes:preflight
npm run hermes:runtime-check
npm run hermes:doctor-triage
npm run hermes:channel-readiness
npm run hermes:channel-recovery-plan
npm run hermes:backend-readiness
npm run hermes:backend-latency-triage
npm run hermes:mission-control
npm run hermes:mission-ledger
npm run hermes:mission-ledger-report
npm run hermes:intelligence
npm run hermes:events
npm run hermes:unblock-plan
npm run hermes:playbook
npm run hermes:live-stats
npm run hermes:live-window
npm run hermes:match-pulse
npm run hermes:grand-slam-mission
npm run hermes:grand-slam-mission-ledger
npm run hermes:grand-slam-mission-ledger-report
npm run hermes:collection-plan
npm run hermes:quota-plan
npm run hermes:learning-review
npm run hermes:budget-chain
npm run hermes:provider-smoke
npm run hermes:safe-loop
npm run hermes:autonomy-brief
npm run hermes:source-discovery
npm run hermes:source-route-matrix
npm run hermes:source-route-ledger
npm run hermes:source-route-ledger-report
npm run hermes:replay-backfill-contract
npm run hermes:source-use-manifest
npm run hermes:source-use-ledger
npm run hermes:source-use-ledger-report
npm run hermes:historical-backfill-plan
npm run hermes:trigger-policy
npm run hermes:ops-compiler
npm run hermes:capability-audit
npm run hermes:autonomy-gates
npm run hermes:experiment-lab
npm run hermes:experiment-ledger
npm run hermes:experiment-ledger-report
npm run hermes:backlog-plan
npm run hermes:autonomy-effectiveness
npm run hermes:implementation-handoff
npm run hermes:operator-packet
npm run hermes:operator-ledger
npm run hermes:operator-ledger-report
npm run hermes:runtime-fix-priorities
npm run hermes:scheduler-rehearsal
npm run hermes:cron-proposal
npm run hermes:activation-checklist
npm run hermes:runtime-fix-plan
ADMIN_API_TOKEN=... npm run hermes:ops:daily
ADMIN_API_TOKEN=... npm run hermes:autopilot
```

For machine-readable JSON without npm's banner, call
`npm --silent run hermes:intelligence` or the direct `node
hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs intelligence`
entrypoint.

The skill lives in `hermes/skills/tennis-edge-ops`. Copy it into
`~/.hermes/skills/tennis-edge-ops` for the Hermes runtime to discover it.

## Operator Channel Secret Gate

`hermes:implementation-handoff` can choose
`configure_hermes_operator_channel_secrets` when the runtime is healthy but the
operator channel still cannot progress beyond `observe`. Treat that as a local
secret/allowlist setup task, not as a provider, model, execution, or runtime
repair task.

The accepted local-only variables are:

```bash
HERMES_TELEGRAM_ALLOWED_USER_IDS=123456789
OPENCLAW_TELEGRAM_ALLOWED_USER_IDS=123456789
PRIVATE_ALLOWED_EMAILS=operator@example.com
TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS=operator@example.com
ADMIN_API_TOKEN=replace-with-random-32-byte-token
TENNIS_EDGE_ADMIN_API_TOKEN=replace-with-random-32-byte-token
```

Use only one variable from each pair if preferred:
`HERMES_TELEGRAM_ALLOWED_USER_IDS` or `OPENCLAW_TELEGRAM_ALLOWED_USER_IDS`,
`PRIVATE_ALLOWED_EMAILS` or `TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS`, and
`ADMIN_API_TOKEN` or `TENNIS_EDGE_ADMIN_API_TOKEN`. Values belong in `.env` or
the local shell only. Do not commit them, print them, or paste them into
operator summaries.

Verification is read-only:

```bash
npm --silent run hermes:channel-readiness
npm --silent run hermes:activation-checklist
npm --silent run hermes:implementation-handoff
```

The channel gate is proven only when `doctor_passed=pass`,
`telegram_allowlist_configured=pass`, `private_access_allowlist_configured=pass`,
`local_admin_secret_available=pass`, `secret_value_printed=false`, and
`configure_hermes_operator_channel_secrets` is no longer the handoff work order.

For scheduled budget operation, prefer `api:ingest:live-budget`. It runs the
API-Tennis snapshot and the Odds-API.io websocket consumer in one process, then
prints a single JSON summary with safety state.
Hermes can call the same cycle through the `ingest-live-budget` skill command
when you want all operations routed through `tennis_edge_ops.mjs`.
Each score snapshot, odds stream, and live-budget cycle is journaled in
`ingestion_runs` when persistence is enabled; read recent rows with
`GET /api/v1/ingestion/runs`.

Before live provider keys are configured, use `api:ops:daily`,
`hermes:ops:daily`, or protected `POST /api/v1/ops/daily` for the daily
paper-first rehearsal. It runs replay contracts, paper auto-settlement, and the
Model Lab `training_examples` backtest path while reporting `live_api_calls=0`.
The auto-settlement response includes structured per-order `decisions`, so
Hermes can summarize settled, skipped, failed, and training-example-missing
outcomes without parsing free-form reason strings.

Use `hermes:runtime-check` when `unblock-plan` prioritizes the local runtime
lane. It captures `hermes status` and `hermes doctor` output in JSON but does
not modify LaunchAgents, daemons, gateway state, or credentials. It also emits
`capability_summary` and `autonomy_impact` so a running gateway, configured
model/provider or configured channel can still be used for read-only summaries
and ledgers while doctor timeout blocks cron, channel escalation and paper
autopilot.
When that happens, the safe-loop status becomes `runtime_partial` and downstream
operator packets include `read_only_runtime_route`. That route is a summary path
only; it never enables provider calls, paper orders, channel activation, or real
execution.

Use `hermes:doctor-triage` when runtime diagnostics report `doctor_timed_out`.
It runs bounded local probes for version/status/doctor, classifies the likely
cause, redacts output previews, and emits only non-executed manual actions.

Use `hermes:channel-readiness` to prove the channel gate before cron/Telegram
activation. It is independent of FastAPI and checks only local runtime/channel
prerequisites: Hermes CLI, gateway running state, bounded doctor pass, Telegram
allowlist, private Access allowlist, and local admin token presence. It emits
ordered manual actions and acceptance evidence while keeping
`executes_now=false`.

Use `hermes:channel-recovery-plan` when channel readiness is blocked. It
summarizes failed gates, local env names, configured counts, verification
commands, `secret_value_printed=false`, and human-only steps without printing
secret values or mutating the runtime. It also emits
`operator_channel_bootstrap`, a read-only `.env` template packet with aliases,
acceptance evidence, verification commands and
`automated_env_write_allowed=false`, so external agents can guide local setup
without writing `.env` or printing secret values.

Use `hermes:backend-readiness` to prove the FastAPI side before relying on
live-window, match-pulse, source-route or paper-autopilot packets. It checks
preflight, dashboard live-state, live matches, provider health, cost profile and
execution status with bounded internal GETs, then fails closed into manual
actions if the backend is unavailable.

Use `hermes:backend-latency-triage` when backend readiness shows partial
timeouts. It measures each local endpoint with bounded GETs, emits only compact
shape summaries, and avoids provider calls, service starts, orders, and payload
body printing.

Use `hermes:mission-control` as the preferred one-packet entrypoint for Hermes,
Telegram, dashboard, Cloudflare Agent or any external orchestrator. It merges
backend readiness, channel readiness, source-route matrix and live-window into
ordered lanes and one `next_action`, while every lane remains non-executing and
real execution stays blocked.

Use `hermes:mission-ledger` when mission-control decisions should become
durable local evidence. It appends one JSONL row with the full mission packet,
the active ceiling, blocked lanes, next action, `outcome=observed`,
`action_executed=false` and `mission_command_executed=false`.

Use `hermes:mission-ledger-report` to review repeated mission blockers. It
reads the local ledger and reports repeated next actions, blocked lanes, active
ceilings and any rows that claim a mission command was executed.

For higher autonomy, use `hermes:intelligence` as the default scheduled packet.
It reads internal APIs only and emits one machine-readable recommendation:
`investigate`, `budget_chain_buildout`, `paper_autopilot_candidate`,
`collect_learning_data`, `replay_lab_hardening`, or `steady_state_monitoring`.
This gives Hermes enough state to choose between monitoring, safe paper
autopilot, replay hardening, provider onboarding, and weekly learning review
without scraping or bypassing external systems.
All internal FastAPI reads are timeout bounded with `HERMES_HTTP_TIMEOUT_MS`
(default 5000ms, clamped from 100ms to 30000ms). If the backend hangs, composed
Hermes packets fail closed into `backend_api` blockers while keeping provider
calls, paper orders, real execution, and LLM-per-tick decisions disabled.
Deferred enterprise cursors are separated into `deferred_enterprise_cursors`
until the budget chain is complete and enterprise is eligible, preventing
Sportradar/Betradar/TXODDS placeholders from blocking lean budget work.

Use `hermes:events` when Hermes cron, webhook, Telegram, or the dashboard needs
an action router instead of a broad status packet. It converts the intelligence
state into deterministic events with one allowed command, whether an admin token
is required, whether paper orders can be created, and
`can_submit_real_orders=false`. It blocks paper autopilot when preflight,
provider health, cursor resync, data quality, budget-chain, or real-execution
safety blockers exist.

Use `hermes:unblock-plan` when the operator needs the fastest safe path from
blocked state to budget-chain progress. It classifies blockers into read-only
local diagnostics, explicit provider smoke, credential work, replay/data quality
checks, learning collection, and deferred enterprise items.

Use `hermes:playbook` when the operator or a Hermes channel needs a phase plan.
It does not execute commands. It groups the current state into observe,
stabilize-data, budget-chain, collect-learning, paper-autopilot, and
learning-review steps, with write/live-call flags and hard real-execution
denials on every step.

Use `hermes:live-stats` for high-frequency live operations summaries. It emits
deterministic collection, processing, signal, freshness, cost, learning, and
sampling-policy metrics from internal APIs only. This is the preferred packet
for fast monitoring because it avoids per-tick LLM analysis. The packet also
contains `feature_contract.id=live_stats_feature_contract`, which converts
internal live state into `LiveFeatureSnapshotSeed`, `CollectionCadenceSeed`,
`SignalGateContextSeed`, and `LearningReviewSeed` outputs while keeping
`internal_api_only=true`, `provider_api_call_allowed=false`,
`browser_scraping_allowed=false`, and `llm_per_tick_allowed=false`.

Use `hermes:live-window` when Hermes, Telegram, or the dashboard needs one
go/no-go answer for the current live window. It combines event severity,
provider mode, score/odds freshness, signal readiness, budget-chain completion,
and execution safety into `paper_ready`, `monitor`, `blocked`, or
`safety_stop`. It never executes the returned `next_action`.

Use `hermes:match-pulse` when Hermes needs per-match attention routing instead
of a global status. It reads current matches and produces a priority watchlist
using freshness, pressure state, edge, signal status, and the global
live-window gate. It may recommend protected paper autopilot only when that
global gate is `paper_ready`, and it never creates orders itself.

Use `hermes:collection-plan` when Hermes needs to translate the watchlist into
collection cadence. It reports desired score/odds polling lanes and source
preferences, but remains read-only: provider ingestion is only an operator
candidate with `executes_now=false` and `provider_api_call_allowed=false`.

Use `hermes:quota-plan` when Hermes needs budget-aware throttling. It wraps the
collection plan with monthly spend utilization, slows cadence near guardrails,
freezes when blocked/exhausted, and never executes provider commands.

Use `hermes:learning-review` for weekly ROI/CLV/calibration/readiness review.
It is read-only, recommends the `gpt-5.5` route for interpretation, and keeps
`real_execution_recommendation=keep_blocked` until a separate compliance task.

Use `hermes:budget-chain` before running any paid provider smoke. It reports
the active onboarding step and the exact command to run, while keeping
`provider_api_call_allowed=false` and requiring explicit operator
confirmation before quota-consuming API calls.

Use `hermes:provider-smoke` only as the local confirmation gate. The default
run is blocked dry-run output. Adding `--execute-provider-call` may spend
provider quota, so that flag must remain out of cron, Telegram, webhooks, and
LLM-triggered automation.

Use `hermes:safe-loop` as the default autonomous packet when Hermes needs the
widest safe context in one call. It aggregates runtime diagnostics,
intelligence, event routing, unblock lanes, playbook phases, live stats,
quota-plan throttle state, budget-chain state, and learning review into one
read-only decision. It does not create paper orders, execute provider smoke,
spend quota, or submit real orders.

Use `hermes:autonomy-brief` when deciding how far Hermes can safely go next.
It turns safe-loop state, live-window gates, quota throttles and ledger
priorities into an autonomy matrix and action queue. It is the recommended
packet for "jailbreak" requests because it explicitly lists allowed collection
paths and forbidden bypasses while keeping every action non-executing.
When runtime is partial, it recommends `partial_runtime_read_only`, keeps
`doctor-triage` or the runtime diagnostic as the first action, and adds the
operator-packet route as a summary-only action.

Use `hermes:source-discovery` when Hermes needs to improve collection coverage
without spending quota or scraping. It maps score state, live odds, archive
odds, closing-line proxy, live statistics, public context, operator notes and
replay backfill to allowed acquisition paths and blocked routes.

Use `hermes:source-route-matrix` when Hermes needs to decide which allowed
path should feed live stats next. It ranks replay, internal API, licensed
provider and manual-note routes by priority, trigger, cost tier, success
evidence and blocked conditions. Provider routes remain operator-only and
`provider_api_call_allowed=false`.

Use `hermes:source-route-ledger` when repeated route decisions should become
durable local evidence. It appends the current matrix to JSONL with
`route_command_executed=false`, `provider_command_executed=false`, and
`bypass_attempted=false`. Use `hermes:source-route-ledger-report` to summarize
repeated allowed routes before adding importers or spending provider quota.
`backlog-plan`, `experiment-lab`, and `autonomy-effectiveness` consume this
report so source-route pressure becomes reviewed implementation work, not an
automatic provider call.
The backlog item is `harden_source_route_feedback_loop`, the experiment row is
`source_route_feedback_loop`, and autonomy evidence exposes
`source_route_records` plus the `source_routes` effectiveness lane.
When `implementation-handoff` receives this backlog item, it must map the top
route to replay/internal or licensed adapter contracts without executing it,
keep browser scraping/sportsbook automation/bypass routes blocked, and prove
route/provider/bypass counters remain zero.
Required step ids: `review_source_route_ledger_report_for_top_route_blocked_routes_and_operator_required_routes`,
`map_the_top_route_to_internal_replay_or_licensed_adapter_contract_without_executing_it`,
and `prove_route_provider_and_bypass_counters_remain_zero`.
Use `hermes:replay-backfill-contract` when the top route is `replay_backfill`.
It emits the offline `replay_backfill_to_operational_truth` contract with
persisted match/score/odds/signal/paper-order inputs, `ReplayBackfillEvidence`,
replay lab gates,
implementation steps and validation commands. It stays read-only and cannot run
provider APIs, browser scraping, sportsbook automation, bypasses or orders.
The command reads `/api/v1/replay/backfill-evidence` when available and treats
that backend read-model as canonical proof for `closing_line_proxy_seed_ready`,
`paper_learning_seed_ready` and `signal_gate_regression_ready`.
Model Lab also exposes `replay_backfill_seed_status`,
`replay_backfill_seed_count`, `can_use_replay_backfill_for_rehearsal` and
`can_promote_model_from_replay_seeds`. Hermes may use those values in
learning-review and implementation packets, but a ready replay seed is
`replay_backfill_seeds_rehearsal_only` until production `training_examples`
unlock `can_run_live_backtest`.

Use `hermes:source-use-manifest` before adding collection/import code or asking
Hermes to "jailbreak" a source gap. It audits collection routes, historical
sources and enterprise shadow providers into allowed/deferred/operator-required
rows with license/attribution gates, quota permissions, required evidence and
forbidden actions. It is read-only and cannot fetch datasets, call providers,
scrape, bypass, create paper orders or submit real orders.
`hermes:ops-compiler` embeds this packet as `source_use_manifest` and adds a
`source_use_manifest` graph node, so channel/cron summaries preserve the source
contract before implementation handoff. `scheduler-rehearsal` schedules it as a
recurring read-only check, and `implementation-handoff` adds it to every
work-order validation command list.
Use `hermes:source-use-ledger` to append manifest decisions to local JSONL
without executing collection, provider or bypass commands. Use
`hermes:source-use-ledger-report` to summarize repeated license-review,
operator-required, deferred and forbidden source blockers before prioritizing
importer work.

Use `hermes:historical-backfill-plan` when Hermes needs more offline evidence
for priors, calibration or backtests. It ranks internal replay, public
historical datasets and licensed archive odds with license/attribution gates.
It must not fetch, scrape, import, spend quota, create orders or treat old data
as live state.

Use `hermes:enterprise-accuracy-plan` when working on the no-budget-limit
accuracy branch. It ranks the top-tier provider stack, access requirements,
model layers, Grand Slam scoreline forecast contract and enterprise
due-diligence matrix. The matrix turns provider research into RFP questions,
sample-payload requirements, proof artifacts and acceptance tests. It is a
planning packet only: no provider calls, scraping, quota spend, paper orders or
real execution.

Use `hermes:enterprise-readiness` when deciding whether the enterprise track is
ready for human contract/sample-payload review. It consumes
`operational_state.replay_lab.enterprise_shadow_providers`, budget-chain
evidence, replay status, safety state and learning readiness. It is visibility
only: no provider calls, scraping, quota spend, paper orders or real execution.
Its safe-jailbreak policy must keep
`provider_quota_spend_allowed_from_this_command=false`.

Use `hermes:grand-slam-mission` as the product-level packet for Grand Slam
match-day prediction. It compiles readiness, historical priors, collection,
quota, live-controller and learning state into mission phases. It never creates
paper orders itself and cannot spend provider quota or submit real orders.

Use `hermes:grand-slam-mission-ledger` when Grand Slam mission decisions should
become local evidence. It appends a compact JSONL row with active phase,
Grand Slam readiness, next safe command, live-controller status, quota level and
learning status while keeping all execution counters false.

Use `hermes:grand-slam-mission-ledger-report` to review repeated Grand Slam
mission blockers. It is read-only and feeds `hermes:backlog-plan` so repeated
visibility, model-input, prediction-watch or paper-learning phases become
implementation priorities without provider calls or paper orders.

Use `hermes:trigger-policy` when cron, Telegram, dashboard, Cloudflare Agent or
OpenClaw needs to know when Hermes should wake up. It emits debounced triggers
and commands, including Grand Slam readiness triggers, but never executes them,
keeping LLM calls away from every odds tick. Partial runtime produces separate
diagnostic and read-only summary triggers.

Use `hermes:ops-compiler` when an external agent channel needs one packet
instead of several commands. It compiles trigger policy, source discovery,
Grand Slam readiness, enterprise readiness, autonomy brief, operator packet and
model routing into a single non-executing orchestration payload.

Use `hermes:capability-audit` when deciding whether Hermes is actually ready
for more autonomy. It scores runtime, source discovery, live collection, live
statistics, protected paper autopilot, learning review, orchestration,
budget-chain and enterprise-gate readiness from backend evidence. It never runs
the next safe command it reports.

Use `hermes:autonomy-gates` as the proof packet before increasing autonomy. It
turns capability audit, cron activation checks, event routing, and budget-chain
state into ordered `observe`, `channel_ready`, `cron_ready`, `paper_ready`,
`learning_ready`, and `enterprise_review` gates. It reports `active_ceiling`
and `next_required_gate`, stays read-only, and cannot create paper orders.

Use `hermes:experiment-lab` when Hermes needs to decide which research/test
path creates the most value next. It ranks safe experiments for runtime
recovery, source discovery, live collection cadence, paper autopilot rehearsal,
learning review, and enterprise eligibility. Each experiment carries a
hypothesis, prerequisites, `success_metrics`, and a command preview, but the
lab never executes commands or creates paper orders.

Use `hermes:experiment-ledger` to preserve the lab recommendation as local
evidence. It appends one JSONL row with the lab payload, active ceiling,
ready experiment ids, next experiment id, and
`experiment_command_executed=false`. It never runs the recommended experiment.

Use `hermes:experiment-ledger-report` to review repeated research/test
recommendations. It reports top experiments, repeated active ceilings, ready
experiment counts, and any rows claiming an experiment command was executed.

Use `hermes:backlog-plan` to turn ledger evidence into implementation
priorities. It reads only local mission, operator, experiment, live-controller,
source-route and Grand Slam mission ledgers, then emits non-executing backlog items with target files, validation commands,
acceptance evidence, and the gates each item blocks.

Use `hermes:operator-packet` for Telegram/OpenClaw summaries. It compresses the
safe-loop into priority, headline, short message, next safe action, cost guard
read-only runtime route and safety flags while staying read-only.

Use `hermes:operator-ledger` when an operator-channel decision should be
audited locally. It appends one JSONL row with the packet, `outcome=observed`
and `action_executed=false`; it never executes the reported next action.

Use `hermes:operator-ledger-report` for operational quality review. It reads
the local ledger and reports repeated priorities, statuses, outcomes, throttle
states, next actions and any rows that claim an action was executed.

Use `hermes:runtime-fix-priorities` to convert repeated ledger blockers into a
ranked local remediation queue. It only reports diagnostic commands and never
executes them.

Use `hermes:scheduler-rehearsal` before creating or changing real Hermes cron
jobs. It converts the current safe-loop packet into proposed intervals and
appends a local JSONL row under `hermes/runs/`. It does not create, update, or
delete cron jobs and does not execute the commands in the schedule. It includes
an adaptive `hermes:grand-slam-readiness` lane that stays low-frequency outside
Grand Slam windows and tightens only when Slam rows/predictions are visible.

Use `hermes:cron-proposal` to generate a reviewable cron manifest. It writes
`hermes/runs/cron-proposal.json` with exact `hermes cron add` command previews
for safe read-only jobs only. It does not call `hermes cron add` and excludes
autopilot, provider-smoke, admin-token, quota-consuming, and order-creating
jobs. Grand Slam readiness proposals remain non-executing even when paper-ready
matches are present.

Use `hermes:activation-checklist` as the final non-mutating gate before any
manual cron creation. It checks Hermes runtime health, Telegram allowlist,
private-access email allowlist, local admin token presence, cron manifest
safety, no executed commands, and the real-execution hard block. Manual
activation commands are empty until every check passes.

Use `hermes:autonomy-effectiveness` before implementation handoff or autonomy
escalation. It reads only local ledgers, measures repeated blockers and
source-route pressure, flags protected-action claims, scores the current loop, and recommends a
non-executing next action. It is the proof that Hermes is learning from
operation rather than just producing more packets. The ops compiler,
implementation handoff and cron proposal now include this measurement so
repeated blockers become scheduled review evidence, not automatic actions.

Use `hermes:runtime-fix-plan` when activation is blocked and the operator needs
the next safest remediation step. It derives ordered actions from failed
activation gates without writing manifests, running repair/restart/install
commands, creating jobs, spending provider quota, creating paper orders, or
enabling real execution.
It also surfaces `runtime_findings` from `hermes:runtime-check` as non-executed
diagnostic actions, so a stopped gateway or bounded doctor timeout becomes an
explicit manual review step instead of a vague runtime failure.
Runtime capability summaries are advisory only: they can justify read-only
operator packets, but never override doctor, allowlist, admin-token, provider
quota or real-execution gates.

## Audit Trail

`/api/v1/agent/runs` reads persisted `agent_runs` when Postgres is enabled and
falls back to in-memory runs only in sample/dev mode. Each run stores:

- source (`dashboard`, `telegram`, `cron`, `hermes`, or `system`);
- model routes and estimated cost;
- actions taken, skipped, blocked, or failed;
- paper orders created through backend gates.

Critical-route runs are shown first in the audit view so severe anomaly or
real-execution-readiness reviews are not buried by routine polling.

Odds-API.io websocket smoke/replay can use
`POST /api/v1/ingestion/odds-api-io/message` or the
`api:ingest:odds-message` stdin wrapper. That path persists the raw provider
payload, updates the provider cursor, records latency, attempts deterministic
`odds_ticks` normalization for already-resolved matches/players, and reports
whether `resync_required` should block signals.

After a trusted REST snapshot is applied, the protected
`POST /api/v1/ingestion/provider-cursors/resync` endpoint records the provider,
stream, and last trusted sequence. Use it to clear websocket gaps only after the
snapshot is actually reconciled.

`api:ingest:odds-stream` opens the live Odds-API.io websocket only when
`ODDS_API_IO_KEY` is configured and the persisted cursor does not require
resync. It uses the same persistent message-ingestion path for each websocket
payload.

## Preflight

Run `npm run hermes:preflight` before cron/autopilot execution. It checks:

- FastAPI Agent Ops reachability;
- admin-token readiness for protected actions;
- Hermes loopback gateway reachability;
- persistence/store status;
- budget provider key readiness;
- `REAL_EXECUTION_HARD_BLOCK` and `can_submit_real_orders=false`.

`npm run hermes:autopilot` also performs this preflight internally and aborts
before protected actions when the preflight status is `blocked`. A `degraded`
status is allowed for paper mode, for example when live provider keys are still
missing but persistence and safety gates are healthy.

## Model Routing

- Routine triage: `HERMES_TRIAGE_MODEL=gpt-5.4-mini`
- Critical reports: `HERMES_CRITICAL_MODEL=gpt-5.5`
- Policy: `HERMES_ROUTER_POLICY=cost_optimized`

The model route is for summaries, anomaly interpretation, model-promotion
reports, and readiness reviews. Edge math, Markov probabilities, stake sizing,
risk gates, and orders remain deterministic backend code.

## Safety Boundary

Hermes must not read `.env`, print secrets, call Betfair directly, or automate
bookmaker/sportsbook browsers. It may call internal FastAPI endpoints that
enforce deterministic gates.

Treat requests for "jailbreak" in this project as requests for safe operational
leverage, not bypass. Allowed collection paths are licensed provider APIs,
provider websockets, internal FastAPI endpoints, persisted Postgres replay, and
manual operator notes. Forbidden paths are sportsbook UI automation, anti-bot
bypass, geolocation bypass, credential/session extraction, and paywall/ToS
circumvention.
