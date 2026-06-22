# API Access Purchasing Guide

Use this guide to buy and hand off provider access without exposing secrets in
GitHub, chat, PRs or documentation. The repository is public; credentials belong
only in the local `.env` or a local secret manager.

## Buy First

### 1. API-Tennis

- Buy/start here: [API-Tennis](https://api-tennis.com/)
- Docs: [API-Tennis documentation](https://api-tennis.com/documentation)
- Purpose: fixtures, live scores, rankings, H2H, player/team metadata and
  budget score freshness.
- Recommended first plan: Business if the project needs sustained live testing.
- Env:
  - `API_TENNIS_KEY`
  - `SCORE_PRIMARY=api_tennis`

Activation smoke:

```bash
npm run api:ingest:api-tennis -- --pretty
```

### 2. Odds-API.io

- Buy/start here: [Odds-API.io](https://odds-api.io/)
- WebSocket docs: [Odds-API.io WebSocket real-time feed](https://docs.odds-api.io/guides/websockets)
- Purpose: live odds feed with sequence/cursor handling for moneyline first.
- Required for serious live mode: paid REST plan plus WebSocket access.
- Env:
  - `ODDS_API_IO_KEY`
  - `ODDS_PRIMARY=odds_api_io_ws`

Activation smoke:

```bash
npm run api:ingest:odds-stream -- --max-messages 1 --timeout-seconds 5 --pretty
```

### 3. The Odds API

- Buy/start here: [The Odds API](https://the-odds-api.com/)
- Docs: [The Odds API v4 docs](https://the-odds-api.com/liveapi/guides/v4/)
- Historical odds: [Historical odds data](https://the-odds-api.com/historical-odds-data/)
- Purpose: historical/archive odds snapshots, comparison source, backtest
  foundation and closing-line proxy.
- Env:
  - `THE_ODDS_API_KEY`
  - `ODDS_ARCHIVE=theoddsapi`

Activation smoke:

```bash
npm run api:ingest:archive-odds -- --pretty
```

## Low-Cost Or Free Infrastructure

### Cloudflare Tunnel + Access

- Tunnel docs: [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/)
- Private app docs: [Cloudflare One Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- Pricing: [Cloudflare Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/)
- Purpose: expose the local dashboard privately at `https://edge.<domain>`
  behind Cloudflare Access.
- Env:
  - `CLOUDFLARE_TUNNEL_TOKEN`
  - `PRIVATE_ALLOWED_EMAILS`
  - `TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS`

### Domain

- Use Cloudflare Registrar or point an existing DNS zone to Cloudflare.
- Suggested hostname: `edge.<your-domain>`.
- Do not expose backend ports publicly without Cloudflare Access.

### OpenAI / Hermes Agent Ops

- API keys: [OpenAI API keys](https://platform.openai.com/api-keys)
- Purpose: summaries, anomaly review, weekly readiness reports and operator
  handoffs. Deterministic tennis math stays in Python services.
- Env:
  - `HERMES_TRIAGE_MODEL`
  - `HERMES_CRITICAL_MODEL`
  - local OpenAI key in the user-level runtime, not in this repo.

## Deferred Until Paper Evidence Exists

### Betfair Exchange API

- Getting started: [Betfair Developer Program](https://support.developer.betfair.com/hc/en-us/articles/115003864651-How-do-I-get-started)
- Live key activation: [Activate Live App Key](https://support.developer.betfair.com/hc/en-us/articles/115003860331-How-do-I-activate-my-Live-App-Key)
- Purpose now: market data mapping and paper execution realism.
- Purpose later: official exchange execution only after a separate compliance
  activation task.
- Env:
  - `BETFAIR_APP_KEY`
  - `BETFAIR_USERNAME`
  - `BETFAIR_CERT_PATH`
  - `BETFAIR_KEY_PATH`
  - `BETFAIR_PASSWORD_SECRET_REF`
  - `BETFAIR_LIVE_KEY_APPROVED=false`

Hard rule: leave `REAL_EXECUTION_HARD_BLOCK=true`.

### Sportradar Tennis

- Docs: [Sportradar Tennis API basics](https://developer.sportradar.com/tennis/docs/ig-api-basics)
- Marketplace: [Sportradar Tennis API](https://marketplace.sportradar.com/products/6501e20f236aba44b550bdae)
- Purpose: enterprise official score/timeline/coverage.
- Env:
  - `SPORTRADAR_API_KEY`
  - `SPORTRADAR_ACCESS_LEVEL`

### Betradar UOF

- Docs: [Unified Odds Feed](https://docs.sportradar.com/uof)
- Product overview: [Betradar UOF](https://betradar.com/sportsbook-support/unified-odds-feed/)
- Purpose: enterprise market status, betstop/suspensions, settlement and odds
  event state.
- Env:
  - `BETRADAR_UOF_TOKEN`

### TXODDS

- Developer hub: [TXODDS Developer Hub](https://txodds.net/developer-hub/)
- Product site: [TXODDS](https://txodds.net/)
- Contact: [TXODDS contact](https://txodds.net/contact-txodds/)
- Purpose: enterprise in-running odds, market snapshots and historical odds
  archive.
- Env:
  - `TXODDS_USER`
  - `TXODDS_PASSWORD`

## What To Send The Developer

Do send:

- The repository link: `https://github.com/pprjcorp-ux/tennis-live-edge`
- Which branch to use: `budget` for low-cost live build, `enterprise` for
  no-budget architecture.
- This guide and [Developer onboarding](developer-onboarding.md).
- Provider account status: purchased, trial, pending sales, or not started.

Do not send:

- API keys in chat.
- `.env`.
- Betfair password.
- Certificates or private keys.
- Provider payload exports if the license does not allow sharing.

## Activation Checklist

1. Clone repo and run replay/sample validation.
2. Fill only the purchased provider variables in local `.env`.
3. Run one provider smoke at a time.
4. Confirm raw payloads, normalized ticks, provider latency and cursors persist.
5. Confirm dashboard shows provider health and cost/quota state.
6. Confirm no signal becomes `Entrada` unless all risk gates pass.
7. Keep real execution blocked.
