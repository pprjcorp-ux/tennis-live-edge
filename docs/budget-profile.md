# Budget Profile

The budget branch is the default public branch and targets useful ATP main-tour
plus men's/women's Grand Slam singles analytics at roughly `$500/mo`.

## Defaults

- `TENNIS_EDGE_RUNTIME_PROFILE=lean_atp`
- `TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men,grand_slam_women`
- `TENNIS_EDGE_MONTHLY_BUDGET_USD=500`
- `SCORE_PRIMARY=api_tennis`
- `ODDS_PRIMARY=odds_api_io_ws`
- `ODDS_ARCHIVE=theoddsapi`
- `ENTERPRISE_FEEDS_ENABLED=false`
- `EXECUTION_ENABLED=false`
- `REAL_EXECUTION_HARD_BLOCK=true`

Live budget mode is paper-first and persistence-first. `Entrada` signals remain
blocked unless Postgres/Timescale is configured through `DATABASE_URL`, schema is
applied, provider cursors are trusted, and the score/odds feeds are fresh.

## Vendor Shape

- API-Tennis Business for fixtures, livescore, H2H, and rankings.
- Odds-API.io Starter + WebSocket for live odds on active/watchlist matches.
- TheOddsAPI Business for archive/comparison.
- Cloudflare Tunnel + Access on free tier plus domain cost.

## API Activation Order

The budget vendor stack is not activated all at once. The dashboard exposes the
current API onboarding state from persisted operational truth:

1. Run `POST /api/v1/replay/contracts/run` with fixture seeds and keep all
   healthy/gap/`resync_required` scenarios passing without paid provider quota.
2. Configure TheOddsAPI first for REST archive/comparison.
3. Configure API-Tennis second for fixtures/livescore.
4. Configure Odds-API.io websocket third, after replay tests prove sequence,
   resync, stale odds, and moneyline completeness gates.
5. Keep enterprise feeds disabled until paper trading proves that the budget
   feeds are the bottleneck.

If a budget provider reaches its persisted `quota_limit`, provider health moves
to `quota exhausted`, live readiness blocks `Entrada`, and the system should
continue in monitor/replay mode rather than forcing signals or breaking the
dashboard.

Sportradar, Betradar UOF, and TXODDS stay documented but disabled until the
model proves value and the budget moves to enterprise.

## Signal Policy

Budget can use the full codebase, but actionable `Entrada` signals are limited
to ATP main-tour plus men's and women's singles at the Australian Open, Roland
Garros/French Open, Wimbledon, and the US Open. WTA normal tour, Challenger,
ITF, doubles, mixed doubles, qualifying, juniors, wheelchair, and exhibitions
should be hidden, monitor-only, or blocked by coverage gates.
