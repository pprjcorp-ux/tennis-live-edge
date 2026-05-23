# Strategy Learning Lab

The Strategy Learning Lab is the paper-first path for testing historical tennis
trading ideas before any model or staking rule can influence live decisions.
It keeps the system in analytical mode: no agent, LLM, browser automation, or
strategy optimizer can submit real-money orders.

## Data Loop

1. Provider payloads are stored as immutable source events.
2. Normalizers rebuild canonical matches, score ticks, point events, odds ticks,
   market suspensions, closing-line snapshots, and training examples.
3. The backtest engine reconstructs the decision state at each historical
   decision timestamp and prevents lookahead by using only data available at
   that timestamp.
4. Strategy candidates generate paper decisions with deterministic risk gates,
   slippage/commission assumptions, and bankroll-aware stake sizing.
5. Promotion remains gated by ROI, CLV, Brier score, calibration error, and max
   drawdown.

## Built-in Strategy IDs

- `value_edge`: baseline positive-EV strategy using the existing signal/risk
  gates.
- `clv_hunter`: requires a larger edge and non-low confidence, favoring entries
  expected to beat the closing line.
- `live_momentum`: only evaluates live matches where the score state is close
  enough for in-play pressure features to matter.
- `low_volatility`: avoids volatile states and requires normal operational
  thresholds.

## Stake Policies

- `fractional_kelly`: uses the signal stake fraction produced by the signal
  engine.
- `half_kelly`: halves the signal stake fraction for lower variance.
- `flat`: uses a capped flat 0.5% stake when the signal allows it.
- `cautious`: caps exposure at 0.3% for drawdown-sensitive experiments.

## API Example

```bash
curl -s -X POST http://localhost:8000/api/v1/backtests/run \
  -H "x-admin-token: $ADMIN_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "strategy_id": "clv_hunter",
    "stake_policy": "half_kelly",
    "market": "ML",
    "model_version": "prematch_ensemble_v1",
    "feature_set": "enterprise_v1",
    "bankroll_starting_balance": 10000,
    "walk_forward": true
  }'
```

The response includes classic model metrics plus strategy context, simulated
bankroll metrics, turnover, yield on turnover, hit rate, settled paper signals,
and a `strategy_breakdown` block that can be expanded when multi-strategy
portfolio tests are added.
