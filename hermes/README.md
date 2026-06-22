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

## Operator Channel Secret Gate

`hermes:implementation-handoff` can route the next work item to
`configure_hermes_operator_channel_secrets` after the local Hermes runtime is
healthy. That is not a runtime repair task. It means the operator channel is
still limited to `observe` until local-only secrets and allowlists exist.

Configure these values only in the repo-local `.env` or your local shell, never
in Git:

```bash
HERMES_TELEGRAM_ALLOWED_USER_IDS=123456789
OPENCLAW_TELEGRAM_ALLOWED_USER_IDS=123456789
PRIVATE_ALLOWED_EMAILS=operator@example.com
TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS=operator@example.com
ADMIN_API_TOKEN=replace-with-random-32-byte-token
TENNIS_EDGE_ADMIN_API_TOKEN=replace-with-random-32-byte-token
```

Only one Telegram allowlist variable, one private email allowlist variable, and
one admin token variable must be configured; the aliases exist so Hermes,
legacy OpenClaw naming, and Tennis Edge backend wrappers agree on the same
gate. Do not paste real values into chat, docs, commits, issue comments, or
terminal output snippets.

After local values are present, verify the gate without printing values:

```bash
npm --silent run hermes:channel-readiness
npm --silent run hermes:activation-checklist
npm --silent run hermes:implementation-handoff
```

The expected proof is: `doctor_passed=pass`,
`telegram_allowlist_configured=pass`, `private_access_allowlist_configured=pass`,
`local_admin_secret_available=pass`, `secret_value_printed=false`, and the
handoff no longer choosing `configure_hermes_operator_channel_secrets`.

## Local Skill Commands

```bash
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
npm run hermes:source-intake-plan
npm run hermes:source-intake-ledger
npm run hermes:source-intake-ledger-report
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
npm run hermes:operator-packet
npm run hermes:operator-ledger
npm run hermes:operator-ledger-report
npm run hermes:runtime-fix-priorities
npm run hermes:scheduler-rehearsal
npm run hermes:cron-proposal
npm run hermes:activation-checklist
npm run hermes:runtime-fix-plan
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

`hermes:runtime-check` runs `hermes status` and `hermes doctor` as local
read-only diagnostics and returns JSON with stdout/stderr/exit codes. It does
not start, stop, install, or repair Hermes services. It also exposes
`capability_summary` and `autonomy_impact` so a partial runtime can still
produce read-only packets when the gateway/model path is usable, while cron,
channel escalation, paper autopilot and real execution stay blocked by gates.
`hermes:safe-loop`, `hermes:operator-packet`, and `hermes:ops-compiler` surface
that condition as `runtime_partial` plus `read_only_runtime_route`, currently
`npm --silent run hermes:operator-packet`, so Hermes can keep producing compact
operator summaries without spending provider quota or creating orders.

`hermes:doctor-triage` runs bounded local probes for Hermes version, status and
a short doctor attempt. Use it when `runtime-check` reports
`doctor_timed_out`; it classifies likely causes, redacts command output, and
prints only non-executed manual actions.

`hermes:channel-readiness` is the non-mutating proof packet for moving from
`observe` to `channel_ready`. It checks Hermes CLI availability, gateway
running state, bounded doctor status, Telegram allowlist, private Access
allowlist, and local admin token presence. Failed checks become ordered manual
actions; the command never starts the gateway, edits `.env`, creates cron jobs,
calls providers, or creates orders.

`hermes:channel-recovery-plan` converts failed channel-readiness gates into a
local-only recovery packet. It prints required environment variable names,
configured counts, `secret_value_printed=false`, verification commands and
human-only steps without printing secret values, editing `.env`, starting
services or creating cron jobs. It also emits `operator_channel_bootstrap`, a
read-only `.env` template packet with aliases, acceptance evidence, and
verification commands. The bootstrap packet has
`automated_env_write_allowed=false`; it never writes `.env`, generates tokens,
or prints secret values.

`hermes:backend-readiness` verifies the local FastAPI side of Hermes without
starting services: preflight, dashboard live-state, live matches, provider
health, cost profile and execution status. It confirms real execution remains
hard-blocked and emits manual actions such as `npm run api:dev` only when the
API is unavailable.

`hermes:backend-latency-triage` is the bounded follow-up when only some FastAPI
endpoints timeout. It measures local endpoint duration, prints compact shape
summaries only, and never starts services, calls providers, creates orders, or
prints payload bodies.

`hermes:mission-control` is the single safest entrypoint for external agents or
operator channels. It merges backend readiness, channel readiness, source-route
matrix and live-window into one ordered `next_action`, preserving
`executes_now=false`, `provider_api_call_allowed=false`, and
`can_submit_real_orders=false` on every lane.

`hermes:mission-ledger` appends that mission-control packet to
`hermes/runs/mission-ledger.jsonl` by default. It records the recommendation as
`observed` with `action_executed=false` and
`mission_command_executed=false`; it does not execute the next action.

`hermes:mission-ledger-report` summarizes the mission ledger without writing.
It counts repeated next actions, blocked lanes, active ceilings and any rows
that claim a mission command was executed.

`hermes:intelligence` is the high-signal operator packet for cron/Telegram. It
aggregates provider health, cursor gaps, data quality, cost, paper performance,
bankroll, live signals, replay lab and onboarding state. It recommends one safe
mode: investigate, budget-chain buildout, paper-autopilot candidate, collect
learning data, replay-lab hardening, or steady monitoring.
Internal FastAPI reads are bounded by `HERMES_HTTP_TIMEOUT_MS` (default 5000ms,
clamped between 100ms and 30000ms). If the backend is unavailable or slow,
composed commands such as `hermes:intelligence`, `hermes:safe-loop`, and
`hermes:experiment-ledger` return degraded JSON with `backend_api` blockers
instead of hanging or executing fallback actions.
Enterprise-only cursors such as Sportradar/Betradar/TXODDS are reported as
`deferred_enterprise_cursors` while the budget chain is incomplete, so they do
not block lean ATP/Grand Slam operation before enterprise is eligible.

`hermes:events` converts that packet into deterministic event triggers for
cron/webhook routing. It can recommend commands such as `hermes:preflight`,
`api:check:operational-truth`, `hermes:ops:daily`, or `hermes:autopilot`.
Paper order creation is only marked possible for `paper_autopilot_candidate`
when no high-severity data, cursor, provider, preflight, budget-chain, or real
execution safety blocker exists.

`hermes:unblock-plan` turns blockers into prioritized operator lanes: local
runtime, provider smoke, provider credentials, data quality, learning
collection, and deferred enterprise work. It is read-only and never runs the
suggested commands.

`hermes:playbook` converts the same state into phase-based operating steps:
observe, stabilize data, complete the budget chain, collect learning evidence,
paper autopilot, and weekly learning review. It does not run commands. It marks
each step as `ready`, `waiting`, or `blocked`, and always keeps
`can_submit_real_orders=false`.

`hermes:live-stats` is the low-cost live operations packet. It derives
collection health, processing health, signal readiness, freshness buckets,
learning progress, cost efficiency, and the safe sampling policy from internal
FastAPI state. It is designed for frequent cron/Telegram use without LLM
analysis on every tick.

`hermes:live-window` is the go/no-go packet for a live operating window. It
combines event gates, provider mode, freshness, budget-chain state, signal
readiness, and execution safety into `paper_ready`, `monitor`, `blocked`, or
`safety_stop`. It is read-only and never executes the returned next action.

`hermes:match-pulse` ranks current matches by attention priority using live
status, score/odds freshness, pressure state, edge, signal status, and the
global live-window gate. It is read-only and can only recommend the protected
paper autopilot route when the live window is `paper_ready`.

`hermes:collection-plan` converts match-pulse priorities into desired score and
odds polling lanes such as `hot_watch`, `warm_watch`, `repair_watch`, and
`frozen`. It is read-only: provider ingestion commands are shown only as
operator candidates with `executes_now=false` and `provider_api_call_allowed=false`.

`hermes:quota-plan` wraps the collection plan with cost/budget throttles. It
keeps the plan read-only, can slow or freeze desired cadence near monthly
budget limits, and suppresses provider command candidates when the budget guard
is active.

`hermes:learning-review` is the weekly readiness packet. It summarizes
settled paper evidence, production training examples, ROI/CLV readiness and
high-severity blockers, routes interpretation to `gpt-5.5`, and still returns
`real_execution_recommendation=keep_blocked`.

`hermes:budget-chain` turns API onboarding state into a dry-run provider smoke
plan. It reports the current provider, required prerequisites, and exact smoke
command, but defaults `provider_api_call_allowed=false` so Hermes cannot spend
vendor quota without an explicit operator action.

`hermes:provider-smoke` is the explicit execution gate for the current budget
provider smoke. Without `--execute-provider-call`, it returns a blocked dry-run
packet with `provider_api_call_allowed=false` and the command it would run. Do
not put `--execute-provider-call` in cron or Telegram automation; use it only
from a local operator shell when you intentionally want to spend provider quota.

`hermes:safe-loop` is the preferred autonomous status packet. It aggregates the
local runtime check, intelligence, event routing, unblock plan, playbook,
live-stats, quota-plan, budget-chain, and weekly-learning packets into one
read-only JSON decision. It never creates paper orders, spends provider quota,
calls provider smoke execution, or submits real orders.

`hermes:operator-packet` compresses the latest safe-loop decision for
Telegram/OpenClaw channels. It reports priority, headline, short message, next
safe action, cost guard and safety flags in a compact read-only JSON packet.

`hermes:operator-ledger` appends the operator packet to
`hermes/runs/operator-ledger.jsonl` by default. It records the recommendation as
`observed` with `action_executed=false`; it does not execute the next action.

`hermes:operator-ledger-report` summarizes the local ledger without writing. It
counts priorities, statuses, outcomes, throttle states, repeated next actions
and any accidental executed-action rows.

`hermes:runtime-fix-priorities` converts the ledger report into ordered local
improvement priorities. It is read-only and never runs the repeated commands it
surfaces.

`hermes:autonomy-effectiveness` is the closed-loop measurement packet for
Hermes autonomy. It reads the local experiment, operator, mission,
live-controller and Grand Slam mission ledgers, scores repeated blockers,
flags any protected-action claim, and recommends the next non-executing
handoff. It measures ledgers, not intent, and keeps provider spend, paper
orders and real execution blocked. `hermes:ops-compiler`,
`hermes:implementation-handoff`, `hermes:scheduler-rehearsal` and
`hermes:cron-proposal` consume this packet so repeated evidence becomes a
reviewable work route instead of another standalone report.

`hermes:autonomy-brief` consolidates the safe loop, event routing, live-window
state, quota throttle and local ledger priorities into one operating packet. It
is the preferred "maximum autonomy without more authority" view: read-only,
event-driven, no LLM per tick, no provider calls, no paper orders, and no real
execution. When runtime is `runtime_partial`, it recommends the read-only
runtime lane, keeps diagnostics first, and adds the operator-packet route as a
summary-only action.

`hermes:source-discovery` maps every useful data class to safe acquisition
paths: licensed provider APIs, provider websocket, internal FastAPI endpoints,
persisted replay, public allowed research, or manual operator notes. It is
read-only and turns "jailbreak" into route discovery, not bypass.

`hermes:source-route-matrix` ranks those allowed paths into budget-first
operating routes: replay backfill, internal live statistics, closing-line
proxy, public historical backfill, archive odds smoke, score state, live
websocket odds, public context notes and manual operator notes. It includes
event triggers, cost tiers, success evidence and blocked conditions while keeping
`provider_api_call_allowed=false`.

`hermes:source-route-ledger` appends the current source-route matrix to a local
JSONL ledger without executing any route command. Use
`hermes:source-route-ledger-report` to summarize repeated allowed-route
recommendations, blocked routes, operator-required routes, and any accidental
execution/bypass claims. `hermes:backlog-plan`, `hermes:experiment-lab`, and
`hermes:autonomy-effectiveness` consume this report so repeated allowed-route
decisions become implementation work before provider spend or importer code.

`hermes:replay-backfill-contract` turns the `replay_backfill` source route into
an offline contract named `replay_backfill_to_operational_truth`. It maps
persisted matches, score ticks, odds ticks, signals, paper orders and replay
lab evidence into implementation inputs and acceptance criteria. It also
accepts `source-intake-ledger-report` evidence when the top allowed contract is
`route:replay_backfill`, so repeated intake decisions can become replay/read
model work without re-running provider or route commands. It is read-only: no
provider calls, no browser scraping, no sportsbook automation, no bypass, no
paper order creation and no real execution.
The contract exposes `source_intake_pressure`, accepts
`local_source_intake_ledger` as an allowed input, and includes the implementation
step `use_source_intake_allowed_contract_when_it_proves_route_replay_backfill`.

`hermes:source-use-manifest` is the audit layer between safe source discovery
and collection/import work. It creates one source-use row per collection route,
historical source and enterprise shadow provider, with allowed/deferred/
operator-required status, license and attribution gates, quota permissions,
required evidence and forbidden actions. It is read-only: no provider calls, no
public dataset fetch, no browser scraping, no sportsbook automation, no bypass,
no paper order creation and no real execution.
The JSON mode is `source_use_manifest`; evidence rows require
`license_terms_reviewed` where applicable and block
`provider_quota_spend_without_operator`. `hermes:ops-compiler` includes the
manifest as `source_use_manifest` plus an execution-graph node, so operator and
cron packets cannot hide source-use review behind source-route summaries.
`hermes:scheduler-rehearsal` schedules it every 15 minutes, and
`hermes:implementation-handoff` includes it in every work-order validation
bundle before collection/import changes.
`hermes:source-use-ledger` appends manifest decisions to local JSONL with
`action_executed=false`, `provider_command_executed=false` and
`bypass_attempted=false`. `hermes:source-use-ledger-report` summarizes repeated
operator-required, deferred, forbidden and license-review sources so future
work can prioritize the real blocker without fetching data or spending quota.
The report JSON mode is `source_use_ledger_report`. `hermes:backlog-plan`,
`hermes:experiment-lab`, `hermes:autonomy-effectiveness`, and
`hermes:implementation-handoff` consume this report as the `source_use` lane,
so repeated source-use blockers become implementation work before any importer,
dataset fetch, provider quota spend, or enterprise feed activation.

`hermes:source-intake-plan` converts the source-use manifest plus ledger
pressure into four read-only queues: allowed contracts, operator review,
deferred providers and forbidden quarantine. It is the bridge from "Hermes
found a possible data route" to "Codex may implement an offline/internal
contract". The command sets `dataset_fetch_allowed=false`,
`provider_api_call_allowed=false` and `can_submit_real_orders=false`; it may
recommend `hermes:replay-backfill-contract` or `hermes:live-stats`, but it
must not fetch public datasets, spend provider quota, scrape, bypass controls
or create paper/real orders.
The JSON mode is `source_intake_plan`, and the acceptance contract includes
`source_intake_plan.mode=source_intake_plan`,
`allowed_contracts_before_operator_review_before_deferred_before_forbidden`,
and `forbidden_quarantine`.
`hermes:source-intake-ledger` appends the selected intake queues and next
contract to local JSONL only, with `intake_command_executed=false`,
`dataset_fetch_attempted=false`, `provider_command_executed=false`, and
`bypass_attempted=false`. `hermes:source-intake-ledger-report` summarizes
repeated `allowed_contract`, `operator_review`, `deferred`, and
`forbidden_quarantine` decisions before any importer or provider activation.
The ledger write scope is `local_source_intake_jsonl_only`, and the report JSON
mode is `source_intake_ledger_report`.
`hermes:backlog-plan`, `hermes:experiment-lab`,
`hermes:autonomy-effectiveness`, and `hermes:implementation-handoff` consume
this report as the `source_intake` lane. Repeated intake queues become the
`harden_source_intake_feedback_loop` work order, which may only route the top
allowed contract into replay/internal FastAPI read-model work while keeping
operator-review, deferred enterprise and forbidden-quarantine sources out of
execution.

`hermes:historical-backfill-plan` ranks offline data sources that can improve
priors, backtests and calibration: internal replay, Jeff Sackmann ATP/WTA/Slam
datasets, Tennis-Data CSVs and licensed archive odds. It is read-only and
operator-review only: it does not fetch, scrape, import, spend quota or create
orders, and it flags license, attribution and commercial-clearance gates before
any future importer exists.

`hermes:enterprise-accuracy-plan` is the no-budget-limit accuracy packet. It
ranks top-tier scoring, shot-by-shot and odds feeds, maps the model layers they
unlock, defines the Grand Slam scoreline forecast contract, and emits an
enterprise due-diligence matrix for provider contracting: required fields,
proof artifacts, acceptance tests and Hermes review evidence. It stays
read-only: no provider calls, no scraping, no quota spend, no paper orders and
no real execution. The ops compiler, experiment lab, scheduler rehearsal and
cron proposal include it as recurring review evidence only.

`hermes:grand-slam-scoreline-forecast` is the match-day scoreline packet. It
uses only internal `/api/v1/live/matches` prediction rows to project the likely
winner and set scoreline distribution for Grand Slam singles. ATP Slam rows are
treated as BO5 with `3-0/3-1/3-2` outcomes; WTA Slam rows are treated as BO3
with `2-0/2-1` outcomes. It is deliberately conservative: no exact game-score
claim, no live provider calls, no scraping, no quota spend, no paper order
creation and no real execution.

`hermes:grand-slam-mission` is the one-packet command for the core product
goal: predicting and monitoring Grand Slam matches of the day. It compiles
backend readiness, Grand Slam visibility, scoreline forecasting, historical
backfill, match pulse, collection cadence, quota throttle, live-controller
decision and learning review into explicit mission phases. It reports when
paper learning would be available, but it does not create paper orders, spend
provider quota, scrape, or submit real orders.

`hermes:grand-slam-mission-ledger` appends that mission packet as compact local
JSONL evidence at `hermes/runs/grand-slam-mission-ledger.jsonl` by default. It
records active phase, Grand Slam readiness, next safe command, live-controller
status, quota level and learning status while marking
`mission_command_executed=false`, `provider_command_executed=false` and
`paper_order_created=false`.

`hermes:grand-slam-mission-ledger-report` summarizes repeated Grand Slam mission
phases without writing or executing commands. `hermes:backlog-plan` consumes
this report so recurring visibility/model-input/paper-learning blockers become
implementation priorities instead of manual guesswork.

`hermes:trigger-policy` turns runtime, event, source-discovery, Grand Slam
readiness, quota and learning state into safe wakeup triggers for cron,
Telegram, dashboard, Cloudflare Agent and OpenClaw gateway. It never executes
trigger commands and keeps LLM work out of per-tick processing. Partial runtime
emits both a diagnostic trigger and a lower-priority read-only summary trigger.

`hermes:ops-compiler` is the single orchestration packet for agent channels. It
compiles trigger policy, source discovery, Grand Slam readiness, autonomy brief,
operator packet and model routing into one non-executing payload.

`hermes:capability-audit` scores Hermes against the actual operating objective:
safe source discovery, live collection, live statistics, paper autopilot,
learning review, external-agent orchestration, budget chain and enterprise
gate. It is read-only and does not execute the next safe command it reports.
Runtime diagnostics expose `runtime_findings` and manual diagnostic actions,
including stopped gateway state and doctor timeout/failure state, without
starting services from the repo command.

`hermes:autonomy-gates` proves the current autonomy ceiling before escalation.
It reports ordered gates, `active_ceiling`, and `next_required_gate` across
observe, channel, cron, paper, learning, and enterprise review. It is read-only,
does not create paper orders, and keeps enterprise locked until the budget chain
is eligible.

`hermes:experiment-lab` ranks the next safe research/test path for Hermes. It
returns experiments with hypotheses, prerequisites, `success_metrics`, evidence
and command previews for runtime, source discovery, live collection, paper
learning and enterprise readiness. It is read-only and does not execute the
reported experiments.

`hermes:experiment-ledger` appends the experiment lab packet to
`hermes/runs/experiment-ledger.jsonl` by default. It records the active ceiling,
ready experiment ids, next experiment and `experiment_command_executed=false`;
it never runs the experiment command it records.

`hermes:experiment-ledger-report` summarizes repeated experiment
recommendations and active ceilings from the local ledger without writing or
executing commands.

`hermes:backlog-plan` compiles local mission/operator/experiment/live-control,
source-route and Grand Slam mission ledger evidence into non-executing implementation priorities. Each item includes
target files, validation commands, acceptance evidence and the gates it would
unblock.

`hermes:autonomy-effectiveness` should run before handoff work when enough
ledger evidence exists. It decides whether Hermes is still only collecting
evidence, has repeated blockers that justify implementation, or needs safety
review because a ledger claims a protected action ran. The implementation
handoff carries its status and score in the work order evidence.
When that work order is `harden_source_route_feedback_loop`, the suggested
steps must map the top source route to replay/internal or licensed adapter
contracts without executing it, keep browser scraping/sportsbook automation and
bypass routes blocked, and prove route/provider/bypass counters remain zero.
When that work order is `harden_source_use_feedback_loop`, the suggested steps
must review operator-required, deferred and forbidden sources, map the top
source to license terms, contract status or enterprise deferred gates, keep
dataset fetch/provider quota/forbidden routes operator-gated, and prove
manifest/provider/bypass counters remain zero.
When that work order is `harden_source_intake_feedback_loop`, the suggested
steps must review allowed/operator/deferred/forbidden intake queues, map the top
allowed contract to replay or internal FastAPI read-model work without fetching
data, keep operator-review/deferred/quarantined sources out of execution, and
prove intake/dataset/provider/bypass counters remain zero.
The machine-readable handoff evidence includes `source_use_records`,
`source_use`, `source_intake_records`, `source_intake`,
`review_source_use_ledger_report_for_operator_required_deferred_and_forbidden_sources`,
`map_the_top_source_to_license_terms_contract_status_or_enterprise_deferred_gate`,
`prove_manifest_provider_and_bypass_counters_remain_zero`,
`review_source_intake_ledger_report_for_allowed_operator_deferred_and_forbidden_queues`,
`map_the_top_allowed_contract_to_replay_or_internal_fastapi_read_model_without_fetching_data`,
`prove_intake_dataset_provider_and_bypass_counters_remain_zero`,
`manifest_command_executed=false`, `intake_command_executed_count=0`, and
`dataset_fetch_attempted_count=0`.

`hermes:scheduler-rehearsal` turns the latest safe-loop output into a proposed
local schedule and appends a JSONL audit row to `hermes/runs/`. It does not
create real cron jobs, execute commands, create paper orders, spend provider
quota, or submit real orders. It also includes `hermes:grand-slam-readiness`
with adaptive cadence: low-frequency off-calendar, tighter during a configured
Grand Slam window, and five-minute checks when backend Grand Slam rows are
paper-ready. The schedule also includes `hermes:grand-slam-mission` at the same
cadence so channels can consume the full mission packet without calling
provider APIs. If Hermes is `runtime_partial`, the schedule keeps the bounded
diagnostic command as the next tick and adds the read-only operator-packet
route as a separate non-executing job candidate.

`hermes:cron-proposal` writes a reviewable local manifest at
`hermes/runs/cron-proposal.json` with exact `hermes cron add` command previews.
It does not call `hermes cron add` and excludes provider-smoke, autopilot,
admin-token, quota-consuming, and order-creating jobs. Grand Slam readiness cron
proposals remain read-only and cannot create paper orders even when the packet
reports paper-ready matches.

`hermes:activation-checklist` is the final non-mutating gate before a human
creates cron jobs. It checks Hermes runtime health, Telegram allowlist,
private-access email allowlist, local admin secret presence, cron manifest
safety, no executed commands, and the real-execution hard block. It prints only
booleans/counts for secrets and exposes manual activation commands only when
all checks pass.

`hermes:runtime-fix-plan` converts failed activation-checklist gates into
ordered local/operator actions. It is read-only, does not write the cron
manifest, does not execute repair/restart/install commands, does not create
jobs, and keeps provider API calls, paper orders, and real execution blocked.
Capability summaries from runtime-check are advisory only and cannot override
doctor, allowlist, local-admin, provider-quota or real-execution gates.

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
