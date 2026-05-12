# Historical Data and Self-Improving Strategy Loop

This document describes how Tennis Live Edge should use historical match data in
addition to live data, test strategies across available markets, and improve the
paper-trading policy while preserving the project safety rules.

## Goal

The operating goal is **bankroll management for risk-adjusted paper profit**:
maximize expected long-term bankroll growth from the data we provide, while
respecting drawdown limits, calibration quality, data-quality gates, and the
hard rule that no real-money execution is enabled by default.

The system must always be allowed to abstain. A strategy that cannot prove an
edge after fees, slippage, latency, and drawdown constraints should produce no
bet rather than force action.

## Historical Data Access

Historical data should enter the same event-sourced pipeline as live feeds so
that replay, backtests, and production scoring use comparable inputs.

1. **Collect historical source data** from licensed vendors, archived provider
   payloads, exported CSV/Parquet files, or manually curated datasets. Useful
   slices include fixtures, player metadata, point/score progression, odds
   ticks, market suspensions, closing lines, settlements, and bankroll state.
2. **Store immutable raw payloads** before transformation. Each imported event
   should keep provider name, source event ID, source timestamp, ingestion
   timestamp, payload type, checksum, and raw JSON body. This lets us audit and
   replay old matches exactly as they were seen.
3. **Normalize into canonical IDs** for players, tournaments, matches, and
   markets. Historical imports should go through the same entity-resolution
   rules as live data, with unresolved conflicts recorded for review.
4. **Persist canonical event streams** into score ticks, point events, odds
   ticks, market suspensions, closing line snapshots, feature snapshots,
   predictions, signals, paper orders, settlements, and training examples.
5. **Version every dataset snapshot** by date range, provider coverage, market
   coverage, and known data gaps. Model results are only comparable when the
   training and test windows are reproducible.

Recommended historical windows:

- **Cold start:** at least 2-3 seasons of ATP main-tour and Grand Slam singles
  data before trusting model metrics.
- **Live point models:** point-by-point history with server, score, tiebreak,
  break-point, retirement/walkover, and surface metadata.
- **Market models:** odds history with opening, pre-live, in-play, suspension,
  reopening, and closing prices per bookmaker/exchange.
- **Learning examples:** one row per decision opportunity, including model
  probability, no-vig market probability, closing probability, result, PnL, CLV,
  and calibration bucket.

## Replay and Backtest Workflow

The system should test strategy changes with a time-ordered loop, never by
training and evaluating on the same future information.

1. **Historical import job** loads raw provider events for a date range.
2. **Replay job** reconstructs each match chronologically from historical
   fixtures, scores, points, odds, and market states.
3. **Feature job** creates feature snapshots only from information available at
   that timestamp.
4. **Prediction job** runs the candidate model/strategy for each decision point.
5. **Signal job** compares model probability with no-vig market probability and
   applies market, data-quality, and risk gates.
6. **Paper execution simulator** models available odds, unmatched orders,
   slippage, commission, suspensions, and settlement.
7. **Evaluation job** computes ROI, CLV, Brier score, log loss, calibration
   error, hit rate by odds bucket, max drawdown, turnover, abstention rate, and
   performance by surface/tour/market/bookmaker.
8. **Promotion gate** promotes only candidates that beat the current champion
   across out-of-sample windows and pass risk limits.

The repository already has API surfaces for replay, walk-forward backtests,
calibration reports, model promotion, paper orders, paper settlement, bankroll
snapshots, and learning promotion. The historical import layer should feed those
existing services rather than bypassing them.

## Strategy Search Across Markets

Strategies should be represented as versioned configurations, not ad-hoc code
changes. Each candidate should declare:

- market type, such as moneyline, spread/handicap, totals, or other vendor-
  available markets once normalized;
- entry conditions, including minimum edge, confidence, liquidity, data quality,
  latency, market status, score state, and volatility;
- staking policy, such as fractional Kelly capped by bankroll, flat stake,
  volatility-adjusted stake, or drawdown-adjusted stake;
- exit or cancellation rules for unmatched paper orders;
- abstention rules;
- allowed tours, surfaces, rounds, best-of format, and odds ranges;
- risk limits for daily loss, weekly drawdown, per-match exposure, correlated
  exposure, and maximum open orders.

Candidate examples:

- **Prematch value strategy:** enter only when calibrated model edge is above a
  threshold and closing-line value historically improves after fees.
- **Live momentum fade:** enter against overreaction after breaks of serve only
  when the point model and market prior diverge enough.
- **Server-pressure strategy:** use point-level Markov features around break
  points and tiebreaks, with stricter latency and suspension gates.
- **Market-making/CLV strategy:** optimize for positive CLV in paper mode before
  optimizing for realized ROI.
- **Abstention-first strategy:** dynamically raises thresholds when data quality
  drops, drawdown increases, or market volatility spikes.

## Learning Loop

The learning loop should be champion/challenger based:

1. The **champion** model/strategy is the current paper-trading policy.
2. The optimizer creates **challengers** by changing model parameters, features,
   market filters, thresholds, or staking caps.
3. Challengers run through historical walk-forward tests and shadow paper
   trading on current live data.
4. Promotion requires better risk-adjusted results than champion on multiple
   windows, not just one lucky ROI number.
5. Accepted candidates are written as new model versions and strategy configs;
   rejected candidates keep their metrics and reasons for audit.
6. Production switches are manual/admin-gated and remain paper-first unless a
   separate compliance activation enables real execution.

The loop should optimize a composite score such as:

```text
score = expected_log_bankroll_growth
      + CLV_weight * CLV
      - drawdown_weight * max_drawdown
      - calibration_weight * calibration_error
      - volatility_weight * pnl_volatility
      - data_penalty_weight * low_data_quality_exposure
```

ROI alone is not enough. Positive ROI with bad calibration, negative CLV, high
slippage, or unacceptable drawdown should be rejected.

## Guardrails

- Do not let an LLM place bets directly. LLMs may explain, summarize, and propose
  candidate configs, but deterministic backend gates must make execution
  decisions.
- Keep real execution disabled by default. Historical learning and strategy
  search should write to paper orders and audit tables only.
- Enforce strict train/validation/test splits and walk-forward windows to avoid
  look-ahead bias.
- Include commissions, slippage, latency, suspensions, and unmatched-order risk
  in every simulation.
- Require minimum sample sizes per market, odds bucket, surface, and tour before
  trusting segment metrics.
- Store promotion/rejection reasons so the system learns what failed instead of
  repeatedly testing the same weak idea.

## Implementation Roadmap

1. **Historical import CLI/API:** ingest provider archives or CSV/Parquet files
   into raw payload and canonical event tables.
2. **Dataset registry:** record provider, coverage, date windows, markets,
   checksum, and known gaps for each training/backtest dataset.
3. **Strategy config schema:** version thresholds, markets, staking rules,
   filters, and risk limits independently from model code.
4. **Walk-forward optimizer:** generate challenger configs and evaluate them
   across rolling time windows.
5. **Paper shadow mode:** run promoted challengers beside champion on live data
   without replacing champion until enough live evidence accumulates.
6. **Learning dashboard:** show champion vs challenger ROI, CLV, calibration,
   drawdown, abstention rate, and promotion/rejection reasons.
