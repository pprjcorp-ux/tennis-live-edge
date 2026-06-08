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
10. Paper execution records order decisions, deterministic fills, closing-line
   snapshots, settlement, CLV, ROI, segmented performance, and calibration
   buckets.
11. Settled paper orders become `training_examples` keyed by model version and
    decision timestamp.
12. Model Lab backtests read persisted training examples first, compute
    walk-forward ROI, CLV, Brier, log loss, calibration error, and drawdown,
    then save model registry and calibration reports. Synthetic backtests remain
    only as a `sample`/dev fallback; live mode returns an explicit blocked state
    until persisted `training_examples` exist.
13. OpenClaw Agent Ops calls internal APIs only; autopilot runs and any created
    paper orders are persisted so restart recovery includes the operational
    audit trail.

## Local Verification

```bash
npm run api:test
npm --prefix apps/web run build
python3 scripts/check_private_runtime.py
```

Use `npm run dev` for local API + dashboard.
