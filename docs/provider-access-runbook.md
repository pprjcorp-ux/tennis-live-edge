# Provider Access Runbook

This runbook turns the remaining account work into a checklist. It keeps real
execution blocked until a separate compliance activation task explicitly changes
`REAL_EXECUTION_HARD_BLOCK`.

## Current Local State

- GitHub is connected and the repo is public with `budget` as default.
- `.env` is local-only and ignored by Git.
- TheOddsAPI is configured locally.
- Betfair certificate and key were generated locally:
  - `BETFAIR_CERT_PATH=/Users/ppfahd/Workspace/projects/tennis-live-edge/.secrets/betfair/client-2048.crt`
  - `BETFAIR_KEY_PATH=/Users/ppfahd/Workspace/projects/tennis-live-edge/.secrets/betfair/client-2048.key`
- Real execution stays blocked:
  - `EXECUTION_ENABLED=false`
  - `EXECUTION_STAGE=paper`
  - `REAL_EXECUTION_HARD_BLOCK=true`

## Betfair Exchange Delivery

Official links:

- Betfair API getting started: https://support.developer.betfair.com/hc/en-us/articles/115003864651-How-do-I-get-started
- Betfair login methods: https://support.developer.betfair.com/hc/en-us/articles/115003899492-How-do-I-login-to-the-API
- Non-interactive certificate login: https://betfair-developer-docs.atlassian.net/wiki/spaces/1smk3cen4v3lu3yomq5qye0ni/pages/2687915
- `placeOrders` reference: https://betfair-developer-docs.atlassian.net/wiki/spaces/1smk3cen4v3lu3yomq5qye0ni/pages/2687496/placeOrders

### What The User Must Do

1. Create or confirm a Betfair Exchange account in a jurisdiction where API use
   is legally available.
2. Complete Betfair KYC/verification.
3. Log in to Betfair and create developer app keys using the Accounts API Demo
   Tool.
4. Save the delayed app key first. Do not request live trading until paper mode
   and delayed-key tests are passing.
5. Upload `.secrets/betfair/client-2048.crt` to the Betfair account certificate
   area for non-interactive login.
6. After delayed-key testing, apply for a live app key only if legal/account
   checks pass. Betfair documents a one-off live activation fee of GBP 499.
7. Provide the local values below through `.env` only, not through chat:
   - `BETFAIR_APP_KEY`
   - `BETFAIR_USERNAME`
   - `BETFAIR_PASSWORD_SECRET_REF`
   - `BETFAIR_LIVE_KEY_APPROVED=false` until Betfair approves a live key

### What Codex Can Do After That

1. Test certificate login against Betfair with the official cert endpoint.
2. Verify market catalogue and tennis market mapping.
3. Keep order submission hard-blocked while running paper/delayed validation.
4. Produce a readiness report after at least `MIN_PAPER_SIGNALS_FOR_REAL_REVIEW`
   or `MIN_PAPER_DAYS_FOR_REAL_REVIEW`.
5. Only in a separate activation task, consider moving from paper to tiny-real.

## Sportradar Tennis

Official links:

- Sportradar Tennis docs: https://developer.sportradar.com/tennis/docs
- Tennis API basics: https://developer.sportradar.com/tennis/docs/ig-api-basics

Ask sales for:

- Tennis API access covering ATP/WTA/Grand Slam singles.
- Timeline/point-by-point/live-state where available.
- Delay, retirement, walkover and suspension metadata.
- Historical access for backtesting, if available.
- Rate limits, latency expectations, commercial restrictions, and data retention
  terms.

Env to fill after contract:

- `SPORTRADAR_API_KEY`
- `SPORTRADAR_ACCESS_LEVEL=production` or `trial`

## Betradar UOF

Official links:

- UOF docs: https://docs.sportradar.com/uof
- UOF API overview: https://docs.sportradar.com/uof/api-and-structure
- Preparation to launch: https://docs.sportradar.com/uof/introduction/integration-process/preparation-to-launch

Ask sales/technical onboarding for:

- UOF package with tennis pre-match and live markets.
- Access token for API and AMQP feed.
- Replay server availability for historical validation.
- Market suspension/betstop and settlement data.
- IP allowlisting requirements and environment endpoints.

Env to fill after contract:

- `BETRADAR_UOF_TOKEN`

## TXODDS

Ask TXODDS for:

- In-running tennis coverage for ATP/WTA/Grand Slam singles.
- Bookmaker coverage list and whether Betfair Exchange prices are included.
- WebSocket or low-latency streaming access.
- Historical tick archive and replay permission.
- Per-market latency timestamps and suspension/availability metadata.

Env to fill after contract:

- `TXODDS_USER`
- `TXODDS_PASSWORD`

## Enterprise Outreach Email

Subject: Tennis live data and odds feed evaluation for private quantitative system

Hello,

I am building a private, local-first tennis analytics system for ATP/WTA singles
focused on ROI/CLV measurement, paper trading, and controlled model validation.
I am evaluating enterprise feeds for score/live-state, point timeline, market
state, suspensions, settlement and in-running odds.

Requirements:

- Coverage: ATP, WTA, and Grand Slam singles, with optional Challenger/ITF later.
- Live score state: set/game/point, server, tiebreaks, retirements, delays,
  walkovers and source timestamps.
- Odds: moneyline first, then handicaps/totals, with bookmaker/source timestamps,
  market suspension status and replay or historical archive access.
- Integration: API/WebSocket/AMQP access suitable for a local private backend.
- Compliance: no public redistribution; private analytical use only.

Please send pricing, trial/sandbox availability, rate limits, latency SLAs,
sample payloads, retention terms, and onboarding requirements.

Best,
Pedro

## Activation Order

1. Finish the API-last core first: Postgres/Timescale persistence, replay fake
   APIs, signal gates, paper settlement, and Model Lab `training_examples`.
2. Add TheOddsAPI first because it is REST/archive/comparison and cannot by
   itself create live entries. After setting `THE_ODDS_API_KEY`, run protected
   `POST /api/v1/ingestion/the-odds-api/archive-sync` and verify it records an
   `archive_odds_sync` ingestion run with raw payload and `odds/archive`
   latency evidence.
3. Add API-Tennis second for fixtures/livescore and score freshness. After
   setting `API_TENNIS_KEY`, run protected
   `POST /api/v1/ingestion/api-tennis/score-sync` and verify it records an
   `api_tennis_score_sync` summary with fixture/score payload counts.
4. Add Odds-API.io websocket third, only after replay/resync tests prove
   `seq`/`lastSeq`, gaps, stale odds and incomplete moneyline gates. Start with
   protected `POST /api/v1/ingestion/odds-api-io/stream-smoke` using
   `max_messages=1` and a short timeout; if the persisted cursor says
   `resync_required`, reconcile by REST/snapshot and then use the cursor resync
   endpoint.
5. Keep Betfair in delayed/paper validation until model performance is proven.
6. Defer Sportradar/Betradar/TXODDS until paper trading shows positive CLV/ROI
   or the current feeds become the bottleneck.
7. Never disable `REAL_EXECUTION_HARD_BLOCK` in this onboarding task.
