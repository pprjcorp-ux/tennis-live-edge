# Budget Profile

The budget branch is the default public branch and targets useful ATP-focused
analytics at roughly `$500/mo`.

## Defaults

- `TENNIS_EDGE_RUNTIME_PROFILE=lean_atp`
- `TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men`
- `TENNIS_EDGE_MONTHLY_BUDGET_USD=500`
- `SCORE_PRIMARY=api_tennis`
- `ODDS_PRIMARY=odds_api_io_ws`
- `ODDS_ARCHIVE=theoddsapi`
- `ENTERPRISE_FEEDS_ENABLED=false`
- `EXECUTION_ENABLED=false`
- `REAL_EXECUTION_HARD_BLOCK=true`

## Vendor Shape

- API-Tennis Business for fixtures, livescore, H2H, and rankings.
- Odds-API.io Starter + WebSocket for live odds on active/watchlist matches.
- TheOddsAPI Business for archive/comparison.
- Cloudflare Tunnel + Access on free tier plus domain cost.

Sportradar, Betradar UOF, and TXODDS stay documented but disabled until the
model proves value and the budget moves to enterprise.

## Signal Policy

Budget can use the full codebase, but actionable `Entrada` signals are limited
to ATP main-tour and men's Grand Slam singles. Challenger, ITF, WTA, doubles,
juniors, and exhibitions should be hidden, monitor-only, or blocked by coverage
gates.
