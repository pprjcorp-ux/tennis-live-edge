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
npm run hermes:collection-plan
npm run hermes:quota-plan
npm run hermes:learning-review
npm run hermes:budget-chain
npm run hermes:provider-smoke
npm run hermes:safe-loop
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
not start, stop, install, or repair Hermes services.

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
services or creating cron jobs.

`hermes:backend-readiness` verifies the local FastAPI side of Hermes without
starting services: preflight, dashboard live-state, live matches, provider
health, cost profile and execution status. It confirms real execution remains
hard-blocked and emits manual actions such as `npm run api:dev` only when the
API is unavailable.

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

`hermes:autonomy-brief` consolidates the safe loop, event routing, live-window
state, quota throttle and local ledger priorities into one operating packet. It
is the preferred "maximum autonomy without more authority" view: read-only,
event-driven, no LLM per tick, no provider calls, no paper orders, and no real
execution.

`hermes:source-discovery` maps every useful data class to safe acquisition
paths: licensed provider APIs, provider websocket, internal FastAPI endpoints,
persisted replay, public allowed research, or manual operator notes. It is
read-only and turns "jailbreak" into route discovery, not bypass.

`hermes:source-route-matrix` ranks those allowed paths into budget-first
operating routes: replay backfill, internal live statistics, closing-line
proxy, archive odds smoke, score state, live websocket odds, public context
notes and manual operator notes. It includes event triggers, cost tiers,
success evidence and blocked conditions while keeping
`provider_api_call_allowed=false`.

`hermes:trigger-policy` turns runtime, event, source-discovery, quota and
learning state into safe wakeup triggers for cron, Telegram, dashboard,
Cloudflare Agent and OpenClaw gateway. It never executes trigger commands and
keeps LLM work out of per-tick processing.

`hermes:ops-compiler` is the single orchestration packet for agent channels. It
compiles trigger policy, source discovery, autonomy brief, operator packet and
model routing into one non-executing payload.

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

`hermes:backlog-plan` compiles local mission/operator/experiment ledger
evidence into non-executing implementation priorities. Each item includes
target files, validation commands, acceptance evidence and the gates it would
unblock.

`hermes:scheduler-rehearsal` turns the latest safe-loop output into a proposed
local schedule and appends a JSONL audit row to `hermes/runs/`. It does not
create real cron jobs, execute commands, create paper orders, spend provider
quota, or submit real orders.

`hermes:cron-proposal` writes a reviewable local manifest at
`hermes/runs/cron-proposal.json` with exact `hermes cron add` command previews.
It does not call `hermes cron add` and excludes provider-smoke, autopilot,
admin-token, quota-consuming, and order-creating jobs.

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
