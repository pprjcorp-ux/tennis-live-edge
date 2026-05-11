# Enterprise Profile

The enterprise branch is the full local-first operating system for ROI/CLV
paper trading. It keeps real execution hard-blocked by default.

## Defaults

- `TENNIS_EDGE_RUNTIME_PROFILE=enterprise_roi_clv`
- `TENNIS_EDGE_MONTHLY_BUDGET_USD=6000`
- `ENTERPRISE_FEEDS_ENABLED=false` until contracts and payload validation pass
- `EXECUTION_ENABLED=false`
- `EXECUTION_STAGE=paper`
- `REAL_EXECUTION_HARD_BLOCK=true`
- `MODEL_CHAMPION_VERSION=baseline_v0`
- `MIN_PAPER_SIGNALS_FOR_REAL_REVIEW=500`
- `MIN_PAPER_DAYS_FOR_REAL_REVIEW=60`

## Enterprise Feeds

- Sportradar Tennis for score/live-state/timeline/retirement/delay data.
- Betradar UOF for market state, betstop, settlement, and suspensions.
- TXODDS for independent low-latency in-running odds.
- API-Tennis, Odds-API.io, and TheOddsAPI remain fallback/comparison sources.

## Model and Learning Loop

The current stack exposes `baseline_v0`, `prematch_ensemble_v1`, and
`live_markov_v1`. Candidate models can be promoted only after walk-forward
backtests improve or do not regress ROI, CLV, Brier, log loss, calibration, and
drawdown. No model weights change mid-match.
