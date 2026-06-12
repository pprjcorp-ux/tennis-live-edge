# Strategic Refactor Plan

## Objective

Tennis Live Edge exists to operate as a private, local-first tennis trading
intelligence system. Its job is not to predict every match or maximize raw hit
rate. Its job is to identify actionable positive expected value, abstain when
the data is weak, record every decision, and improve from measured paper
outcomes without enabling unsafe real-money execution by default.

The real product loop is:

```text
live data -> canonical state -> calibrated probability -> edge/risk decision
-> paper order -> settlement/CLV/ROI -> model evaluation -> controlled promotion
```

Everything else in the system should serve that loop.

## Current State

The repository already has the right macro shape:

- FastAPI backend in `services/api`.
- Next.js dashboard in `apps/web`.
- Postgres/Timescale schema in `infra/schema.sql`.
- Budget and enterprise operating profiles.
- Provider adapters for API-Tennis, TheOddsAPI, Odds-API.io, Sportradar,
  Betradar UOF, TXODDS, and future Betfair execution.
- OpenClaw Agent Ops skill and docs.
- Execution safety defaults: `EXECUTION_ENABLED=false`,
  `EXECUTION_STAGE=paper`, and `REAL_EXECUTION_HARD_BLOCK=true`.

The main implementation weakness is that too much operational flow currently
passes through `AnalysisRepository`. That was pragmatic for v1, but the next
version should split the system into explicit pipelines so the data, model,
signal, paper execution, and learning layers can be verified independently.

## Available Resources

### Local Runtime

- Mac-local project root: `/Users/ppfahd/Workspace/projects/tennis-live-edge`.
- Docker Compose for Postgres/Timescale.
- LaunchAgent-managed local API/web runtime.
- Public GitHub repo with canonical `budget` and `enterprise` branches.
- Existing CI workflow on pushes/PRs to both canonical branches.

### OpenClaw

Observed local OpenClaw runtime:

- Version: `2026.5.28`.
- Gateway: local loopback `ws://127.0.0.1:18789`, reachable.
- Agents available: main operator, ops, security, QA, research, browser, and
  builder-oriented workspaces.
- Existing Tennis Edge skill: `openclaw/skills/tennis-edge-ops`.

Use OpenClaw as an operations layer:

- daily briefing;
- feed/cursor anomaly monitoring;
- paper-autopilot through internal APIs only;
- weekly ROI/CLV/calibration reports;
- readiness reports after enough paper data;
- sub-agent research and QA on bounded tasks.

Do not use OpenClaw for:

- model math;
- direct Betfair calls;
- sportsbook browser automation;
- reading `.env`;
- storing secrets;
- changing execution flags automatically.

### Cloudflare

Cloudflare Tunnel + Access should remain the private exposure layer:

- dashboard/API stay bound to localhost;
- tunnel maps private hostnames to local services;
- Access allowlists the operator identity;
- no provider secrets are exposed to the browser bundle.

### Data Providers

Budget path:

- API-Tennis for fixtures/livescore/point data.
- Odds-API.io WebSocket for live odds, using `seq`, `lastSeq`, and
  `resync_required` handling.
- TheOddsAPI for fallback/archive/comparison.

Enterprise path:

- Sportradar Tennis live timelines for higher-quality score/timeline data.
- Betradar UOF for market status, betstop, settlement, and timeline metadata.
- TXODDS for independent in-running odds.

Betfair remains future execution infrastructure only. Real order submission
must stay blocked until a separate compliance and operational readiness task.

## Best Next Version

The best continuation is not a full rewrite. It is a refactor into a
pipeline-first architecture while preserving the current API surface.

Recommended target name:

```text
Tennis Live Edge v2: Paper Trading Operating System
```

Scope:

- Budget branch becomes the operational product.
- Enterprise branch becomes an extension profile, not a separate system.
- Real execution remains out of scope.
- Primary objective is 30-60 days of trustworthy paper trading data.

Success definition:

- Every live match has a canonical data state with freshness and provider
  lineage.
- Every signal can explain exactly why it was allowed, blocked, or abstained.
- Every paper order has a fill, settlement, CLV, P&L, and model version.
- Backtests are walk-forward and generated from persisted historical rows, not
  synthetic sample data.
- OpenClaw can operate and report, but cannot bypass deterministic backend
  gates.

## Refactor Architecture

### 1. Data Plane

Create explicit data ingestion boundaries:

```text
ProviderAdapter -> RawEventStore -> Normalizer -> CanonicalMatchStore
```

Implementation direction:

- keep provider parsing in `providers/`;
- add service-level ingestion runners rather than calling providers directly
  from `AnalysisRepository`;
- persist raw payloads before normalization;
- track source timestamp, ingest timestamp, provider cursor, checksum, and
  canonical entity conflicts;
- make stale/missing/gap states first-class data quality outputs.

### 2. Decision Plane

Create an immutable decision snapshot:

```text
FeatureSnapshot -> PredictionSnapshot -> SignalDecision -> RiskDecision
```

Implementation direction:

- features are computed as-of a specific timestamp;
- predictions reference feature snapshot and model version;
- signal/risk decisions store all thresholds and block reasons;
- dashboard reads decisions, not recalculated transient objects;
- no signal is actionable without a complete moneyline, score state, freshness
  proof, coverage eligibility, and cursor health.

### 3. Learning Plane

Promote the learning loop from docs to code:

```text
PaperOrder -> PaperFill -> Settlement -> TrainingExample -> BacktestRun
```

Implementation direction:

- generate training rows from settled paper decisions;
- store closing-line proxies separately from decision-time odds;
- calculate ROI, CLV, Brier, log loss, calibration error, and drawdown by
  model version;
- reject model promotion if hit rate improves but CLV, ROI, calibration, or
  drawdown deteriorates;
- never update model weights mid-match.

### 4. Agent Ops Plane

Keep OpenClaw as a bounded operator:

```text
Backend APIs -> OpenClaw Skill -> Briefing/Anomaly/Paper Autopilot/Reports
```

Implementation direction:

- add a backend `agent_runs` persistence table if it is not already fully
  persisted;
- have OpenClaw write run summaries through APIs, not files;
- route routine summaries to the cheaper model;
- route severe anomaly, promotion review, and real-readiness review to the
  critical model;
- require health checks before cron/autopilot runs.

## Recommended Milestones

### Milestone 1: Operational Truth

Goal: make persisted state the source of truth.

Current implementation status: persisted/replay source truth is enforced by
runtime checks. `OperationalStateSnapshot.source_summary` now exposes
per-match `match_freshness` rows, not just aggregate counts, so dashboard and
OpenClaw can audit whether each match is persisted, replay-backed, live, or
runtime-only before any signal is trusted.

Tasks:

- add ingestion job/service entrypoints for API-Tennis and TheOddsAPI;
- persist provider calls and normalized match states before analysis;
- expose data freshness per match;
- make dashboard use stored decisions where available;
- keep sample mode explicitly labeled as dev/sample.

Acceptance:

- restart does not lose matches, signals, orders, or backtest history;
- provider health reflects real calls and latency;
- local API can answer from persisted rows when providers are down.

### Milestone 2: Paper Trading Quality

Goal: make paper results realistic enough to evaluate edge.

Current implementation status: baseline complete for v2. Paper orders now
require `Entrada`, deterministic fills are persisted, closing-line snapshots are
recorded at settlement, and paper performance reports ROI/CLV by model, odds
bucket, surface, tour, and provider when enough settled orders exist.
Auto-settlement returns structured per-order `decisions` alongside readable
reasons, so skipped, failed, settled, and training-example-missing outcomes can
be audited by dashboard/OpenClaw after restart.

Tasks:

- implement deterministic paper fill policy with queue/slippage/commission;
- store closing-line snapshots;
- add settlement importer/resolver;
- add daily paper performance job;
- display CLV/ROI by model, odds bucket, surface, tour, and provider.

Acceptance:

- each paper order can be audited from signal to settlement;
- each auto-settlement candidate has a structured decision record;
- no paper order can be created from non-entry signals;
- ROI and CLV are calculated only from settled orders.

### Milestone 3: Model Lab v1

Goal: stop treating heuristics as a model lifecycle.

Current implementation status: complete for the first persistent v1 loop.
Settled paper orders now produce `training_examples` with model version,
decision timestamp, stake exposure, result, P&L, CLV, and calibration bucket.
Backtests prefer those persisted examples, save model/version records, and save
calibration reports. Synthetic reports are limited to `sample`/dev mode; live
mode blocks backtest runs until persisted `training_examples` exist.

Tasks:

- preserve current logic as `baseline_v0`;
- implement model registry as persisted records;
- add walk-forward dataset builder from settled historical rows;
- add calibration reports by bucket;
- create champion/challenger promotion gate.

Acceptance:

- backtest windows use `decision_ts`, which is derived from prediction/order
  time rather than settlement time;
- challenger promotion fails on CLV/ROI/calibration/drawdown regression;
- model version is visible on every prediction, persisted training example,
  backtest, registry entry, and paper result.

### Milestone 4: OpenClaw Operating Layer

Goal: add autonomy without weakening safety.

Current implementation status: first persistence slice complete. Agent Ops now
persists autopilot run logs, model routes, action summaries, and paper orders
created by OpenClaw through backend gates. The OpenClaw commands still use
Dashboard/API channels only and real execution remains blocked.

Tasks:

- install/copy the Tennis Edge skill into the OpenClaw runtime;
- add cron jobs for briefing, anomalies, post-day report, and weekly learning;
- add health preflight for gateway, API, database, and provider keys;
- persist agent run logs and model route/cost estimates.

Acceptance:

- OpenClaw can produce reports and create paper orders only through backend
  gates;
- unknown Telegram/remote channels cannot trigger admin actions;
- real execution remains blocked even if OpenClaw requests it.

### Milestone 5: Private Operator Surface

Goal: make the system usable from mobile/web privately.

Tasks:

- finish Cloudflare Tunnel + Access config;
- add private domain docs/env checks;
- split dashboard into focused pages or tabs;
- add status banners for sample/live/stale/provider-down states.

Acceptance:

- local ports are not publicly exposed;
- private URL requires Access;
- dashboard makes data mode and execution block impossible to miss.

## What To Defer

Defer these until the paper system proves data quality and positive CLV:

- Sportradar/Betradar/TXODDS contracts;
- Betfair live app key activation;
- real-money execution;
- multi-book arbitrage execution;
- heavy ML models trained on thin or synthetic data.

## Refactor Order

The highest-leverage order is:

1. persisted ingestion and canonical state;
2. decision snapshots and risk reasons;
3. realistic paper settlement and CLV;
4. model registry and walk-forward evaluation;
5. OpenClaw automation;
6. Cloudflare private operator surface;
7. enterprise feed adapters;
8. real-execution readiness review.

This order minimizes wasted spend. Enterprise feeds and execution APIs become
valuable only after the system can prove whether its own decisions beat the
market in paper mode.

## Operator Decision Needed

Before implementation starts, choose the operating posture for the next 2-4
weeks:

```text
Option A: Conservative
- budget feeds only
- no OpenClaw paper autopilot
- dashboard/manual paper orders
- best when validating correctness first

Option B: Paper Autopilot
- budget feeds only
- OpenClaw can create paper orders via backend gates
- daily/weekly reports enabled
- best default for collecting learning data

Option C: Enterprise Prep
- budget feeds plus enterprise adapter hardening
- no enterprise contracts yet
- prepares for Sportradar/TXODDS later
- best only if vendor activation is imminent
```

Recommended choice: **Option B: Paper Autopilot**.

## External References

- [OpenClaw docs](https://docs.openclaw.ai/tools): skills, tool policy,
  sandbox, cron, and local managed skills.
- [Cloudflare Access private apps](https://developers.cloudflare.com/cloudflare-one/applications/non-http/self-hosted-private-app/)
  and [Cloudflare Tunnel routing](https://developers.cloudflare.com/tunnel/routing/):
  private self-hosted apps through outbound tunnels and identity policies.
- [Odds-API.io WebSocket docs](https://docs.odds-api.io/guides/websockets):
  `lastSeq`, `seq`, and `resync_required`.
- [API-Tennis WebSocket docs](https://api-tennis.com/documentation_websocket.php):
  fixtures, livescore, point-by-point, and live updates.
- [TheOddsAPI docs](https://api.theoddsapi.com/docs): tennis odds,
  historical odds, best lines, and account usage.
- [Sportradar Tennis live timelines](https://developer.sportradar.com/tennis/reference/live-timelines):
  live match timelines and trial/production access levels.
- [Betfair Exchange API](https://developer.betfair.com/exchange-api/):
  future official exchange execution only.
