# Common Architecture

Tennis Live Edge is a monorepo with a FastAPI backend and a Next.js dashboard.
Both canonical branches share the same core code; runtime profiles and docs
decide whether the system behaves as budget or enterprise.

## Services

- `services/api`: FastAPI API, provider adapters, feature/model/signal engines,
  replay/backtest services, execution safety gates, and Agent Ops endpoints.
- `apps/web`: local dashboard for live board, data health, model lab, paper
  trading, risk/bankroll, entity resolution, and OpenClaw Autopilot.
- `infra/schema.sql`: event-sourced Postgres/Timescale schema for raw payloads,
  score/odds ticks, predictions, signals, paper orders, model versions, and
  execution controls/audit events.
- `openclaw/`: local-only OpenClaw skill, policy example, and cron examples.

## Runtime Flow

1. `LiveIngestionPipeline` builds the operational snapshot for the target date.
   `OperationalSession` is the operator-facing read boundary: when a provider
   snapshot was persisted, it reloads canonical `latest_analyses` from
   Postgres/Timescale before serving the dashboard, match detail, or live
   signals. Raw score/live or archive provider exceptions become
   `provider_warnings`, so failed feeds degrade ingestion runs and fall back to
   persisted state instead of silently looking empty. Persisted fallback
   snapshots are still re-gated before display.
2. Provider adapters load fixtures, score state, odds, and market metadata.
3. Raw provider/canonical payload lineage is persisted before decision snapshots.
4. Normalization maps provider players/matches/markets into canonical IDs.
5. Feature engines compute pre-match, live, market, data-quality, and risk
   features.
6. Models produce calibrated probabilities and explanations.
7. Signal gates compare model probability with no-vig market probability.
8. Risk gates allow, monitor, block, or abstain.
9. Postgres/Timescale serves persisted canonical matches, freshness metadata,
   predictions, and signals when upstream providers are down.
   Entity-resolution conflicts are read from the persisted review queue in live
   mode; sample conflicts are demo-only.
   Data-quality rows are likewise persisted-only in live mode; sample quality
   snapshots are demo-only.
10. Paper execution records order decisions, deterministic fills, closing-line
    snapshots, settlement, CLV, ROI, segmented performance, and calibration
   buckets. The dashboard exposes auto-settlement so persisted final scores and
   pre-result closing odds can close paper orders and refresh performance without
   manual win/loss marking. Paper performance counts only settled orders with
   positive `matched_stake`, matching Model Lab's training dataset, so unmatched
   or zero-exposure orders cannot inflate ROI, CLV, drawdown, or segment stats.
11. Settled paper orders become `training_examples` keyed by model version and
    decision timestamp. Budget live backtests use `live_budget_v1`, matching the
    persisted `feature_snapshots.feature_set` written by the ingestion pipeline,
    so Model Lab does not mix rows from different feature definitions. Rows with
    zero or invalid stake are excluded from the training dataset so ROI and
    drawdown are always measured against real matched exposure.
12. Model Lab backtests read persisted training examples first, compute
    walk-forward ROI, CLV, Brier, log loss, calibration error, and drawdown,
    then save model registry and calibration reports. Synthetic backtests remain
    and synthetic calibration reports remain only as `sample`/dev fallbacks; live
    mode returns explicit blocked/not-found states until persisted
    `training_examples` and calibration reports exist.
13. Live readiness reads the persisted settled `training_examples` count and
    surfaces Model Lab readiness as a warning/pass check, rather than discovering
    missing datasets only when a backtest is requested.
14. Model Lab readiness is a derived read-model inside
    `OperationalStateSnapshot`; it exposes `training_examples` as the dataset
    source, the active model/feature set, settled example count, and whether a
    live backtest can run without synthetic fallback.
15. API onboarding is a derived read-model inside `OperationalStateSnapshot`.
    It keeps provider setup ordered as TheOddsAPI REST/archive, API-Tennis
    score/livescore, Odds-API.io websocket, then deferred enterprise feeds, with
    each step blocked until the persisted core and prerequisites are healthy.
16. Provider mode is exposed as a matrix inside `OperationalStateSnapshot`, not
    just as a single label. The matrix lists `sample`, `replay`,
    `live_without_keys`, and `live_with_keys`, with active status, entry gate,
    evidence, blockers, and next action so the dashboard cannot confuse replay
    rehearsal with live eligibility. `replay` is an offline provider mode:
    budget adapters use fake fixtures/snapshots and must not spend quota or open
    live websockets even when keys are present.
17. Replay Lab readiness is a derived read-model inside
    `OperationalStateSnapshot`. It exposes `budget_replay_fixtures` as the fake
    API layer for ScoreProviderAdapter, OddsProviderAdapter, and
    ArchiveOddsProviderAdapter, including healthy/gap/resync scenarios, so live
    provider keys are added only after the same contracts pass without cost.
    A budget adapter contract matrix runs without live keys and requires each
    adapter to output the canonical internal types: `RawProviderPayload`,
    `CanonicalMatch`, `ScoreTick`, `OddsTick`, `ProviderCursor`, and
    `ProviderLatency`.
    `POST /api/v1/replay/contracts/run` is the aggregate rehearsal endpoint: it
    runs the healthy, gap, and `resync_required` budget scenarios from fixture
    seeds, records a `replay_contract_run`, and returns adapter, input, and
    output contract evidence before any paid provider key is introduced.
    In live mode, replay does not silently fall back to sample payloads; an
    admin replay request must set `use_fixture_seed=true` to seed fake provider
    payloads for rehearsal without consuming live provider quota. Replay runs
    that receive unsupported or unparseable provider payloads are marked
    degraded in both the API response and ingestion journal rather than
    completing silently with zero useful ticks.
18. Live model registry reads persisted `model_versions`; without persisted
    metrics it exposes only a clearly unvalidated runtime default instead of
    demo ROI/CLV.
19. Live execution status derives kill-switch state from persisted
    `execution_controls`; if that state cannot be read or written it fails
    closed instead of trusting process memory.
20. OpenClaw Agent Ops calls internal APIs only; autopilot runs and any created
    paper orders are persisted so restart recovery includes the operational
    audit trail.

## Local Verification

```bash
npm run api:test
npm --prefix apps/web run build
python3 scripts/check_private_runtime.py
```

Use `npm run dev` for local API + dashboard.
