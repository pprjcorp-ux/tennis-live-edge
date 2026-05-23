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
  audit events.
- `openclaw/`: local-only OpenClaw skill, policy example, and cron examples.

## Runtime Flow

1. Provider adapters load fixtures, score state, odds, and market metadata.
2. Normalization maps provider players/matches/markets into canonical IDs.
3. Feature engines compute pre-match, live, market, data-quality, and risk
   features.
4. Models produce calibrated probabilities and explanations.
5. Signal gates compare model probability with no-vig market probability.
6. Risk gates allow, monitor, block, or abstain.
7. Paper execution records order decisions, fills, settlement, CLV, ROI, and
   calibration buckets.
8. Strategy Learning Lab backtests champion/challenger strategy candidates with
   paper bankroll metrics before any promotion review.

## Local Verification

```bash
npm run api:test
npm --prefix apps/web run build
python3 scripts/check_private_runtime.py
```

Use `npm run dev` for local API + dashboard.
