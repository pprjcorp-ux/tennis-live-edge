# Tennis Live Edge - Agent Handoff

## Project Scope

This project is a private, local-first tennis live edge analytics system for ATP/WTA/Challenger/ITF.

Core goal: ingest live tennis scores and odds, store every tick, estimate fair win probabilities, and recommend only positive-EV signals with abstention and risk controls. The target is risk-adjusted EV/ROI, not forced picks or raw win rate.

This is not financial advice, betting advice, or a promise of profit. Auto-betting must remain disabled until a separate legal/account/API review is completed.

## Working Directory

Use this directory as the project root:

```bash
/Users/ppfahd/Workspace/projects/tennis-live-edge
```

The user home directory is a larger macOS workspace and git root. Keep edits scoped to this project folder. Do not commit or expose machine-specific files such as `.env`, `.logs/`, `.venv/`, `.next/`, `node_modules/`, `.DS_Store`, or secrets.

## Current Architecture

- `services/api`: FastAPI backend.
- `apps/web`: Next.js dashboard.
- `infra/schema.sql`: Postgres/Timescale event-sourced schema.
- `infra/cloudflare`: Cloudflare Tunnel/Access setup docs.
- `scripts/check_private_runtime.py`: private runtime/security smoke check.

Runtime services:

- API: `http://localhost:8000`
- Dashboard: `http://localhost:3000`

Current local servers may be running from detached processes. Logs and pid files are under `.logs/` and ignored by git.

## Current Implemented State

Backend:

- FastAPI v1 endpoints exist:
  - `GET /api/v1/live/matches`
  - `GET /api/v1/matches/{match_id}`
  - `GET /api/v1/signals/live`
  - `GET /api/v1/provider-health`
  - `GET /api/v1/execution/status`
  - `GET /api/v1/bankroll`
  - `GET /api/v1/orders`
  - `POST /api/v1/orders/paper`
  - `POST /api/v1/orders/submit`
  - `POST /api/v1/orders/{order_id}/cancel`
  - `POST /api/v1/execution/kill-switch`
  - `POST /api/v1/models/promote-from-learning`
  - `POST /api/v1/replay/run`
  - `POST /api/v1/backtests/run`
  - `GET /api/v1/backtests/{run_id}`
  - `POST /api/v1/admin/model/promote`
- Replay/backtest/model promotion endpoints require `x-admin-token`.
- `ADMIN_API_TOKEN` is generated in local `.env`; do not print it in chat.
- `EXECUTION_ENABLED=false` must stay false.
- Execution is Betfair-first and deterministic: paper orders work in sample mode; real submission must stay blocked unless `EXECUTION_ENABLED=true`, `EXECUTION_STAGE` is `tiny_real` or `scaled`, Betfair credentials are configured, `BETFAIR_LIVE_KEY_APPROVED=true`, and the kill switch is off.
- No LLM, Cloudflare Agent, OpenClaw agent, browser automation, scraping, or geolocation workaround is allowed to place bets directly. Agents may only explain, review, monitor, or call internal APIs that enforce deterministic gates.
- Sample/replay mode works without paid data.
- Live adapters are scaffolded for API-Tennis, Odds-API.io, Sportradar/TXODDS/Betradar payloads, but full production feed wiring depends on paid credentials/contracts and final provider payload validation.
- This branch is the `enterprise` version: Sportradar is the score primary, TXODDS is the low-latency odds primary, Betradar UOF is the odds archive/market-state feed, and API-Tennis/Odds-API.io/TheOddsAPI remain fallback/archive adapters.
- Provider health now includes cost tier, coverage scope, quota fields, and last billable call metadata.
- Daily cost reporting is available at `GET /api/v1/cost-report/daily`; cost profile is available at `GET /api/v1/cost-profile`.

Frontend:

- Next.js App Router dashboard is running.
- It shows live board, provider health, active signals, match detail, replay/backtest lab.
- It shows enterprise tabs for Data Health, Model Lab, Paper Trading, Entity Resolution, and Risk/Bankroll.
- It shows the `enterprise_roi_clv` cost profile, projected monthly spend, provider cursors, model registry, calibration buckets, paper ROI/CLV, and entity conflicts.
- It shows Betfair execution stage, bankroll, exposure, kill-switch state, order journal, and learning promotion result.
- Fetches include `credentials: "include"` for Cloudflare Access compatibility.
- Replay/backtest lab asks for the local admin token.
- shadcn/Tailwind v4 was initialized in `apps/web`:
  - `apps/web/components.json`
  - `apps/web/lib/utils.ts`
  - `apps/web/postcss.config.mjs`
  - Tailwind/shadcn dependencies in `apps/web/package.json`
- No shadcn UI components have been installed yet. Next step for UI cleanup is to run `npx shadcn@latest add ...` from `apps/web` and refactor the dashboard to use Card/Button/Badge/Alert/Input/Field/etc.

## Commands

Run from project root unless noted:

```bash
npm run api:test
npm --prefix apps/web run build
python3 scripts/check_private_runtime.py
```

Start development services:

```bash
npm run api:dev
npm run web:dev
```

If both should run together:

```bash
npm run dev
```

For shadcn work, run commands from `apps/web`:

```bash
cd /Users/ppfahd/Workspace/projects/tennis-live-edge/apps/web
npx shadcn@latest info --json
npx shadcn@latest docs button card badge alert input field separator skeleton scroll-area table
npx shadcn@latest add button card badge alert input field separator skeleton scroll-area table
```

Follow shadcn rules: use components before custom markup, full Card composition, Badge for status, Alert for callouts, Field for forms, Button variants, `data-icon` on icons inside buttons, semantic Tailwind tokens, and `gap-*` instead of `space-*`.

## Required APIs / Accounts

Minimum paid stack for the system to be fully live:

1. Sportradar Tennis API
   - Needed for live scores, schedules, match state, timeline/play-by-play, retirements, delays.
   - Env: `SPORTRADAR_API_KEY`, `SPORTRADAR_ACCESS_LEVEL=production`
   - Docs: `https://developer.sportradar.com/tennis/docs`

2. Betradar UOF / Sportradar Odds
   - Needed for market state, odds changes, suspensions, event status.
   - Env: `BETRADAR_UOF_TOKEN`
   - Docs: `https://docs.sportradar.com/uof/introduction/overview`

3. TXODDS In-Running Tennis
   - Needed as a low-latency independent odds feed and stale/sharp-line comparator.
   - Env: `TXODDS_USER`, `TXODDS_PASSWORD`
   - Docs: `https://txodds.com/static/docs/TXODDS_TXAPI_In_Running_Tennis_User_Guide.pdf`

4. Odds-API.io or OpticOdds
   - Needed as fallback/comparison odds feed and historical odds source.
   - Env if Odds-API.io: `ODDS_API_IO_KEY`
   - Odds-API.io docs: `https://docs.odds-api.io/api-reference/introduction`
   - OpticOdds docs: `https://developer.opticodds.com/docs/odds-api-getting-started-guide`

5. API-Tennis
   - Cheap fallback for fixtures, livescore, rankings, H2H.
   - Env: `API_TENNIS_KEY`
   - Docs: `https://api-tennis.com/documentation`

6. Cloudflare
   - Needed for private domain to local Mac through Tunnel + Access.
   - Env: `CLOUDFLARE_TUNNEL_TOKEN`, `PRIVATE_ALLOWED_EMAILS`
   - Docs: `https://developers.cloudflare.com/tunnel/`

Optional but valuable:

- Historical odds package from Odds-API.io, OpticOdds, TXODDS, or another licensed provider.
- Jeff Sackmann historical tennis data for model baseline/backtesting.

## Environment

Local `.env` should contain:

```bash
API_TENNIS_KEY=
ODDS_API_IO_KEY=
SPORTRADAR_API_KEY=
SPORTRADAR_ACCESS_LEVEL=production
BETRADAR_UOF_TOKEN=
TXODDS_USER=
TXODDS_PASSWORD=
CLOUDFLARE_TUNNEL_TOKEN=
PRIVATE_ALLOWED_EMAILS=you@email.com
ADMIN_API_TOKEN=<random-hex-secret>
EXECUTION_ENABLED=false
EXECUTION_VENUE=betfair
EXECUTION_STAGE=paper
REAL_EXECUTION_HARD_BLOCK=true
MODEL_CHAMPION_VERSION=baseline_v0
MIN_PAPER_SIGNALS_FOR_REAL_REVIEW=500
MIN_PAPER_DAYS_FOR_REAL_REVIEW=60
ODDS_WS_RESYNC_REQUIRED_BLOCKS_SIGNALS=true
MODEL_PROMOTION_REQUIRE_CLV=true
BETFAIR_APP_KEY=
BETFAIR_USERNAME=
BETFAIR_CERT_PATH=
BETFAIR_KEY_PATH=
BETFAIR_PASSWORD_SECRET_REF=
BETFAIR_LIVE_KEY_APPROVED=false
BANKROLL_BASE_CURRENCY=USD
BANKROLL_STARTING_BALANCE=10000
MAX_ORDER_STAKE_FRACTION=0.015
MAX_OPEN_EXPOSURE_FRACTION=0.03
DAILY_LOSS_LIMIT_FRACTION=0.005
WEEKLY_DRAWDOWN_LIMIT_FRACTION=0.015
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
TENNIS_EDGE_CORS_ORIGIN=http://localhost:3000,https://edge.example.com
DATABASE_URL=postgresql://tennis:tennis@localhost:5432/tennis_edge
REDIS_URL=redis://localhost:6379/0
NATS_URL=nats://localhost:4222
TENNIS_EDGE_RUNTIME_PROFILE=enterprise_roi_clv
TENNIS_EDGE_DATA_MODE=sample
```

When paid credentials are ready and payloads are validated, switch to:

```bash
TENNIS_EDGE_DATA_MODE=live
```

Do not expose `.env` or secrets to the browser bundle. Only `NEXT_PUBLIC_*` can be client-visible.

## What The User Asked To Do Next

When the user returns, likely next requests:

1. Provide paid provider credentials/API contracts.
2. Replace sample/replay mode with real live ingestion for Sportradar, TXODDS, and Betradar UOF first.
3. Keep API-Tennis, Odds-API.io, and TheOddsAPI as fallback/archive feeds for validation and redundancy.
4. Configure Cloudflare domain:
   - `edge.<domain>` -> local dashboard at `localhost:3000`
   - `api.edge.<domain>` -> local API at `localhost:8000`
   - both protected by Cloudflare Access email allowlist.
5. Upgrade dashboard UI using shadcn components.
6. Add real persistence services:
   - Postgres/TimescaleDB
   - Redis
   - NATS JetStream
7. Add historical replay/backtest ingestion and model promotion gates using real historical data.
8. Wire the live Betfair connector only after legal/KYC/live app key checks are complete; until then keep sample/paper execution as the only active path.

## Verification Checklist Before Saying Done

Always run:

```bash
npm run api:test
npm --prefix apps/web run build
python3 scripts/check_private_runtime.py
```

For local smoke:

```bash
curl -fsS http://localhost:8000/health
curl -fsS http://localhost:8000/api/v1/live/matches
curl -fsS http://localhost:8000/api/v1/provider-health
```

For admin smoke, read `ADMIN_API_TOKEN` from `.env` locally and do not print it:

```bash
set -a; . ./.env; set +a
curl -fsS -X POST http://localhost:8000/api/v1/replay/run \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_API_TOKEN" \
  -d '{"match_id":"match_atp_002"}'
```

Also confirm unauthenticated operational endpoints reject with `401`.

## Important Constraints

- Do not enable automatic betting in this project by default.
- Do not present sample-mode predictions as real live predictions.
- Do not claim profit or guaranteed accuracy.
- Do not allow stale odds, missing score state, suspended markets, or weak ITF/Challenger data quality to generate unrestricted entries.
- Any production signal must include model probability, no-vig market probability, edge, threshold, confidence, stake cap, and reason.
- Challenger/ITF should have stricter confidence/data-quality gates than ATP/WTA main tour.
