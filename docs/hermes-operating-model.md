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

Hermes can add leverage in six places:

1. Intelligence packets: combine provider health, cursor status, cost, data
   quality, paper performance, bankroll, signals, replay lab and onboarding
   state into one safe JSON packet.
2. Event routing: cron/webhook/gateway can wake Hermes only on useful events
   such as feed gaps, stale odds, critical anomalies, quota risk, new entry
   signals, or post-day settlement windows.
3. Model routing: cheap model for routine triage; strong model only for severe
   anomaly, weekly learning review, and real-execution-readiness reports.
4. Memory: preserve operating lessons, provider quirks, recurring blockers and
   review outcomes, while keeping provider secrets outside prompts.
5. Skill reuse: the `tennis-edge-ops` skill gives Hermes a narrow, repeatable
   command surface instead of broad shell improvisation.
6. Human reachability: Telegram/dashboard can surface concise actions without
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

Run `npm run hermes:intelligence`, `npm run hermes:events` and
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
- Every 5 minutes during active windows: `npm run hermes:events`.
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
