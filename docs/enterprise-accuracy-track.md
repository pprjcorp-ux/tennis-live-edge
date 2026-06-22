# Enterprise Accuracy Track

This track is the no-budget-limit version of Tennis Live Edge. Its single
objective is better calibrated tennis prediction for ATP/WTA singles, especially
Grand Slam match days, without weakening the budget-first safety gates.

It is not a separate runtime fork yet. Build it as a gated extension of the
current operational-truth core: provider contracts, replay fixtures, paper
evaluation, model registry, and dashboard evidence first; live enterprise feeds
only after the budget chain is complete and an operator explicitly activates
contracts.

## Current Truth

- Hermes can orchestrate checks, summarize live windows, route events, and
  produce operator handoffs.
- Hermes must not be the probability engine. Score math, Markov state,
  calibration, edge, risk, and execution gates stay in deterministic backend
  services.
- The repo already covers ATP main tour plus men's and women's Grand Slam
  singles in the budget profile.
- The local core can validate replay contracts and persisted operational truth
  without live provider calls.
- `npm run hermes:enterprise-accuracy-plan` turns the no-budget provider stack,
  access checklist, model layers, and Grand Slam scoreline forecast contract
  into a read-only operator packet.
- Daily live Grand Slam prediction requires healthy score, odds, cursor,
  persistence, and provider-health evidence. Replay-only evidence is useful for
  rehearsal, but it is not proof of live readiness.

## Accuracy Objective

Optimize for calibrated predictive quality and market value:

- Brier score
- log loss
- calibration error by probability bucket
- closing-line value
- ROI and drawdown in paper trading
- abstention quality
- hit rate by odds band

Raw win rate is a secondary metric. A high win rate from short favorites can
still lose money; the system should prefer calibrated edge and abstain when the
data is weak.

## Top-Tier Data Stack

### Official score and point state

Priority 1 is a low-latency, official or enterprise-grade score feed with
point-by-point timeline, server, period scores, interruptions, retirements,
walkovers, and match-status workflow.

Target vendors:

- Sportradar Tennis: official/enterprise score state and point-by-point spine
  across global men's and women's competitions by coverage tier.
- Tennis Data Innovations / ATP data route: official ATP and Challenger rights
  path where commercially available.
- Stats Perform / Opta WTA: official WTA chair data, low-latency deep data, and
  shot-by-shot statistics where licensed.
- LSports Tennis Premium or similar enterprise feed: independent redundancy for
  fixtures, live scores, statistics, settlements, and broad coverage.

### Odds and market microstructure

Priority 2 is price discovery from multiple independent odds routes:

- Betradar UOF: market status, betstop/suspension, settlement, and official
  odds-event state.
- TXODDS: independent in-running odds snapshots and low-latency bookmaker
  comparison.
- Betfair Exchange API/stream: market depth, traded volume, best back/lay,
  liquidity, and closing-line proxy. Real order placement stays hard-blocked in
  this track.
- Odds-API.io WebSocket and TheOddsAPI remain comparison/fallback feeds.

Use `hermes:enterprise-accuracy-plan` before contracting work. It ranks
Sportradar, Tennis Data Innovations, Stats Perform/Opta WTA, TXODDS, Betradar
UOF, exchange market data, premium point-by-point fallback providers and odds
aggregators by the prediction layers they unlock. The same packet includes an
enterprise due-diligence matrix: required fields, proof artifacts, acceptance
tests and the exact evidence Hermes must see before any provider can influence
production features.

### Context and historical base

Priority 3 is model context:

- official rankings, seeds, draw, schedule, surface, indoor/outdoor, altitude,
  best-of format, and tournament round;
- player serve/return strength by surface and opponent quality;
- injury/retirement history and recent match load;
- historical point/game/set/match results;
- odds archive and closing-line snapshots.

Public context can be added as local operator notes only when access is allowed.
Do not scrape restricted sites, automate sportsbook sessions, bypass paywalls, or
extract credentials/cookies.

## Model Direction

### Prematch ensemble

Use an ensemble with explicit feature lineage:

- surface Elo/Glicko;
- opponent-adjusted serve and return strength;
- ranking trend and ranking-point gap;
- recent form adjusted for opponent quality;
- fatigue, travel, rest days, and match duration;
- handedness and matchup patterns;
- tournament level, round, best-of-three/best-of-five;
- bookmaker prior as one input, never as ground truth.

### Live model

Use the backend Markov engine as the deterministic state core:

- point/game/set/match state from current score and server;
- tiebreak and final-set rules by tournament;
- Bayesian update of hold/break probability;
- momentum decay from recent points/games without overfitting;
- injury/retirement hazard and delay handling;
- uncertainty widening when point data is missing or provider latency is high.

### Market model

Add market-microstructure features:

- no-vig fair probability;
- odds movement and volatility;
- stale quote risk;
- suspension/betstop timing;
- exchange liquidity and spread;
- provider disagreement.

Signals require calibrated model probability, fresh score state, complete
moneyline, healthy cursor, non-suspended market, and edge above threshold.

## Enterprise Gating

Enterprise remains locked until all are true:

1. Budget replay contracts pass.
2. TheOddsAPI archive smoke persists raw payloads and odds ticks.
3. API-Tennis score smoke persists score/canonical state.
4. Odds-API.io stream smoke proves healthy cursor and `resync_required=false`.
5. Postgres operational truth survives restart.
6. Paper trading has enough settled evidence for model review.
7. An operator explicitly enables enterprise feed contracts.

Do not set `ENTERPRISE_FEEDS_ENABLED=true` as part of provider research,
documentation, replay fixtures, or parser tests.

## Hermes Role

Hermes should operate as an event-driven supervisor:

- emit `enterprise-accuracy-plan` for no-budget provider/access decisions;
- compile provider RFP questions, sample-payload requirements and proof
  artifacts from the enterprise due-diligence matrix;
- check whether a Grand Slam live window is open;
- summarize provider health and data freshness;
- route anomalies to operator packets;
- trigger replay/backtest reports;
- explain why a signal is allowed, blocked, or monitor-only;
- prepare daily and weekly readiness reports.

Hermes should not:

- run LLM reasoning per score/odds tick;
- submit bets;
- call Betfair directly;
- spend provider quota without an explicit operator command;
- bypass provider, sportsbook, browser, geolocation, anti-bot, or paywall
  controls.

## Implementation Order

1. Keep `budget` green: operational truth, Postgres, replay contracts, dashboard,
   and paper trading.
2. Add enterprise provider contract specs as deferred shadow contracts.
   Implemented as `ENTERPRISE_PROVIDER_CONTRACT_SPECS`; these contracts are
   shadow/deferred and do not run provider calls.
3. Add offline fixture samples for Sportradar timeline, Betradar market state,
   TXODDS odds, and Betfair market stream. Implemented through
   `sample_enterprise_shadow_payloads`; fixtures remain separate from the
   budget replay contract runner.
4. Extend Replay Lab to display enterprise fixture readiness separately from
   budget chain readiness. Implemented through
   `operational_state.replay_lab.enterprise_shadow_providers`, which is
   visibility only and does not activate enterprise feeds.
5. Add model lab reports for accuracy by Grand Slam, gender, surface, round,
   odds bucket, and provider.
6. Only after budget chain completion, activate one enterprise feed at a time in
   paper mode.
7. Keep real execution blocked until a separate compliance and tiny-real task.

## Access Checklist

Human/operator-provided access required:

- Sportradar Tennis production key or sales sandbox.
- Betradar UOF token and market package.
- TXODDS account/API credentials.
- Stats Perform/Opta WTA commercial access if available.
- Betfair Exchange account, KYC, app key, certificates, and stream access for
  market data only.
- Cloudflare Access email allowlist for private remote dashboard access.

Local/free work we can do without those accesses:

- replay fixtures;
- parser tests;
- provider contract matrix;
- model/report scaffolding;
- dashboard readiness panels;
- paper-only backtests;
- Hermes operator packets;
- `hermes:enterprise-accuracy-plan`.
