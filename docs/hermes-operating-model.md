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
- Every 1-5 minutes during active windows: `npm run hermes:live-stats`.
- Every 15 minutes during onboarding: `npm run hermes:budget-chain`.
- Every 5 minutes during active windows: `npm run hermes:events`.
- Every 5 minutes during active windows: `npm run hermes:playbook`.
- Every 15 minutes: `npm run hermes:preflight`.
- Every 15 minutes: `npm run hermes:anomalies`.
- Daily morning: `npm run hermes:ops:daily`.
- Weekly: strong-model learning/readiness review.

Do not run LLM analysis on every odds tick. Tick math belongs to Python and
Postgres; Hermes wakes only on summarized state or event thresholds.

`hermes:events` is the preferred input for Hermes cron/webhook dispatch. It
turns the internal intelligence packet into compact events such as
`cursor_resync_required`, `provider_health_degraded`,
`budget_chain_next_step`, `learning_data_collection`,
`paper_autopilot_candidate`, and `real_execution_safety_violation`. Each event
includes one allowed command, whether an admin token is required, and whether
paper orders may be created. It never marks real order submission as allowed.

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

`hermes:budget-chain` is the preferred provider-onboarding packet. It turns
`api_onboarding.current_step` and its step list into a dry-run smoke plan:
provider, capability, prerequisites, exact command, and quota policy. It never
runs provider APIs by default; the operator must intentionally execute the
reported command when ready.

`hermes:provider-smoke` is the narrow local gate for that intentional step. Its
default output is blocked dry-run JSON; `--execute-provider-call` is required
before it runs a supported provider smoke. That flag is operator-only and must
not be used in scheduled Hermes jobs.

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
