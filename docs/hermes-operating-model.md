# Hermes Operating Model

Hermes should become the local operating layer for Tennis Live Edge, not a
replacement for the backend. The backend remains the deterministic source of
truth for data quality, probabilities, signal gates, risk, paper orders,
settlement, learning, and future execution blocks.

## Target Structure

```text
Licensed feeds / replay / operator notes
  -> FastAPI ingestion and canonical state
  -> deterministic model, signal, risk, paper execution
  -> Hermes intelligence packet
  -> Hermes cron/gateway/operator summary
  -> protected backend action only when gates pass
```

Hermes can add leverage in nine places:

1. Intelligence packets: combine provider health, cursor status, cost, data
   quality, paper performance, bankroll, signals, replay lab and onboarding
   state into one safe JSON packet.
2. Live statistics packets: summarize collection, processing, freshness,
   signal readiness, learning progress, cost efficiency and sampling policy
   without LLM work per tick.
3. Budget-chain onboarding: expose the next paid-provider smoke as a dry-run
   command with prerequisites and quota guardrails.
4. Event routing: cron/webhook/gateway can wake Hermes only on useful events
   such as feed gaps, stale odds, critical anomalies, quota risk, new entry
   signals, or post-day settlement windows.
5. Playbooks: deterministic phase plans turn events into safe next commands
   without giving Hermes broad shell discretion.
6. Model routing: cheap model for routine triage; strong model only for severe
   anomaly, weekly learning review, and real-execution-readiness reports.
7. Memory: preserve operating lessons, provider quirks, recurring blockers and
   review outcomes, while keeping provider secrets outside prompts.
8. Skill reuse: the `tennis-edge-ops` skill gives Hermes a narrow, repeatable
   command surface instead of broad shell improvisation.
9. Human reachability: Telegram/dashboard can surface concise actions without
   exposing the backend or provider credentials publicly.

## Safe Collection Boundary

Requests for "jailbreak" in this project must be interpreted as safe
operational leverage. The allowed paths are:

- licensed provider APIs;
- provider websockets;
- internal FastAPI endpoints;
- persisted Postgres replay;
- manual operator notes;
- public documentation and public news/research pages when usage is allowed.

Forbidden paths:

- sportsbook UI automation;
- anti-bot bypass;
- geolocation bypass;
- credential/session extraction;
- paywall or Terms-of-Service circumvention;
- direct Betfair/sportsbook calls from Hermes;
- LLM-initiated real-money execution.

If a data source is useful but not licensed or not clearly allowed, Hermes may
create an operator note or provider onboarding task. It must not collect the
data through browser tricks.

## Autonomy Ladder

### Level 0: Observe

Run `npm run hermes:intelligence`, `npm run hermes:live-stats`,
`npm run hermes:budget-chain`, `npm run hermes:events`, `npm run hermes:playbook` and
`npm run hermes:preflight`. No writes.

### Level 1: Rehearse

Run `npm run hermes:ops:daily` through stdin-provided admin token. This runs
replay contracts, paper auto-settlement and Model Lab rehearsal without live
API calls.

### Level 2: Paper Autopilot

Run `npm run hermes:autopilot` only when preflight is not blocked and the
event router reports `can_run_paper_autopilot=true`. The backend still decides
whether paper orders are created.

### Level 3: Learning Review

Use the strong model route for weekly ROI, CLV, calibration, drawdown and model
promotion review. Model weights and staking policy can only change through
backend promotion gates.

### Level 4: Real Execution Readiness

Produce a readiness report only. Real execution remains disabled until a
separate compliance/account/API task changes `REAL_EXECUTION_HARD_BLOCK`.

## Recommended Cron Graph

- Every 5 minutes during active windows: `npm run hermes:intelligence`.
- Every 5 minutes when Hermes needs one autonomous packet: `npm run hermes:safe-loop`.
- Every 5 minutes when Hermes needs the highest-level autonomy decision: `npm run hermes:autonomy-brief`.
- Every 5-15 minutes during collection work: `npm run hermes:source-discovery`.
- During Grand Slam windows: `npm run hermes:grand-slam-mission`.
- Before collection/import work from any new route: `npm run hermes:source-use-manifest`.
- Hourly/daily to audit repeated source-use blockers: `npm run hermes:source-use-ledger-report`.
- Manual/weekly review for offline priors: `npm run hermes:historical-backfill-plan`.
- Every 5 minutes for cron/webhook wakeup policy: `npm run hermes:trigger-policy`.
- Every 5 minutes for an all-in-one agent-channel payload: `npm run hermes:ops-compiler`.
- Every 5 minutes while Hermes is `runtime_partial`: keep the diagnostic
  command as the next tick and also schedule the read-only operator-packet route.
- Every 15 minutes or before autonomy escalation: `npm run hermes:capability-audit`.
- Every 5 minutes before channel/cron/paper escalation: `npm run hermes:autonomy-gates`.
- Every 15 minutes to rank safe operational experiments: `npm run hermes:experiment-lab`.
- Every 15 minutes to audit experiment recommendations locally: `npm run hermes:experiment-ledger`.
- Hourly/daily to review experiment recommendation quality: `npm run hermes:experiment-ledger-report`.
- Hourly/daily to convert ledger evidence into implementation priorities: `npm run hermes:backlog-plan`.
- Before handoff work or autonomy escalation: `npm run hermes:autonomy-effectiveness`.
- Before coding from Hermes evidence: `npm run hermes:implementation-handoff`.
- Every 5 minutes for short channel summaries: `npm run hermes:operator-packet`.
- Every 5 minutes to audit channel recommendations locally: `npm run hermes:operator-ledger`.
- Hourly/daily to review recommendation quality: `npm run hermes:operator-ledger-report`.
- Hourly/daily to rank repeated local fixes: `npm run hermes:runtime-fix-priorities`.
- Before any real cron change: `npm run hermes:scheduler-rehearsal`.
- To generate a reviewable cron manifest: `npm run hermes:cron-proposal`.
- Final gate before manual cron creation: `npm run hermes:activation-checklist`.
- When activation is blocked: `npm run hermes:runtime-fix-plan`.
- Every 1-5 minutes during active windows: `npm run hermes:live-stats`.
- Every 1-5 minutes during active windows: `npm run hermes:live-window`.
- Every 1-5 minutes during active windows: `npm run hermes:match-pulse`.
- Every 1-5 minutes during active windows: `npm run hermes:collection-plan`.
- Every 1-5 minutes during active windows: `npm run hermes:quota-plan`.
- Every 1-5 minutes when a channel needs one live-data decision:
  `npm run hermes:live-controller`.
- Every 5-15 minutes during active windows to audit controller decisions:
  `npm run hermes:live-controller-ledger`.
- Hourly/daily to review repeated live-control decisions:
  `npm run hermes:live-controller-ledger-report`.
- Every 15 minutes during onboarding: `npm run hermes:budget-chain`.
- Every 5 minutes during active windows: `npm run hermes:events`.
- Every 5 minutes while blocked: `npm run hermes:unblock-plan`.
- When local runtime is first blocker: `npm run hermes:runtime-check`.
- Every 5 minutes during active windows: `npm run hermes:playbook`.
- Every 15 minutes: `npm run hermes:preflight`.
- Every 15 minutes: `npm run hermes:anomalies`.
- Daily morning: `npm run hermes:ops:daily`.
- Weekly: `npm run hermes:learning-review` for the strong-model learning/readiness packet.

Do not run LLM analysis on every odds tick. Tick math belongs to Python and
Postgres; Hermes wakes only on summarized state or event thresholds.

`hermes:safe-loop` is the preferred autonomous packet when a channel or cron
job needs the broadest safe context. It runs local runtime diagnostics and
internal FastAPI reads, then combines intelligence, event routing, unblock
lanes, playbook phases, live stats, quota-plan throttle state, budget-chain
state, and learning review into one JSON decision. The intelligence read model
uses sequential `HERMES_INTELLIGENCE_TIMEOUT_MS` probes to avoid false backend
outages when one local endpoint is slow. It is read-only and keeps
`provider_api_call_allowed=false`, `llm_per_tick_allowed=false`, and
`can_submit_real_orders=false`.

`hermes:autonomy-brief` is the preferred packet for deciding how much autonomy
Hermes can safely use right now. It combines the safe-loop, live-window gates,
quota throttles and operator-ledger priorities into an autonomy matrix across
collection, processing, live statistics, paper autopilot, learning and
enterprise eligibility. When runtime is `runtime_partial`, the recommended lane
is `partial_runtime_read_only`; the action queue keeps the bounded runtime
diagnostic first and adds the operator-packet route as a non-executing summary
path. It encodes the safe interpretation of "jailbreak":
licensed APIs, websockets, internal endpoints, persisted replay, manual notes
and public research are allowed; sportsbook UI automation, anti-bot bypass,
geolocation bypass, credential/session extraction and real-money execution are
not.

`hermes:source-discovery` is the preferred packet for improving data coverage
without expanding authority. It maps score state, live odds, archive odds,
closing-line proxy, live statistics, public context, manual notes, replay
backfill and historical public backfill to allowed acquisition paths. It can
say "use public allowed research" or "record a manual operator note", but it
must never scrape restricted pages, open sportsbook UIs, bypass anti-bot/
geolocation controls, extract sessions, or spend provider quota.
For offline priors it also exposes `backfill_source_dossier` and
`backfill_source_summary`, so Hermes can compare CC BY-NC-SA, CC0-candidate,
public-terms and paid-API historical sources without downloading anything.
That dossier is where Match Charting shot/point priors, Kaggle CC0 candidates
and licensed archive odds are routed into operator review rather than live
collection.

`hermes:source-use-manifest` is the contract between route discovery and real
collection/import implementation. It emits one row per collection route,
historical source and enterprise shadow provider, classifying each as allowed,
operator-required, deferred or forbidden. Rows include license and attribution
requirements, quota permissions, required evidence and blocked conditions. This
is the safe interpretation of "jailbreak": Hermes may find permitted alternate
routes, but every route must be source-manifested before code imports data or
spends provider quota.
The all-in-one `hermes:ops-compiler` packet embeds the manifest as
`source_use_manifest` and adds a graph node for it, so external agent channels
receive source-use status alongside source discovery, enterprise readiness and
Grand Slam readiness. Scheduler rehearsal keeps it in the recurring read-only
loop, and implementation handoff includes it as a required validation command
for every work order.
`hermes:source-use-ledger` and `hermes:source-use-ledger-report` make that
contract observable over time. They write/read local JSONL only and count
repeated operator-required, deferred, forbidden and license-review sources
without executing collection commands or calling providers.

`hermes:historical-backfill-plan` is the preferred packet for offline priors and
backtest depth. It ranks internal persisted replay, Jeff Sackmann ATP/WTA/Slam
datasets, Match Charting shot/point data, Tennis-Data CSVs, Kaggle
dataset-license candidates and licensed archive odds while exposing license,
attribution, commercial-clearance, source-manifest and quota gates. It does not
fetch or import data; future import scripts must be separate, operator-approved
and license-aware.

`hermes:enterprise-accuracy-plan` is the preferred packet for the no-budget
enterprise branch. It turns top-tier scoring, point-by-point, shot-by-shot,
exchange and odds-feed research into an operator-reviewed provider stack,
access checklist, model architecture, Grand Slam scoreline forecast contract
and enterprise due-diligence matrix. Hermes uses that matrix to ask for sample
payloads, prove required fields, define replay contracts and reject any provider
that cannot supply timestamped, license-cleared evidence. It remains read-only
and keeps `provider_api_call_allowed=false`.

`hermes:enterprise-readiness` is the operational gate packet for that branch.
It reads backend evidence from `enterprise_shadow_providers`, budget-chain
status, replay readiness, learning state and execution safety, then reports
whether the system is still locked, missing shadow contracts, blocked by replay
or ready only for human provider-contract review. It never executes provider
smokes or activates credentials.
When shadow contracts are visible, `hermes:backlog-plan` and
`hermes:implementation-handoff` can emit
`prepare_enterprise_shadow_contract_review`, an offline work order to review
Sportradar, Betradar, TXODDS and Betfair sample-payload requirements. That
handoff keeps provider calls, live API calls and execution paths disabled and
requires budget-chain/operator review before any feed activation.

`hermes:grand-slam-scoreline-forecast` is the preferred packet for the concrete
Grand Slam match-day output: projected winner plus plausible set scoreline.
It consumes internal FastAPI prediction rows only, maps ATP Grand Slam singles
to BO5 scorelines (`3-0/3-1/3-2`) and WTA Grand Slam singles to BO3 scorelines
(`2-0/2-1`), and reports data-quality gaps before claiming readiness. It does
not predict exact game scores and cannot call providers, scrape, create paper
orders, or submit real orders.

`hermes:grand-slam-mission` is the product-level mission packet. It answers:
"Can Hermes supervise Grand Slam predictions today, and what is the next safe
step?" It compiles operational truth, Grand Slam readiness, scoreline forecast,
historical backfill, collection cadence, quota throttle, live-controller
decisions and learning review into phases. It may point to protected paper
autopilot when all backend gates are paper-ready, but the mission packet itself
is read-only and cannot create orders, call providers, scrape, or run
LLM-per-tick reasoning.

`hermes:grand-slam-mission-ledger` is the local trace for that product mission.
It appends compact JSONL rows with active phase, Grand Slam status, visible
matches, prediction rows, next safe command, live-controller status, quota level
and learning status while marking all execution counters false.

`hermes:grand-slam-mission-ledger-report` is the read-only summary over that
trace. It identifies repeated Grand Slam mission phases and recommends the next
non-executing review command so backlog work follows observed match-day
readiness gaps instead of ad hoc operator memory.

`hermes:trigger-policy` is the preferred packet for deciding when Hermes should
wake up. It turns runtime, events, source-discovery, Grand Slam readiness, quota
and learning state into debounced triggers for cron, Telegram, dashboard,
Cloudflare Agent and the OpenClaw gateway. It reports commands but does not run
them, so every channel gets the same event-driven policy without asking an LLM
to watch every tick. A partial Hermes runtime emits two separate wakeups:
bounded runtime diagnostics first, then the read-only operator summary route.

`hermes:ops-compiler` is the preferred all-in-one payload for external agent
channels. It compiles trigger policy, source discovery, Grand Slam readiness,
autonomy brief, operator packet and model routing into a single JSON object that
a channel can summarize without re-running every command or inferring safety
boundaries.

`hermes:capability-audit` is the objective audit packet. It scores Hermes
against the current operating goal across runtime/channels, safe source
discovery, live collection, live statistics, protected paper autopilot,
learning review, external-agent orchestration, budget-chain state and
enterprise-gate state. It may report a next safe command, but it does not run
that command and keeps provider spend, paper orders and real execution behind
backend/operator gates.

`hermes:autonomy-gates` is the escalation proof packet. It converts capability
audit, activation-checklist, event-router, and budget-chain evidence into
ordered gates: `observe`, `channel_ready`, `cron_ready`, `paper_ready`,
`learning_ready`, and `enterprise_review`. Channels should use `active_ceiling`
and `next_required_gate` instead of inferring autonomy from scattered command
outputs. The command is read-only and cannot create paper orders by itself.

`hermes:experiment-lab` is the research-to-action packet. It asks which safe
Hermes experiment has the best expected operational value right now, then ranks
runtime recovery, source discovery, live collection cadence, paper autopilot
rehearsal, learning review, and enterprise eligibility. The packet includes
hypotheses, prerequisites, `success_metrics`, evidence and command previews,
but it does not run experiments, spend provider quota or create orders. It also
uses local `backlog-plan` evidence so repeated live-controller freezes,
source-route decisions, throttles or provider candidates can become the next
safe experiment.

`hermes:experiment-ledger` is the local trace for those experiment decisions.
It appends JSONL rows under `hermes/runs/` with the lab payload, active ceiling,
ready experiment ids, next experiment id and `experiment_command_executed=false`.
This gives the operation evidence about which experiments keep blocking value
without giving Hermes permission to run them.

`hermes:experiment-ledger-report` is the read-only quality summary over that
experiment ledger. It identifies repeated experiment recommendations and active
ceilings, so the repo can prioritize changes from observed operating evidence
instead of intuition.

`hermes:backlog-plan` is the evidence-to-backlog compiler. It reads only local
operator, mission, experiment, live-controller, source-route and Grand Slam
mission ledger reports, then emits implementation priorities with target files,
validation commands, acceptance evidence and blocked gates. It also includes
`source_discovery_completion`, a deterministic proof that the offline backfill
dossier has enough source classes, license-review gates and forbidden-use
markers. When that proof is complete, stale ledger entries cannot keep
reopening `expand_allowed_source_backfill`. It does not edit code or run the
listed validation commands.

`hermes:implementation-handoff` is the bridge from backlog evidence to actual
Codex/Hermes engineering work. It turns the current `backlog-plan` priority
into one read-only work order with target files, suggested steps, validation
commands, acceptance criteria, prohibited changes and safety flags. It does not
edit files, spend provider quota, create paper orders, activate cron jobs or
mutate runtime services.
For enterprise-shadow readiness, the handoff converts
`prepare_enterprise_shadow_contract_review` into explicit steps: review the
enterprise-readiness provider matrix, map the Sportradar/Betradar/TXODDS/Betfair
sample payload requirements, keep due diligence offline until budget-chain and
operator review pass, and prove no provider API calls, live API calls or
execution paths are enabled.
The concrete step IDs are
`review_enterprise_readiness_shadow_provider_matrix`,
`map_sportradar_betradar_txodds_and_betfair_sample_payload_requirements`, and
`prove_no_provider_api_calls_live_api_calls_or_execution_paths_are_enabled`.
For source-route pressure, the handoff converts
`harden_source_route_feedback_loop` into explicit steps: review the ledger
report, map the top route to replay/internal or licensed adapter contracts,
keep scraping/sportsbook automation/bypass routes blocked, and prove
route/provider/bypass counters remain zero.
`hermes:replay-backfill-contract` is the first concrete adapter contract for
that path: it maps `replay_backfill` to
`replay_backfill_to_operational_truth` using persisted matches, score/odds
ticks, signals, paper orders and replay lab gates. It is read-only and reports
implementation evidence only.
Hermes also reads `GET /api/v1/replay/backfill-evidence` as backend
`ReplayBackfillEvidence`, so the contract can use canonical FastAPI evidence
for closing-line proxy seeds, paper-learning seeds and signal-gate regression
without spending provider quota.
The weekly learning review additionally reads Model Lab's
`replay_backfill_seed_status`, `replay_backfill_seed_count`,
`can_use_replay_backfill_for_rehearsal` and
`can_promote_model_from_replay_seeds=false` fields. This lets Hermes explain
ready replay seeds without treating them as promotion evidence; if no production
dataset exists it reports `replay_backfill_seeds_rehearsal_only`.

`hermes:operator-packet` is the compact channel packet. It derives from
safe-loop and emits priority, headline, a short message, the next safe command,
cost guard, read-only runtime route and safety flags for Telegram/OpenClaw
without executing anything.

`hermes:operator-ledger` is the local trace for those channel decisions. It
appends JSONL rows under `hermes/runs/` with `outcome=observed` and
`action_executed=false`, giving us data to evaluate Hermes recommendation
quality without granting more authority.

`hermes:operator-ledger-report` is the read-only quality summary over that
ledger. It identifies recurrent blockers and repeated next actions so the
backend can be improved from observed operations instead of intuition.

`hermes:autonomy-effectiveness` is the closed-loop measurement packet. It reads
local experiment, operator, mission, live-controller, source-route and Grand
Slam mission ledger reports, scores evidence volume and repeated blockers, flags any
protected-action claim, and recommends either more evidence, safety review or
`implementation-handoff`. It does not execute the handoff or any reported
command. The ops compiler, implementation handoff and scheduler/cron proposal
consume the same packet so evidence-driven implementation work is visible in
the operating graph without raising autonomy permissions.

`hermes:runtime-fix-priorities` maps those recurrent blockers into a ranked
non-mutating remediation queue. It is the bridge from observation to local
operator action without giving Hermes write authority.

`hermes:scheduler-rehearsal` is the dry-run bridge between safe-loop output and
real Hermes cron configuration. It computes proposed intervals, chooses the
next safe tick, and appends a local JSONL audit row under `hermes/runs/`. It
does not create cron jobs, execute scheduled commands, create paper orders, or
spend provider quota. Grand Slam readiness is scheduled as a read-only lane:
low-frequency when no Slam is active, tighter during Slam windows, and five
minutes when persisted Grand Slam rows are paper-ready. Enterprise readiness is
also scheduled as a read-only gate before the lower-frequency enterprise
accuracy plan, so provider review stays behind backend evidence.

`hermes:cron-proposal` turns the rehearsal into a local review manifest with
exact `hermes cron add` command previews. It is still non-mutating: it does not
call `hermes cron add`, and it excludes autopilot, provider-smoke, admin-token,
quota-consuming, and order-creating jobs. The Grand Slam readiness job is
allowed only because it calls the read-only packet and never creates orders.

`hermes:activation-checklist` is the last non-mutating gate before a human
creates any Hermes cron jobs. It requires clean runtime diagnostics, Telegram
allowlist, private-access allowlist, local admin secret presence, a safe cron
manifest, zero executed rehearsal commands, and real-execution hard block. It
prints manual activation commands only when every gate passes.

`hermes:runtime-fix-plan` is the read-only remediation packet for blocked
activation. It reuses the same gates in memory, does not write the proposal
manifest, does not execute repair/restart/install commands, and returns only
ordered manual/local diagnostic actions.
Runtime findings from `hermes:runtime-check` flow into this packet, including
gateway service status, doctor timeout/failure state, auth notes, messaging
notes, and manual commands marked with `mutates_runtime_if_run` when they would
alter Hermes if an operator ran them.
`runtime-check` also emits `capability_summary` and `autonomy_impact`, which
separate "usable for read-only summaries/ledgers" from "eligible for cron,
channels, paper autopilot or execution". A running gateway plus configured
model/provider is useful evidence, but it is not a bypass around doctor,
allowlist, admin-token, provider-quota or real-execution gates.
Safe-loop now maps that state to `runtime_partial`, and operator/ops-compiler
packets expose `read_only_runtime_route` so a partially usable Hermes can still
produce summaries and ledgers while every protected action stays blocked.
Specific runtime diagnostics outrank the generic runtime recheck. If the
gateway is running but `hermes doctor` times out, the next action becomes
`npm run hermes:doctor-triage`; if the gateway is stopped, manual gateway review
outranks another broad runtime check. The packet still does not start services.
When `doctor-triage` also times out with
`HERMES_DOCTOR_TRIAGE_TIMEOUT_MS=5000`, it classifies the issue as persistent
instead of recommending the same bounded recheck again. Any `hermes update`
route is emitted only as a manual operator review with
`mutates_runtime_if_run=true`.
Doctor timeout packets preserve sanitized partial progress in
`runtime_findings.doctor_progress`: sections seen, last section, whether API
Connectivity was reached, and the connectivity-check count. If API Connectivity
was reached before timeout, the likely cause becomes
`persistent_doctor_api_connectivity_timeout`, which pushes operators toward
connectivity/update review instead of repeating blind probes.
The same progress drives `runtime-fix-plan`: after a full 5000ms runtime probe,
it emits `runtime_api_connectivity_timeout_review` or
`runtime_persistent_doctor_timeout_review` rather than routing back to the
shorter generic doctor triage.

`hermes:events` is the preferred input for Hermes cron/webhook dispatch. It
turns the internal intelligence packet into compact events such as
`cursor_resync_required`, `provider_health_degraded`,
`budget_chain_next_step`, `learning_data_collection`,
`paper_autopilot_candidate`, and `real_execution_safety_violation`. Each event
includes one allowed command, whether an admin token is required, and whether
paper orders may be created. It never marks real order submission as allowed.
Enterprise provider cursors stay deferred while `enterprise_eligible=false`,
so budget operations are not escalated to `cursor_resync_required` because of
Sportradar/Betradar/TXODDS contracts that are intentionally inactive.

`hermes:unblock-plan` is the preferred blocked-state packet. It ranks safe
lanes by priority and labels whether each lane needs a human, writes local
state, consumes provider quota, or is deferred. It does not execute commands.

`hermes:runtime-check` is the local diagnostic packet for the first unblock
lane. It runs the Hermes CLI in read-only mode and captures status/doctor
evidence without changing any LaunchAgent, daemon, gateway, or provider config.
Its capability summary lets Hermes keep producing internal operator packets
from a partial runtime while preserving the observe-only ceiling.

`hermes:playbook` is the preferred human/operator handoff. It groups the event
state into phases: `observe`, `stabilize_data`, `budget_chain`,
`collect_learning`, `paper_autopilot`, and `learning_review`. Each step includes
a command, write/live-call flags, admin-token requirement, and a hard
`can_submit_real_orders=false` value. Hermes can use it as a low-cost dispatch
map without asking an LLM to infer safety gates from raw status.

`hermes:live-stats` is the preferred high-frequency packet. It produces
health scores for collection, processing, signals and learning; freshness
statistics from persisted match state; cost utilization; and a sampling policy
such as `cold_safe_mode`, `budget_chain_polling`, `paper_signal_watch`, or
`learning_collection`. It keeps `llm_per_tick_allowed=false` so Hermes can be
fast and cheap while Python/Postgres keep doing the tick math.
It also emits `feature_contract.id=live_stats_feature_contract`, an internal
API-only contract that maps match freshness, live signals, provider health,
cursor/data-quality state, cost profile, and Model Lab readiness into
`LiveFeatureSnapshotSeed`, `CollectionCadenceSeed`, `SignalGateContextSeed`,
and `LearningReviewSeed`. This is the safe "jailbreak" route for live
statistics: no live scoreboard scraping, no provider quota spend without an
operator, no browser automation, and no LLM per tick.
`hermes:source-intake-plan` also exposes this route as
`live_stats_feature_intake_contract` inside `intake_contracts` whenever
`route:live_statistics` is allowed. That makes live-stat feature extraction a
first-class internal intake contract while preserving
`provider_api_call_allowed=false`, `live_api_calls=false`,
`dataset_fetch_allowed=false`, `browser_scraping_allowed=false`, and
`llm_per_tick_allowed=false`.
`hermes:source-intake-ledger` records these concrete contract IDs as
`allowed_contract_detail_ids`; `hermes:source-intake-ledger-report` summarizes
them with `allowed_contract_detail_counts` and `top_allowed_contract_detail`.
This lets backlog and implementation-handoff turn repeated source-intake
evidence into work on the exact internal feature contract.

`hermes:live-window` is the preferred go/no-go packet for an active live
window. It reuses the deterministic event and live-stats gates, returns
`paper_ready`, `monitor`, `blocked`, or `safety_stop`, and keeps
`next_action.executes_now=false` so cron or Telegram can report the decision
without creating orders or spending quota.

`hermes:match-pulse` is the preferred per-match watchlist packet. It ranks live
matches by attention priority using freshness, pressure state, edge, signal
status, and the global live-window gate. It lets Hermes focus collection and
human attention on the right matches without running an LLM per tick or
creating orders directly.

`hermes:collection-plan` is the preferred cadence packet. It converts the
watchlist into desired polling lanes such as `hot_watch`, `warm_watch`,
`repair_watch`, and `frozen`, while keeping provider ingestion as an explicit
operator candidate rather than an executed action.

`hermes:quota-plan` is the preferred budget throttle packet. It applies monthly
spend utilization guardrails to the collection plan, slows or freezes desired
cadence when needed, and suppresses provider command candidates while the guard
is active.

`hermes:live-controller` is the preferred live-data control packet. It compiles
live-window, match-pulse, collection-plan, quota-plan and source-route-matrix
into one operator decision: freeze collection, throttle internal watch, observe
internal state, keep a provider command as operator-only candidate, or request
protected paper autopilot through the backend. It is the right packet for
Hermes/Telegram/Cloudflare/OpenClaw-style channels because it avoids stitching
together multiple command outputs and weakening the safety contract. It remains
read-only: no provider quota spend, no provider command execution, no paper
order creation by itself, no real execution, and no LLM per tick.
The packet also emits a deterministic `feedback_plan`: normalized blocker IDs,
safe repair commands, and evidence strings that explain why collection is
frozen, throttled, or ready. The repair queue is non-executing and internal
only, so repeated live-controller freezes can become backlog evidence without
scraping, provider spend, paper order creation, or real execution.
The controller consumes `live_stats_feature_contract` from `hermes:live-stats`
as a first-class gate: blocked contracts freeze feature ingestion, degraded
contracts route to freshness/signal repair, and ready contracts can feed
match-pulse, collection-plan and learning review. Ledger rows persist
`feature_contract_status`, `feedback_blocker_ids`, and
`feedback_next_action_ids` so repeated contract degradation or stale data
blockers become backlog evidence without running collection commands. The
non-executing action names are `freeze_feature_ingestion` and
`repair_live_feature_contract`.

`hermes:live-controller-ledger` is the local trace for those live-control
decisions. It appends JSONL rows with the controller packet, chosen action,
next safe command, provider candidate, throttle level, source route and safety
snapshot while marking `action_executed=false`,
`provider_command_executed=false`, and `paper_order_created=false`.

`hermes:live-controller-ledger-report` is the read-only quality summary over
that trace. It identifies repeated freeze/throttle/paper-candidate decisions,
recurring next commands, recurring provider candidates, top feedback blockers,
and top safe repair actions, so the repo can prioritize improvements from
observed live-control evidence without granting Hermes execution authority.
It normalizes legacy rows that only contain the nested `controller` packet, so
older `freeze_collection` records still produce `blocked_throttle_count`,
`top_feedback_blocker`, `top_feedback_next_action`, and
`feedback_repair_ready` before a new controller ledger row is written.
`hermes:implementation-handoff` must preserve those top feedback fields in the
work order acceptance criteria and validation commands, so a repeated
live-controller freeze becomes a concrete internal repair task instead of a
generic "collect more evidence" loop.

`hermes:live-repair-plan` is the next-step selector for those feedback
contracts. It reads the current live-controller packet and the ledger report,
then sorts safe repair actions by deterministic priority and repeated ledger
evidence. The selected repair is still non-executing; it is meant for Codex,
Hermes, Telegram or an operator to decide the next implementation task without
spending provider quota, creating paper orders, or enabling real execution.
The plan also exposes `repair_alignment`, which compares the selected safe
repair against the ledger's repeated `top_feedback_next_action` and
`top_feedback_blocker`. When current controller priority differs from repeated
feedback, the status becomes
`controller_priority_differs_from_repeated_feedback` and requires operator or
Codex review before the backlog treats it as resolved.
`hermes:backlog-plan` builds the same alignment preview from the latest
live-controller ledger row and exposes it as `evidence.live_repair_plan`, so
`hermes:implementation-handoff` carries the recommended repair, selected repair
and review requirement without writing a live-repair ledger row.

`hermes:live-repair-ledger` persists that selected repair as local JSONL with
`action_executed=false`, `repair_command_executed=false`,
`provider_command_executed=false`, and `paper_order_created=false`. The
matching `hermes:live-repair-ledger-report` summarizes repeated selected
repairs, commands, blockers and alignment statuses so `hermes:backlog-plan` can
emit `harden_live_repair_feedback_loop` when the same safe internal repair keeps
blocking live collection or the selected repair repeatedly diverges from the
historical feedback. This gives Hermes a feedback loop without granting it
permission to run the repair command, call providers, create paper orders or
touch real execution. The autonomy packet exposes this lane as
`live_repair_records` and the backlog acceptance evidence must keep
`repair_command_executed_count=0`.

`hermes:backlog-plan` also consumes the Grand Slam mission ledger report. When
Grand Slam visibility, model-input or paper-learning phases repeat, it emits a
non-executing `harden_grand_slam_prediction_loop` priority before enterprise
work is considered.

`hermes:learning-review` is the preferred weekly packet. It packages the
learning gates, ROI, CLV, settled paper volume, production training examples,
budget-chain completion and high-severity blockers for a `gpt-5.5` review. It
does not promote a model and always keeps real execution blocked.

`hermes:budget-chain` is the preferred provider-onboarding packet. It turns
`api_onboarding.current_step` and its step list into a dry-run smoke plan:
provider, capability, prerequisites, exact command, and quota policy. It never
runs provider APIs by default; the operator must intentionally execute the
reported command when ready.

`hermes:provider-smoke` is the narrow local gate for that intentional step. Its
default output is blocked dry-run JSON; `--execute-provider-call` is required
before it runs a supported provider smoke. That flag is operator-only and must
not be used in scheduled Hermes jobs.

`hermes:provider-smoke-ledger` persists the dry-run provider-smoke decision as
local JSONL with `provider_command_executed=false` and `quota_spent=false`.
`hermes:provider-smoke-ledger-report` summarizes repeated pending provider
smokes so the operator can see which paid smoke is ready for explicit local
confirmation, without spending quota or turning the budget chain into
automation. Repeated dry-runs feed
`harden_provider_smoke_confirmation_loop` in `hermes:backlog-plan`, so Codex can
improve instructions, review gates or operator packets while keeping
`provider_command_executed_count=0` and `quota_spent_count=0`.

## Evidence Required Before More Autonomy

- `npm run api:check:operational-truth -- --pretty` passes.
- `npm run hermes:intelligence` returns no blockers.
- `REAL_EXECUTION_HARD_BLOCK=true` and `can_submit_real_orders=false`.
- Provider cursors do not require resync.
- Paper orders and agent runs persist across API restart.
- Model Lab uses persisted `training_examples`, not synthetic sample rows.

## External Research Used

- Hermes Agent documentation: self-improving agent with skills, memory, cron,
  gateway, tools and provider flexibility.
- Hermes CLI reference: `cron`, `webhook`, `skills`, `memory`, `gateway`,
  `security`, `profile`, and `tools` are native command families.
- Hermes webhook guide: external events can trigger agent runs, but this project
  should route those events into internal FastAPI checks rather than direct
  provider or betting actions.
- OpenClaw skills and cron docs: skills should narrow tool use, and scheduled
  jobs should wake Hermes with explicit command/report instructions rather than
  broad shell freedom.
- Cloudflare Agents scheduled tasks: scheduled agents can run durable tasks, so
  any future Cloudflare mirror should call internal read-only packets first and
  keep stateful writes behind backend gates.
- OpenAI Agents SDK guardrails: tool guardrails justify keeping provider calls,
  paper orders, model promotion and real execution as deterministic backend
  decisions, not direct LLM actions.
- NATS JetStream/event-store docs: persisted streams and replay support the
  budget-first rule that collection and model changes should be validated from
  stored ticks before live spend or enterprise escalation.
